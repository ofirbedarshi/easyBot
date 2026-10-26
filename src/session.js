import {
  loadProfile,
  saveProfile,
  mergeDraft,
  formatSummary,
  emptyProfile,
  defaultProfilePath,
  draftDiffersFromLive,
  draftReviewKey,
  hasEnoughForFirstBot,
} from './profile.js';
import {
  applyReviewGate,
  hasAnsweredInformationToCollect,
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
  renderChangeMenu,
  renderReturnToEditing,
  renderReview,
  renderSection,
  reviewActive,
  renderSetupContinue,
  renderSyncedShort,
} from './ownerNav.js';
import {
  LEAD_ALREADY_SENT,
  LEAD_THANKS,
  leadInProgress,
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

/**
 * True when a presented review of the current draft is waiting to be applied
 * (first approval, or a later pending edit).
 */
export function reviewPending(profile) {
  const draft = profile?.draft;
  if (!draft) return false;
  if (!hasAnsweredInformationToCollect(draft)) return false;
  if (!hasEnoughForFirstBot(mergeDraft(profile, draft))) return false;
  const key = draftReviewKey(profile, draft);
  if (!profile.reviewedDraftKey || profile.reviewedDraftKey !== key) return false;
  if (!profile.approvedAt) return true;
  return draftDiffersFromLive(profile, draft);
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
  if (['/test', '/end', '/reset'].includes(trimmed)) cancelLeadIntake(session);
  if (trimmed === '/test') {
    return enterTest(session);
  }
  if (trimmed === '/end') {
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
      reply: 'Session cleared. Send any message to start again.',
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

  const nav = await handleNavigation(session, trimmed);
  if (nav) return nav;
  return handleBuild(session, trimmed);
}

/**
 * Editing-menu navigation (BUILD only). Menu words require an approved bot.
 * A review offers two options: 1 "Try my bot" (approves a pending review, then
 * TEST) and 2 "Make changes" (full editing menu). Those stay active while the
 * last shown nav is still the review, except a bare number after an intervening
 * Builder question (`asksQuestion` on that turn, no nav) is an answer to that
 * question. From the editing menu, the
 * section items are read-only (never save the profile) and the last item
 * behaves like "Try my bot". After approval, until a lead is submitted, item 1
 * is "Get this bot for my business" and the rest shift down by one.
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
  if (!wantsMenu && !numbered) return null;
  const profile = await loadAsync(session);
  // Same visibility rule as every rendered menu, so numbers match what was shown.
  const choice = numbered ? parseMenuItem(text, leadMenuOpts(session, profile)) : null;
  if (!wantsMenu && choice == null) return null;

  // Menu words only after first approval; numbers work from a review menu too.
  if (wantsMenu && !profile.approvedAt) return null;
  if (!profile.approvedAt && choice == null) return null;

  if (choice === 'lead') return beginLeadIntake(session);
  if (choice === 'try') return tryMyBot(session, text, profile);

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

/** "Try my bot": approve a pending review first, otherwise the normal /test path. */
async function tryMyBot(session, text, loaded = null) {
  const profile = loaded || (await loadAsync(session));
  if (reviewPending(profile)) return approvePendingAndTest(session, profile, text);
  return enterTest(session);
}

/**
 * Apply the reviewed draft to live fields; the Business Bot uses them at once.
 * Mutates `profile` in place; caller saves.
 */
function approveDraft(profile) {
  const merged = mergeDraft(profile, profile.draft);
  Object.assign(profile, merged, {
    ownerGoal: merged.ownerGoal ?? null,
    ownerGoalRequested: merged.ownerGoalRequested ?? null,
    services: merged.services || [],
    commonQuestions: merged.commonQuestions || [],
    informationToCollect: Array.isArray(merged.informationToCollect)
      ? merged.informationToCollect
      : [],
    unknowns: merged.unknowns || [],
    otherFacts: Array.isArray(merged.otherFacts) ? merged.otherFacts : [],
    responseLength: merged.responseLength ?? null,
    priceDisclosure: merged.priceDisclosure ?? null,
    assistantName: merged.assistantName ?? null,
    openingMessage: merged.openingMessage ?? null,
    draft: profile.draft,
    approvedAt: new Date().toISOString(),
  });
}

/**
 * Try my bot with a pending review: approve, then enter TEST.
 */
async function approvePendingAndTest(session, profile, text) {
  session.buildHistory.push({ role: 'user', content: text });
  approveDraft(profile);
  await saveAsync(session, profile);

  const testResult = await enterTest(session);
  const reply = `${renderSyncedShort()}\n\n${testResult.reply}`;
  session.buildHistory.push({ role: 'assistant', content: reply });
  return {
    ...testResult,
    ok: true,
    reply,
    source: 'app',
    event: 'approved_enter_test',
    approved: true,
    readyForReview: true,
  };
}

async function enterTest(session) {
  const profile = await loadAsync(session);
  if (!profile.approvedAt) {
    const reply =
      'Nothing is live yet. Finish the setup, then choose **Try my bot** on the review.';
    return {
      ok: false,
      reply,
      source: 'app',
      ...(await getStateAsync(session)),
    };
  }
  session.mode = 'TEST';
  session.testHistory = [];
  session.testSessionId = `test-${Date.now()}`;
  const reply =
    'TEST mode — you are now a customer talking to your business bot . Type "/end" to return to BUILD mode.';
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
  session.leadIntake = { submittedAt: lead.createdAt };
  const menu = renderMenu(leadMenuOpts(session, profile));
  return leadReply(session, `${LEAD_THANKS}\n\n${menu}`, 'lead_saved');
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

  result = applyReviewGate(profile, result, userMessage);
  const draftChanged =
    draftReviewKey(profile, profile.draft) !== draftReviewKey(profile, result.draft);
  profile.draft = result.draft;
  profile.reviewedDraftKey = result.reviewedDraftKey;
  await saveAsync(session, profile);

  let reply;
  let nav = null;
  if (result.presentReview) {
    const ack = draftChanged ? (result.message || '').trim() : '';
    reply = [ack, renderReview(profile)].filter(Boolean).join('\n\n');
    nav = 'review';
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
