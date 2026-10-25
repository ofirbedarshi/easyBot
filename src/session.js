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
  createOrUpdateChatflow as defaultCreateOrUpdateChatflow,
  predict as defaultPredict,
  pingFlowise as defaultPingFlowise,
  wakeFlowise as defaultWakeFlowise,
  truncateFlowiseErrorBody,
  isFlowiseUnavailableError,
} from './flowise.js';
import {
  isMenuRequest,
  menuActive,
  parseMenuChoice,
  parseMenuItem,
  renderMenu,
  parseReviewChoice,
  renderChangeMenu,
  renderReturnToEditing,
  renderReview,
  renderSection,
  reviewActive,
  renderSetupContinue,
  renderSyncedShort,
  renderSyncSuccess,
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

function createOrUpdateChatflowFn(session) {
  return deps(session).createOrUpdateChatflow || defaultCreateOrUpdateChatflow;
}

function pingFlowiseFn(session) {
  return deps(session).pingFlowise || defaultPingFlowise;
}

function wakeFlowiseFn(session) {
  return deps(session).wakeFlowise || defaultWakeFlowise;
}

function predictFn(session) {
  return deps(session).predict || defaultPredict;
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

function save(session, profile) {
  if (session.store && session.senderId) {
    throw new Error('Use saveAsync for store-backed sessions');
  }
  return saveProfile(profile, session.profilePath);
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
      hasChatflow: false,
      approvedAt: null,
      flowiseSyncOk: false,
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
    hasChatflow: !!profile.chatflowId,
    approvedAt: profile.approvedAt,
    flowiseSyncOk: !!profile.flowiseSyncOk,
    flowiseSyncedAt: profile.flowiseSyncedAt || null,
    flowiseSyncPending: !!profile.flowiseSyncPending,
    buildHistory: session.buildHistory,
    testHistory: session.testHistory,
  };
}

function markFlowiseSyncPending(session, profile) {
  profile.flowiseSyncOk = false;
  profile.flowiseSyncPending = true;
  profile.flowiseSyncRequestedAt = new Date().toISOString();
  // Kick cold start without blocking the chat turn
  wakeFlowiseFn(session)().catch(() => {});
}

const SYNC_PENDING_NOTE =
  '\n\n[Approved. Flowise is waking up — syncing the customer bot usually takes 1–2 minutes. I will message you when it is ready; then choose Try my bot or type /test.]';

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
 * Sync chatflow now, or mark pending + wake if Flowise is down / errors.
 * @returns {Promise<{ event: string, syncNote: string, sourceSuffix?: string }>}
 */
async function syncApprovedProfile(session, profile) {
  // Start cold-start early; do not block Approve on full wake.
  wakeFlowiseFn(session)().catch(() => {});

  const reachable = await pingFlowiseFn(session)({
    timeoutMs: Number(process.env.FLOWISE_PING_TIMEOUT_MS) || 5000,
  });
  if (!reachable) {
    markFlowiseSyncPending(session, profile);
    return {
      event: 'approved_sync_pending',
      syncNote: SYNC_PENDING_NOTE,
    };
  }

  try {
    const chatflowId = await createOrUpdateChatflowFn(session)(profile);
    profile.chatflowId = chatflowId;
    profile.flowiseSyncOk = true;
    profile.flowiseSyncPending = false;
    profile.flowiseSyncedAt = new Date().toISOString();
    profile.flowiseSyncRequestedAt = null;
    console.log(`Flowise sync ok chatflow=${chatflowId}`);
    return {
      event: 'approved_synced',
      syncNote: `\n\n${renderSyncSuccess(leadMenuOpts(session, profile))}`,
      sourceSuffix: '+real-flowise-sync',
    };
  } catch (err) {
    // Stay pending; background worker retries. Keep note short (no HTML dump).
    const short = truncateFlowiseErrorBody(err.message, 100);
    console.warn('Flowise sync deferred (pending):', short);
    markFlowiseSyncPending(session, profile);
    return {
      event: 'approved_sync_pending',
      syncNote: SYNC_PENDING_NOTE,
    };
  }
}

/**
 * @param {ReturnType<typeof createSession>} session
 * @param {string} text
 * @param {{ flowiseSessionId?: string }} [options]
 */
export async function handleMessage(session, text, options = {}) {
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
    return handleTest(session, trimmed, options.flowiseSessionId);
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
 * TEST) and 2 "Make changes" (full editing menu). From the editing menu, the
 * section items are read-only (never save the profile) and the last item
 * behaves like "Try my bot". After approval, until a lead is submitted, item 1
 * is "Get this bot for my business" and the rest shift down by one.
 * @returns {Promise<object|null>} null → not navigation, continue to the Builder
 */
async function handleNavigation(session, text) {
  if (reviewActive(session.buildHistory)) {
    const pick = parseReviewChoice(text);
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
 * Apply the reviewed draft to live fields and sync Flowise.
 * Mutates `profile` in place; caller saves.
 */
async function approveDraft(session, profile) {
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
    flowiseSyncOk: false,
    flowiseSyncPending: false,
    flowiseSyncRequestedAt: null,
  });
  return syncApprovedProfile(session, profile);
}

/**
 * Try my bot with a pending review: approve + sync, then enter TEST when ready.
 */
async function approvePendingAndTest(session, profile, text) {
  session.buildHistory.push({ role: 'user', content: text });
  const sync = await approveDraft(session, profile);
  await saveAsync(session, profile);

  if (sync.event === 'approved_synced') {
    const testResult = await enterTest(session);
    const reply = `${renderSyncedShort()}\n\n${testResult.reply}`;
    session.buildHistory.push({ role: 'assistant', content: reply });
    return {
      ...testResult,
      ok: true,
      reply,
      source: `app${sync.sourceSuffix || '+real-flowise-sync'}`,
      event: 'approved_enter_test',
      approved: true,
      readyForReview: true,
    };
  }

  // Sync pending — stay in BUILD; worker will show the menu when ready.
  const reply = `Approved.${sync.syncNote}`;
  session.buildHistory.push({ role: 'assistant', content: reply });
  return {
    ok: true,
    reply,
    source: 'app',
    event: sync.event,
    approved: true,
    readyForReview: true,
    ...(await getStateAsync(session)),
  };
}

async function enterTest(session) {
  const profile = await loadAsync(session);
  const synced = () => profile.chatflowId && profile.flowiseSyncOk;
  if (profile.approvedAt && !synced() && !profile.flowiseSyncPending) {
    await syncApprovedProfile(session, profile);
    await saveAsync(session, profile);
  }
  if (!profile.approvedAt || !synced()) {
    let reply;
    if (!profile.approvedAt) {
      reply = 'Nothing is live yet. Finish the setup, then choose **Try my bot** on the review.';
    } else {
      reply =
        'Your bot is still getting ready. I will message you when it is ready; then choose **Try my bot** or type /test.';
      wakeFlowiseFn(session)().catch(() => {});
    }
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

async function handleTest(session, question, flowiseSessionId) {
  const profile = await loadAsync(session);
  // TEST must never modify business facts
  const before = JSON.stringify({
    name: profile.name,
    services: profile.services,
    hours: profile.hours,
  });

  const sid = flowiseSessionId || session.testSessionId;
  let reply;
  let source = 'real-flowise';
  try {
    reply = await predictFn(session)(profile.chatflowId, question, sid);
  } catch (err) {
    const missing =
      /not found/i.test(err.message) || /getChatflowById/i.test(err.message);
    if (missing && profile.approvedAt) {
      try {
        console.warn(
          'Flowise chatflow missing; recreating:',
          profile.chatflowId,
          err.message
        );
        profile.chatflowId = null;
        profile.flowiseSyncOk = false;
        const newId = await createOrUpdateChatflowFn(session)(profile);
        profile.chatflowId = newId;
        profile.flowiseSyncOk = true;
        profile.flowiseSyncedAt = new Date().toISOString();
        await saveAsync(session, profile);
        reply = await predictFn(session)(newId, question, sid);
        source = 'real-flowise';
      } catch (recoverErr) {
        if (isFlowiseUnavailableError(recoverErr)) {
          wakeFlowiseFn(session)().catch(() => {});
          reply =
            'Flowise is waking up. Wait about a minute and send your question again.';
        } else {
          reply = `Flowise error: ${truncateFlowiseErrorBody(recoverErr.message)}`;
        }
        source = 'error';
      }
    } else if (isFlowiseUnavailableError(err)) {
      wakeFlowiseFn(session)().catch(() => {});
      reply =
        'Flowise is waking up. Wait about a minute and send your question again.';
      source = 'error';
    } else {
      reply = `Flowise error: ${truncateFlowiseErrorBody(err.message)}`;
      source = 'error';
    }
  }

  // Isolated Flowise ids (parallel customer probes) skip shared history to avoid races
  if (!flowiseSessionId || flowiseSessionId === session.testSessionId) {
    session.testHistory.push({ role: 'user', content: question });
    session.testHistory.push({ role: 'assistant', content: reply });
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
  profile.draft = result.draft;
  profile.reviewedDraftKey = result.reviewedDraftKey;
  await saveAsync(session, profile);

  let reply;
  let nav = null;
  if (result.presentReview) {
    const ack = (result.message || '').trim();
    reply = [ack, renderReview(profile)].filter(Boolean).join('\n\n');
    nav = 'review';
  } else {
    reply = result.message;
  }

  session.buildHistory.push(
    nav
      ? { role: 'assistant', content: reply, nav }
      : { role: 'assistant', content: reply }
  );

  return {
    ok: true,
    reply,
    source: result.source,
    event: 'build_turn',
    readyForReview: result.readyForReview,
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
