import {
  loadProfile,
  saveProfile,
  formatSummary,
  emptyProfile,
  defaultProfilePath,
  applyDraftToLive,
  draftDiffersFromLive,
  hasEnoughForFirstBot,
  mergeDraft,
} from './profile.js';
import {
  applyReviewGate,
  hasUnresolvedConfig,
  runBuilderTurn as defaultRunBuilderTurn,
} from './builder.js';
import { topicJustAsked } from './builderTopics.js';
import { changeLines, composeReply } from './composeReply.js';
import { CHATS_FOOTER, EMPTY_MESSAGE_ERROR, normalizeOwnerName } from './copy.js';
import { applyOwnerNameCollisionGuard } from './setupAgenda.js';
import {
  businessBotReply as defaultBusinessBotReply,
  BUSINESS_BOT_STORED_MESSAGES,
} from './businessBot.js';
import {
  isMenuRequest,
  menuActive,
  parseMenuChoice,
  parseMenuItem,
  isReviewNumberChoice,
  parseReviewChoice,
  unwrapWhatsAppBold,
} from './ownerNav.js';
import {
  leadSubmitted,
  startLeadIntake,
  stepLeadIntake,
} from './leadIntake.js';
import { ownerPhase } from './ownerPhase.js';
import {
  clarifyFromBuilderMessage,
  groupTestChats,
  loadLoggedMessages,
  reviewChatsReply as defaultReviewChatsReply,
} from './reviewChats.js';

function deps(session) {
  return session.deps || {};
}

function runBuilderTurnFn(session) {
  return deps(session).runBuilderTurn || defaultRunBuilderTurn;
}

function businessBotReplyFn(session) {
  return deps(session).businessBotReply || defaultBusinessBotReply;
}

function reviewChatsReplyFn(session) {
  return deps(session).reviewChatsReply || defaultReviewChatsReply;
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
    reviewChats: null,
    loggedTestMessages: [],
    ownerName: null,
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
    reviewChats: saved.reviewChats || null,
    loggedTestMessages: [],
    ownerName: saved.ownerName ?? null,
    profilePath: null,
    store,
    senderId,
    deps: options.deps || null,
  };
}

export async function persistSenderSession(session) {
  if (session.purged) return;
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

/** Scripted TEST-entry banner. Code only; `{business}` is the profile name. */
export function enterTestBanner(business) {
  return composeReply({
    kind: 'test_enter',
    profile: { name: business },
  }).replies[0];
}

/** Scripted TEST-exit banner. Code only. */
export function exitTestBanner() {
  return composeReply({ kind: 'test_exit', parts: { ready: false } }).reply;
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
    return { ok: false, error: EMPTY_MESSAGE_ERROR, ...(await getStateAsync(session)) };
  }

  // Commands handled in app code — never by the LLM
  const exitTest = isExitTestCommand(trimmed);
  if (trimmed === '/test' || trimmed === '/reset' || exitTest) {
    cancelLeadIntake(session);
    clearLeadResume(session);
    clearReviewChats(session);
  }
  if (trimmed === '/test') {
    return enterTest(session);
  }
  if (exitTest) {
    return enterBuild(session);
  }
  if (trimmed === '/reset') {
    session.buildHistory = [];
    session.testHistory = [];
    session.mode = 'BUILD';
    session.testSessionId = `test-${Date.now()}`;
    session.leadIntake = null;
    session.reviewChats = null;
    session.loggedTestMessages = [];
    session.ownerName = null;
    session.lead = null;

    if (session.store && session.senderId) {
      session.purged = true;
      if (typeof session.store.deleteSender === 'function') {
        await session.store.deleteSender(session.senderId);
      } else if (typeof session.store.deleteLead === 'function') {
        await session.store.deleteLead(session.senderId);
      }
      return {
        ok: true,
        reply: composeReply({ kind: 'reset' }).reply,
        source: 'app',
        event: 'reset',
        ...stateFrom(session, emptyProfile()),
      };
    }

    await saveAsync(session, emptyProfile());
    return {
      ok: true,
      reply: composeReply({ kind: 'reset' }).reply,
      source: 'app',
      event: 'reset',
      ...(await getStateAsync(session)),
    };
  }

  const phase = ownerPhase(session);
  if (phase === 'test') {
    return handleTest(session, trimmed);
  }

  // First inbound in BUILD only wakes the bot — discard content, send opening.
  if (phase === 'wake') {
    const open = composeReply({ kind: 'opening' });
    session.buildHistory.push({ role: 'assistant', content: open.reply });
    return {
      ok: true,
      reply: open.reply,
      source: 'app',
      event: 'opening',
      ...(await getStateAsync(session)),
    };
  }

  if (phase === 'lead') return handleLeadIntake(session, trimmed);
  if (phase === 'lead_resume') return resumeOwnerMenu(session, trimmed);
  if (phase === 'chats') return handleReviewChats(session, trimmed);

  const nav = await handleNavigation(session, trimmed);
  if (nav) return nav;
  return handleBuild(session, trimmed);
}

/**
 * Editing-menu navigation (BUILD only). Menu words require `approvedAt`.
 * Numbers bind only to the latest assistant reply with `nav: 'menu'`.
 * A later reply without `nav` clears them; a bare digit then goes to the
 * Builder as normal text. Section items are read-only.
 * The lead item is listed only after the owner has entered TEST at least
 * once (`firstTestedAt`) and has not submitted a lead. Completing the
 * questionnaire does not append a menu; the next BUILD message shows
 * "What should we do next?" plus the current menu (without the lead
 * item). `/reset` deletes this sender (including the lead) so the item
 * can be offered again after a new first setup and TEST.
 * @returns {Promise<object|null>} null → not navigation, continue to the Builder
 */
async function handleNavigation(session, text) {
  const wantsMenu = isMenuRequest(text);
  const numbered = menuActive(session.buildHistory) && parseMenuChoice(text, 9) != null;
  const tryWords =
    menuActive(session.buildHistory) &&
    parseReviewChoice(text) === 'try' &&
    !isReviewNumberChoice(text);
  if (!wantsMenu && !numbered && !tryWords) return null;
  const profile = await loadAsync(session);
  const choice = numbered ? parseMenuItem(text, ownerMenuOpts(session, profile)) : null;
  if (!wantsMenu && choice == null && !tryWords) return null;

  const ready = ownerPhase(session, profile) === 'ready';
  if (wantsMenu && !ready) return null;
  if (!ready && choice == null && !tryWords) return null;

  if (choice === 'lead') return beginLeadIntake(session);
  if (tryWords || choice === 'try') return tryMyBot(session);
  if (choice === 'chats') return beginReviewChats(session, text);

  const composed = wantsMenu
    ? composeReply({
        kind: 'change_menu',
        menuOpts: ownerMenuOpts(session, profile),
        ownerName: session.ownerName,
      })
    : composeReply({ kind: 'section', profile, parts: { section: choice } });
  const reply = composed.reply;
  session.buildHistory.push({ role: 'user', content: text });
  session.buildHistory.push({
    role: 'assistant',
    content: reply,
    nav: composed.nav,
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
    return {
      ok: false,
      reply: composeReply({ kind: 'test_refuse' }).reply,
      source: 'app',
      ...(await getStateAsync(session)),
    };
  }
  if (!profile.firstTestedAt) {
    profile.firstTestedAt = new Date().toISOString();
    await saveAsync(session, profile);
  }
  session.mode = 'TEST';
  const composed = composeReply({ kind: 'test_enter', profile });
  session.testHistory = [{ role: 'assistant', content: composed.replies[1] }];
  session.testSessionId = `test-${Date.now()}`;
  logLocalMessage(session, { direction: 'outbound', body: composed.reply, mode: 'command' });
  return {
    ok: true,
    reply: composed.reply,
    replies: composed.replies,
    source: 'app',
    event: 'enter_test',
    ...(await getStateAsync(session)),
  };
}

async function enterBuild(session) {
  const leavingTest = session.mode === 'TEST';
  if (leavingTest) {
    logLocalMessage(session, { direction: 'inbound', body: 'stop', mode: 'command' });
  }
  session.mode = 'BUILD';
  const profile = await loadAsync(session);
  // approvedAt, not ownerPhase === 'ready': empty BUILD history is wake
  // (first inbound still opens), but leaving TEST already treats a
  // seeded ready profile as ready.
  const menuOpts = ownerMenuOpts(session, profile);
  if (profile.approvedAt) {
    const composed = leavingTest
      ? composeReply({
          kind: 'test_exit',
          menuOpts,
          ownerName: session.ownerName,
          parts: { ready: true },
        })
      : composeReply({
          kind: 'stop_build',
          menuOpts,
          ownerName: session.ownerName,
          parts: { ready: true },
        });
    session.buildHistory.push({
      role: 'assistant',
      content: leavingTest ? composed.replies[1] : composed.reply,
      nav: composed.nav,
    });
    return {
      ok: true,
      reply: composed.reply,
      ...(composed.replies ? { replies: composed.replies } : {}),
      source: 'app',
      event: 'enter_build',
      ...(await getStateAsync(session)),
    };
  }
  const composed = leavingTest
    ? composeReply({ kind: 'test_exit', parts: { ready: false } })
    : composeReply({ kind: 'stop_build', parts: { ready: false } });
  return {
    ok: true,
    reply: composed.reply,
    ...(composed.replies ? { replies: composed.replies } : {}),
    source: 'app',
    event: 'enter_build',
    ...(await getStateAsync(session)),
  };
}

function ownerMenuOpts(session, profile) {
  return {
    leadOption:
      !!profile?.approvedAt &&
      !!profile?.firstTestedAt &&
      !leadSubmitted(session.leadIntake),
    chatsOption: !!profile?.firstTestedAt,
  };
}

function clearReviewChats(session) {
  session.reviewChats = null;
}

function asReviewChatsTurn(out) {
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    return {
      message: String(out.message || ''),
      teaching: out.teaching === true,
    };
  }
  return { message: String(out || ''), teaching: false };
}

/**
 * Same owner-name + gate + live apply that handleBuild uses.
 * Caller composes the owner-facing reply.
 */
async function applyBuilderTurnSave(session, profile, result, userMessage) {
  const priorOwnerName = session.ownerName || null;
  const extractedOwnerName = normalizeOwnerName(result.ownerName);
  if (extractedOwnerName) {
    result = {
      ...result,
      draft: applyOwnerNameCollisionGuard(result.draft, extractedOwnerName, priorOwnerName),
    };
    session.ownerName = extractedOwnerName;
  }
  const ownerName = session.ownerName || null;

  result = applyReviewGate(profile, result, userMessage, {
    justAsked: topicJustAsked(session.buildHistory),
    ownerName,
  });
  const prior = structuredClone(profile);
  profile.draft = result.draft;
  const nextView = mergeDraft(prior, result.draft);
  const differs = draftDiffersFromLive(prior, result.draft);
  const visible = changeLines(prior, nextView).length > 0;
  const changed = differs && visible;
  if (differs && !visible) {
    profile.draft = {
      ...(prior.draft || result.draft),
      askedTopics: result.draft?.askedTopics ?? prior.draft?.askedTopics,
    };
  }
  if (changed || result.presentReview) applyDraftToLive(profile);
  if (
    result.presentReview &&
    hasEnoughForFirstBot(profile) &&
    !prior.approvedAt
  ) {
    profile.approvedAt = new Date().toISOString();
  }
  await saveAsync(session, profile);
  return { prior, profile, changed, result, ownerName };
}

function logLocalMessage(session, { direction, body, mode }) {
  if (session.store && session.senderId) return;
  session.loggedTestMessages = session.loggedTestMessages || [];
  const lastId = session.loggedTestMessages.at(-1)?.id || 0;
  session.loggedTestMessages.push({
    id: lastId + 1,
    direction,
    body: body ?? '',
    mode,
    created_at: new Date().toISOString(),
  });
}

async function beginReviewChats(session, text) {
  const profile = await loadAsync(session);
  const rows = await loadLoggedMessages(session);
  const chats = groupTestChats(rows);
  if (!chats.length) {
    clearReviewChats(session);
    const composed = composeReply({
      kind: 'chats_empty',
      menuOpts: ownerMenuOpts(session, profile),
      ownerName: session.ownerName,
    });
    session.buildHistory.push({ role: 'user', content: text });
    session.buildHistory.push({
      role: 'assistant',
      content: composed.reply,
      nav: composed.nav,
    });
    return {
      ok: true,
      reply: composed.reply,
      source: 'app',
      event: 'chats_empty',
      ...(await getStateAsync(session)),
    };
  }

  session.reviewChats = {
    active: true,
    snapshot: chats,
    history: [],
    learned: [],
    startedAt: new Date().toISOString(),
  };
  let modelText;
  try {
    const turn = asReviewChatsTurn(
      await reviewChatsReplyFn(session)({
        snapshot: chats,
        history: [],
        question: null,
        learned: [],
      })
    );
    modelText = turn.message;
  } catch (err) {
    console.error('Review chats reply failed:', err?.status || err?.code || err?.name || 'error');
    modelText = composeReply({ kind: 'error_generic' }).reply;
  }
  const composed = composeReply({ kind: 'chats_report', modelText });
  session.reviewChats.history.push({ role: 'assistant', content: modelText });
  return {
    ok: true,
    reply: composed.reply,
    source: 'real-llm',
    event: 'enter_chats',
    ...(await getStateAsync(session)),
  };
}

async function handleReviewChats(session, text) {
  if (isMenuRequest(text)) {
    clearReviewChats(session);
    const profile = await loadAsync(session);
    const composed = composeReply({
      kind: 'change_menu',
      menuOpts: ownerMenuOpts(session, profile),
      ownerName: session.ownerName,
    });
    session.buildHistory.push({ role: 'user', content: text });
    session.buildHistory.push({
      role: 'assistant',
      content: composed.reply,
      nav: composed.nav,
    });
    return {
      ok: true,
      reply: composed.reply,
      source: 'app',
      event: 'menu',
      ...(await getStateAsync(session)),
    };
  }

  const snapshot = session.reviewChats?.snapshot || [];
  const history = session.reviewChats?.history || [];
  const learned = session.reviewChats?.learned || [];
  let turn;
  try {
    turn = asReviewChatsTurn(
      await reviewChatsReplyFn(session)({
        snapshot,
        history,
        question: text,
        learned,
      })
    );
  } catch (err) {
    console.error('Review chats reply failed:', err?.status || err?.code || err?.name || 'error');
    turn = { message: composeReply({ kind: 'error_generic' }).reply, teaching: false };
  }

  let composed;
  let historyText = turn.message;
  if (turn.teaching) {
    const taught = await teachFromChats(session, text);
    composed = taught.composed;
    historyText = taught.historyText;
  } else {
    composed = composeReply({ kind: 'chats_followup', modelText: turn.message });
  }
  session.reviewChats.history = [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: historyText },
  ].slice(-20);
  return {
    ok: true,
    reply: composed.reply,
    source: 'real-llm',
    event: 'chats_turn',
    ...(await getStateAsync(session)),
  };
}

async function teachFromChats(session, text) {
  const profile = await loadAsync(session);
  let result;
  try {
    result = await runBuilderTurnFn(session)({
      buildHistory: session.reviewChats?.history || [],
      profile,
      userMessage: text,
    });
  } catch (err) {
    const modelText = composeReply({
      kind: 'error_builder',
      parts: { errorMessage: err.message },
    }).reply;
    return {
      composed: composeReply({ kind: 'chats_followup', modelText }),
      historyText: modelText,
    };
  }

  if (result.onPurpose === false) {
    const modelText = clarifyFromBuilderMessage(result.message);
    return {
      composed: composeReply({ kind: 'chats_followup', modelText }),
      historyText: modelText,
    };
  }

  const applied = await applyBuilderTurnSave(session, profile, result, text);
  if (applied.changed) {
    const lines = changeLines(applied.prior, applied.profile);
    session.reviewChats.learned = [...(session.reviewChats.learned || []), ...lines].slice(-20);
    const composed = composeReply({
      kind: 'chats_saved',
      prior: applied.prior,
      profile: applied.profile,
      ownerName: applied.ownerName,
    });
    const suffix = `\n\n${CHATS_FOOTER}`;
    const historyText = composed.reply.endsWith(suffix)
      ? composed.reply.slice(0, -suffix.length)
      : composed.reply;
    return { composed, historyText };
  }

  const modelText = clarifyFromBuilderMessage(applied.result.message);
  return {
    composed: composeReply({ kind: 'chats_followup', modelText }),
    historyText: modelText,
  };
}

/** Drop an unfinished questionnaire (nothing saved); a submitted marker stays. */
function cancelLeadIntake(session) {
  if (ownerPhase(session) === 'lead') session.leadIntake = null;
}

/** Commands already show their own UI; do not consume the next BUILD turn. */
function clearLeadResume(session) {
  if (ownerPhase(session) !== 'lead_resume') return;
  session.leadIntake = { submittedAt: session.leadIntake.submittedAt };
}

/** First BUILD message after a saved lead: show the current owner menu. */
async function resumeOwnerMenu(session, text) {
  session.leadIntake = { submittedAt: session.leadIntake.submittedAt };
  const profile = await loadAsync(session);
  const composed = composeReply({
    kind: 'change_menu',
    menuOpts: ownerMenuOpts(session, profile),
    ownerName: session.ownerName,
  });
  const reply = composed.reply;
  session.buildHistory.push({ role: 'user', content: text });
  session.buildHistory.push({ role: 'assistant', content: reply, nav: composed.nav });
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
  const profile = await loadAsync(session);
  if (leadSubmitted(session.leadIntake)) {
    return leadReply(
      session,
      composeReply({
        kind: 'lead_already_sent',
        menuOpts: ownerMenuOpts(session, profile),
      }).reply,
      'lead_already_sent'
    );
  }
  const { state, reply } = startLeadIntake(profile.name || profile.draft?.name);
  session.leadIntake = state;
  return leadReply(session, reply, 'lead_question');
}

async function handleLeadIntake(session, text) {
  if (isMenuRequest(text)) {
    cancelLeadIntake(session);
    const profile = await loadAsync(session);
    return leadReply(
      session,
      composeReply({
        kind: 'lead_cancelled',
        menuOpts: ownerMenuOpts(session, profile),
      }).reply,
      'lead_cancelled'
    );
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
    logLocalMessage(session, { direction: 'inbound', body: question, mode: 'test' });
    logLocalMessage(session, { direction: 'outbound', body: reply, mode: 'test' });
  } catch (err) {
    // Provider error text can echo a masked API key; keep it out of chat and logs.
    console.error('Business Bot reply failed:', err?.status || err?.code || err?.name || 'error');
    reply = composeReply({ kind: 'error_business' }).reply;
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
      reply: composeReply({ kind: 'error_builder', parts: { errorMessage: err.message } }).reply,
      source: 'error',
      ...(await getStateAsync(session)),
    };
  }

  if (result.onPurpose === false) {
    session.buildHistory.pop();
    return {
      ok: true,
      reply: composeReply({ kind: 'off_purpose' }).reply,
      source: result.source,
      event: 'build_turn',
      onPurpose: false,
      consistencyMs: 0,
      consistencyRan: false,
      ...(await getStateAsync(session)),
    };
  }

  const applied = await applyBuilderTurnSave(session, profile, result, userMessage);
  result = applied.result;
  const { prior, changed, ownerName } = applied;

  const ready = ownerPhase(session, profile) === 'ready';
  const firstApproval = !prior.approvedAt && !!profile.approvedAt;
  const unresolved = hasUnresolvedConfig(result);

  const menuOpts = ownerMenuOpts(session, profile);
  let composed;
  if (firstApproval) {
    composed = composeReply({ kind: 'ready_first', menuOpts, ownerName });
  } else if (ready && unresolved) {
    composed = composeReply({
      kind: 'model_only',
      modelText: result.message,
    });
  } else if (ready && changed) {
    composed = composeReply({
      kind: 'saved_changes',
      modelText: result.message,
      prior,
      profile,
      menuOpts,
    });
  } else if (ready) {
    composed = composeReply({
      kind: 'model_plus_menu',
      modelText: result.message,
      menuOpts,
    });
  } else {
    composed = composeReply({
      kind: 'model_only',
      modelText: result.message,
      parts: { asksQuestion: !!result.asksQuestion },
    });
  }
  const reply = composed.reply;
  const nav = composed.nav;

  session.buildHistory.push({
    role: 'assistant',
    content: reply,
    ...(nav ? { nav } : {}),
    asksQuestion: !nav && !!composed.asksQuestion,
  });

  return {
    ok: true,
    reply,
    source: result.source,
    event: 'build_turn',
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
