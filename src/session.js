import {
  loadProfile,
  saveProfile,
  formatSummary,
  emptyProfile,
  defaultProfilePath,
  applyDraftToLive,
  draftDiffersFromLive,
  hasEnoughForFirstBot,
  customerOpeningText,
} from './profile.js';
import {
  applyReviewGate,
  OFF_PURPOSE_OWNER_REPLY,
  runBuilderTurn as defaultRunBuilderTurn,
  openingMessage,
} from './builder.js';
import {
  businessBotReply as defaultBusinessBotReply,
  BUSINESS_BOT_STORED_MESSAGES,
} from './businessBot.js';
import {
  isMenuRequest,
  menuActive,
  parseMenuChoice,
  parseMenuItem,
  renderMenu,
  interveningBuilderQuestion,
  isReviewNumberChoice,
  parseReviewChoice,
  lastShownNav,
  renderChangeMenu,
  renderReturnToEditing,
  renderReview,
  renderSavedChanges,
  renderSection,
  reviewActive,
  renderSetupContinue,
} from './ownerNav.js';
import {
  LEAD_ALREADY_SENT,
  leadInProgress,
  leadResumePending,
  leadSubmitted,
  startLeadIntake,
  stepLeadIntake,
} from './leadIntake.js';

function deps(session) {
  return session.deps || {};
}

function runBuilderTurnFn(session) {
  return deps(session).runBuilderTurn || defaultRunBuilderTurn;
}

function businessBotReplyFn(session) {
  return deps(session).businessBotReply || defaultBusinessBotReply;
}

/**
 * In-memory session. Profile persists on disk at session.profilePath
 * (default: data/business-profile.json) unless session.store + senderId set.
 *
 * @param {string|{ profilePath?: string, deps?: object }|null} [profilePathOrOpts]
 */
export function createSession(profilePathOrOpts) {
  const opts =
    profilePathOrOpts != null &&
    typeof profilePathOrOpts === 'object' &&
    !Array.isArray(profilePathOrOpts)
      ? profilePathOrOpts
      : { profilePath: profilePathOrOpts };
  return {
    mode: 'BUILD', // BUILD | TEST
    buildHistory: [],
    testHistory: [],
    testSessionId: `test-${Date.now()}`,
    profilePath: opts.profilePath || defaultProfilePath(),
    leadIntake: null,
    store: null,
    senderId: null,
    deps: opts.deps || null,
  };
}

/**
 * Load WhatsApp / store-backed session for one sender (isolated).
 */
export async function createSenderSession(store, senderId, options = {}) {
  const saved = await store.loadSession(senderId);
  return {
    mode: saved.mode || 'BUILD',
    buildHistory: saved.buildHistory || [],
    testHistory: saved.testHistory || [],
    testSessionId: saved.testSessionId || `test-${Date.now()}`,
    leadIntake: saved.leadIntake || null,
    profilePath: null,
    store,
    senderId,
    deps: options.deps || null,
  };
}

export async function persistSenderSession(session) {
  if (!session.store || !session.senderId) return;
  await session.store.saveSession(session.senderId, session);
}

function load(session) {
  if (session.store && session.senderId) {
    throw new Error('Use loadAsync for store-backed sessions');
  }
  return loadProfile(session.profilePath);
}

async function loadAsync(session) {
  if (session.store && session.senderId) {
    return session.store.loadProfile(session.senderId);
  }
  return loadProfile(session.profilePath);
}

async function saveAsync(session, profile) {
  if (session.store && session.senderId) {
    return session.store.saveProfile(session.senderId, profile);
  }
  return saveProfile(profile, session.profilePath);
}

export function getState(session) {
  // Sync path for file-backed UI / e2e
  if (session.store && session.senderId) {
    return {
      mode: session.mode,
      profile: {},
      summary: '',
      approvedAt: null,
      buildHistory: session.buildHistory,
      testHistory: session.testHistory,
      async: true,
    };
  }
  const profile = load(session);
  return stateFrom(session, profile);
}

async function getStateAsync(session) {
  const profile = await loadAsync(session);
  return stateFrom(session, profile);
}

function stateFrom(session, profile) {
  return {
    mode: session.mode,
    profile: {
      ...profile,
    },
    summary: formatSummary(profile),
    approvedAt: profile.approvedAt,
    buildHistory: session.buildHistory,
    testHistory: session.testHistory,
  };
}

const BOT_ERROR_REPLY =
  "Sorry, your bot couldn't answer right now. Please try again in a moment.";

export const ENTER_TEST_REPLY =
  "You're now chatting with me as a customer. Type *stop* when you want to keep teaching me.";

/** One pair of surrounding WhatsApp bold asterisks, if present. */
function unwrapWhatsAppBold(text) {
  const t = String(text || '').trim();
  const m = /^\*([^*]+)\*$/.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * Exit TEST (and cancel lead): the whole message is `stop`, trimmed,
 * case-insensitive, optionally wrapped in WhatsApp `*bold*`. `/end` is a
 * silent alias. "stop" inside a longer sentence is not the command.
 */
export function isExitTestCommand(text) {
  const inner = unwrapWhatsAppBold(text).toLowerCase();
  return inner === 'stop' || inner === '/end';
}

/**
 * @param {ReturnType<typeof createSession>} session
 * @param {string} text
 */
export async function handleMessage(session, text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty message', ...(await getStateAsync(session)) };
  }

  // Commands handled in app code — never by the LLM
  const exitTest = isExitTestCommand(trimmed);
  if (trimmed === '/test' || trimmed === '/reset' || exitTest) {
    cancelLeadIntake(session);
    clearLeadResume(session);
  }
  if (trimmed === '/test') {
    return enterTest(session);
  }
  if (exitTest) {
    return enterBuild(session);
  }
  if (trimmed === '/reset') {
    await saveAsync(session, emptyProfile());
    session.buildHistory = [];
    session.testHistory = [];
    session.mode = 'BUILD';
    session.testSessionId = `test-${Date.now()}`;
    return {
      ok: true,
      reply: "All cleared. Send any message and I'll start fresh.",
      source: 'app',
      event: 'reset',
      ...(await getStateAsync(session)),
    };
  }

  if (session.mode === 'TEST') {
    return handleTest(session, trimmed);
  }

  // First inbound in BUILD only wakes the bot — discard content, send opening.
  if (session.buildHistory.length === 0) {
    const open = openingMessage();
    session.buildHistory.push({ role: 'assistant', content: open.message });
    return {
      ok: true,
      reply: open.message,
      source: open.source,
      event: 'opening',
      ...(await getStateAsync(session)),
    };
  }

  if (leadInProgress(session.leadIntake)) return handleLeadIntake(session, trimmed);
  if (leadResumePending(session.leadIntake)) return resumeOwnerMenu(session, trimmed);

  const nav = await handleNavigation(session, trimmed);
  if (nav) return nav;
  return handleBuild(session, trimmed);
}

/**
 * Editing-menu navigation (BUILD only). Menu words require `approvedAt`.
 * A save card offers 1 "Chat with me like a customer" (TEST) and 2
 * "Keep teaching me" (full editing menu). Those stay active while the last shown
 * nav is still the card, except a bare number after an intervening Builder
 * question (`asksQuestion` on that turn, no nav) is an answer to that question.
 * Section items are read-only. Until a lead is submitted, item 1 is
 * "Get this bot for my business" and the rest shift down by one.
 * Completing the questionnaire does not append a menu; the next BUILD
 * message shows the current menu (without the lead item).
 * @returns {Promise<object|null>} null → not navigation, continue to the Builder
 */
async function handleNavigation(session, text) {
  if (reviewActive(session.buildHistory)) {
    const pick = parseReviewChoice(text);
    const numberAnswersQuestion =
      isReviewNumberChoice(text) && interveningBuilderQuestion(session.buildHistory);
    if (pick && !numberAnswersQuestion) {
      if (pick === 'try') return tryMyBot(session, text);
      if (pick === 'change') {
        const reply = renderChangeMenu(leadMenuOpts(session, await loadAsync(session)));
        session.buildHistory.push({ role: 'user', content: text });
        session.buildHistory.push({ role: 'assistant', content: reply, nav: 'menu' });
        return {
          ok: true,
          reply,
          source: 'app',
          event: 'menu',
          ...(await getStateAsync(session)),
        };
      }
    }
  }

  const wantsMenu = isMenuRequest(text);
  const numbered = menuActive(session.buildHistory) && parseMenuChoice(text, 9) != null;
  // Label on the last menu item — not a bare 1/2, which still means those menu numbers.
  const tryWords =
    menuActive(session.buildHistory) &&
    parseReviewChoice(text) === 'try' &&
    !isReviewNumberChoice(text);
  if (!wantsMenu && !numbered && !tryWords) return null;
  const profile = await loadAsync(session);
  // Same visibility rule as every rendered menu, so numbers match what was shown.
  const choice = numbered ? parseMenuItem(text, leadMenuOpts(session, profile)) : null;
  if (!wantsMenu && choice == null && !tryWords) return null;

  // Menu words only after the bot is ready; numbers work from a save card too.
  if (wantsMenu && !profile.approvedAt) return null;
  if (!profile.approvedAt && choice == null && !tryWords) return null;

  if (choice === 'lead') return beginLeadIntake(session);
  if (tryWords || choice === 'try') return tryMyBot(session);

  const reply = wantsMenu
    ? renderMenu(leadMenuOpts(session, profile))
    : renderSection(choice, profile);
  session.buildHistory.push({ role: 'user', content: text });
  session.buildHistory.push({
    role: 'assistant',
    content: reply,
    nav: wantsMenu ? 'menu' : `section:${choice}`,
  });
  return {
    ok: true,
    reply,
    source: 'app',
    event: wantsMenu ? 'menu' : 'menu_section',
    ...(await getStateAsync(session)),
  };
}

/** "Chat with me like a customer": enter TEST when the profile has enough to answer. */
async function tryMyBot(session) {
  return enterTest(session);
}

async function enterTest(session) {
  const profile = await loadAsync(session);
  if (!hasEnoughForFirstBot(profile)) {
    const reply =
      'Tell me your business name and what you do (or a service) before I can chat as your assistant.';
    return {
      ok: false,
      reply,
      source: 'app',
      ...(await getStateAsync(session)),
    };
  }
  session.mode = 'TEST';
  const opening = customerOpeningText(profile);
  session.testHistory = [{ role: 'assistant', content: opening }];
  session.testSessionId = `test-${Date.now()}`;
  const reply = `${ENTER_TEST_REPLY}\n\n${opening}`;
  return {
    ok: true,
    reply,
    source: 'app',
    event: 'enter_test',
    ...(await getStateAsync(session)),
  };
}

async function enterBuild(session) {
  session.mode = 'BUILD';
  const profile = await loadAsync(session);
  if (profile.approvedAt) {
    const reply = renderReturnToEditing(leadMenuOpts(session, profile));
    session.buildHistory.push({ role: 'assistant', content: reply, nav: 'menu' });
    return {
      ok: true,
      reply,
      source: 'app',
      event: 'enter_build',
      ...(await getStateAsync(session)),
    };
  }
  const reply = renderSetupContinue();
  return {
    ok: true,
    reply,
    source: 'app',
    event: 'enter_build',
    ...(await getStateAsync(session)),
  };
}

function leadMenuOpts(session, profile) {
  return { leadOption: !!profile?.approvedAt && !leadSubmitted(session.leadIntake) };
}

/** Drop an unfinished questionnaire (nothing saved); a submitted marker stays. */
function cancelLeadIntake(session) {
  if (leadInProgress(session.leadIntake)) session.leadIntake = null;
}

/** Commands already show their own UI; do not consume the next BUILD turn. */
function clearLeadResume(session) {
  if (!leadResumePending(session.leadIntake)) return;
  session.leadIntake = { submittedAt: session.leadIntake.submittedAt };
}

/** First BUILD message after a saved lead: show the current owner menu. */
async function resumeOwnerMenu(session, text) {
  session.leadIntake = { submittedAt: session.leadIntake.submittedAt };
  const profile = await loadAsync(session);
  const reply = renderMenu(leadMenuOpts(session, profile));
  session.buildHistory.push({ role: 'user', content: text });
  session.buildHistory.push({ role: 'assistant', content: reply, nav: 'menu' });
  return {
    ok: true,
    reply,
    source: 'app',
    event: 'menu',
    ...(await getStateAsync(session)),
  };
}

/** Lead questionnaire turns never touch buildHistory, the profile, or the draft. */
async function leadReply(session, reply, event) {
  return { ok: true, reply, source: 'app', event, ...(await getStateAsync(session)) };
}

async function beginLeadIntake(session) {
  if (leadSubmitted(session.leadIntake)) {
    const profile = await loadAsync(session);
    const menu = renderMenu(leadMenuOpts(session, profile));
    return leadReply(session, `${LEAD_ALREADY_SENT}\n\n${menu}`, 'lead_already_sent');
  }
  const { state, reply } = startLeadIntake();
  session.leadIntake = state;
  return leadReply(session, reply, 'lead_question');
}

async function handleLeadIntake(session, text) {
  if (isMenuRequest(text)) {
    cancelLeadIntake(session);
    const profile = await loadAsync(session);
    return leadReply(session, renderMenu(leadMenuOpts(session, profile)), 'lead_cancelled');
  }
  const step = stepLeadIntake(session.leadIntake, text);
  if (!step.done) {
    session.leadIntake = step.state;
    return leadReply(session, step.reply, 'lead_question');
  }
  const profile = await loadAsync(session);
  const lead = {
    senderId: session.senderId,
    businessName: profile.name || profile.draft?.name || null,
    answers: step.state.answers,
    createdAt: new Date().toISOString(),
  };
  if (session.store && session.senderId) {
    await session.store.saveLead(session.senderId, lead);
  } else {
    session.lead = lead;
  }
  session.leadIntake = { submittedAt: lead.createdAt, resumeMenu: true };
  return leadReply(session, step.reply, 'lead_saved');
}

async function handleTest(session, question) {
  const profile = await loadAsync(session);
  // TEST must never modify business facts
  const before = JSON.stringify({
    name: profile.name,
    services: profile.services,
    hours: profile.hours,
  });

  let reply;
  let source = 'real-llm';
  try {
    reply = await businessBotReplyFn(session)({
      profile,
      history: session.testHistory,
      question,
    });
    session.testHistory.push({ role: 'user', content: question });
    session.testHistory.push({ role: 'assistant', content: reply });
    session.testHistory = session.testHistory.slice(-BUSINESS_BOT_STORED_MESSAGES);
  } catch (err) {
    // Provider error text can echo a masked API key; keep it out of chat and logs.
    console.error('Business Bot reply failed:', err?.status || err?.code || err?.name || 'error');
    reply = BOT_ERROR_REPLY;
    source = 'error';
  }

  const afterProfile = await loadAsync(session);
  const after = JSON.stringify({
    name: afterProfile.name,
    services: afterProfile.services,
    hours: afterProfile.hours,
  });
  if (before !== after) {
    // Should be impossible — restore if somehow mutated
    await saveAsync(session, profile);
  }

  return {
    ok: true,
    reply,
    source,
    event: 'test_turn',
    profileUnchanged: before === after,
    ...(await getStateAsync(session)),
  };
}

async function handleBuild(session, userMessage) {
  const profile = await loadAsync(session);
  session.buildHistory.push({ role: 'user', content: userMessage });

  let result;
  try {
    result = await runBuilderTurnFn(session)({
      buildHistory: session.buildHistory.slice(0, -1),
      profile,
      userMessage,
    });
  } catch (err) {
    session.buildHistory.pop();
    return {
      ok: false,
      reply: `Builder error: ${err.message}`,
      source: 'error',
      ...(await getStateAsync(session)),
    };
  }

  if (result.onPurpose === false) {
    session.buildHistory.pop();
    return {
      ok: true,
      reply: OFF_PURPOSE_OWNER_REPLY,
      source: result.source,
      event: 'build_turn',
      readyForReview: false,
      wantsReview: false,
      onPurpose: false,
      consistencyMs: 0,
      consistencyRan: false,
      ...(await getStateAsync(session)),
    };
  }

  result = applyReviewGate(profile, result, userMessage);
  const prior = structuredClone(profile);
  const lastNav = lastShownNav(session.buildHistory);
  profile.draft = result.draft;
  const changed = draftDiffersFromLive(prior, result.draft);
  if (changed) applyDraftToLive(profile);
  await saveAsync(session, profile);

  const editingChrome =
    lastNav === 'menu' || (typeof lastNav === 'string' && lastNav.startsWith('section:'));
  const asking = !!result.asksQuestion && (changed || !editingChrome);

  let reply;
  let nav = null;
  if (asking) {
    reply = result.message;
  } else if (changed || result.presentReview) {
    const ack = changed ? (result.message || '').trim() : '';
    const card = changed ? renderSavedChanges(prior, profile) : renderReview(profile);
    reply = [ack, card].filter(Boolean).join('\n\n');
    nav = 'review';
  } else if (profile.approvedAt) {
    reply = [result.message, renderMenu(leadMenuOpts(session, profile))]
      .filter(Boolean)
      .join('\n\n');
    nav = 'menu';
  } else {
    reply = result.message;
  }

  session.buildHistory.push({
    role: 'assistant',
    content: reply,
    ...(nav ? { nav } : {}),
    asksQuestion: !nav && !!result.asksQuestion,
  });

  return {
    ok: true,
    reply,
    source: result.source,
    event: 'build_turn',
    readyForReview: result.readyForReview,
    wantsReview: !!result.wantsReview,
    consistencyMs: result.consistencyMs ?? 0,
    consistencyRan: !!result.consistencyRan,
    ...(await getStateAsync(session)),
  };
}

/** Local UI start: empty chat until the owner’s first message wakes the opening. */
export function bootstrapSession(session) {
  if (session.store && session.senderId) {
    return {
      ok: true,
      reply: null,
      source: 'app',
      mode: session.mode,
      buildHistory: session.buildHistory,
      testHistory: session.testHistory,
    };
  }
  return {
    ok: true,
    reply: null,
    source: 'app',
    ...getState(session),
  };
}
