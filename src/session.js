import {
  loadProfile,
  saveProfile,
  mergeDraft,
  formatSummary,
  emptyProfile,
  defaultProfilePath,
} from './profile.js';
import {
  applyReviewGate,
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
  ownerLanguage,
  parseMenuChoice,
  renderMenu,
  renderReturnToEditing,
  renderSection,
  renderSetupContinue,
  renderSyncSuccess,
} from './ownerNav.js';

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
  '\n\n[Approved. Flowise is waking up — syncing the customer bot usually takes 1–2 minutes. I will message you when it is ready; then type /test.]';

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
      syncNote: `\n\n${renderSyncSuccess(ownerLanguage(session.buildHistory))}`,
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
    const open = openingMessage();
    session.buildHistory.push({ role: 'assistant', content: open.message });
    return {
      ok: true,
      reply: open.message,
      source: open.source,
      event: 'reset',
      ...(await getStateAsync(session)),
    };
  }

  if (session.mode === 'TEST') {
    return handleTest(session, trimmed, options.flowiseSessionId);
  }
  const nav = await handleNavigation(session, trimmed);
  if (nav) return nav;
  return handleBuild(session, trimmed);
}

/**
 * Editing-menu navigation for an approved bot (BUILD only). Read-only: never
 * saves the profile, so the draft and review state stay as they were.
 * Numbers count as menu choices only right after a menu was shown.
 * @returns {Promise<object|null>} null → not navigation, continue to the Builder
 */
async function handleNavigation(session, text) {
  const wantsMenu = isMenuRequest(text);
  const choice = menuActive(session.buildHistory) ? parseMenuChoice(text) : null;
  if (!wantsMenu && choice == null) return null;
  const profile = await loadAsync(session);
  if (!profile.approvedAt) return null;

  if (choice === 6) return enterTest(session);

  const lang = ownerLanguage(session.buildHistory);
  const reply = wantsMenu ? renderMenu(lang) : renderSection(choice, profile, lang);
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

async function enterTest(session) {
  const profile = await loadAsync(session);
  if (!profile.approvedAt || !profile.chatflowId || !profile.flowiseSyncOk) {
    let reply;
    if (!profile.approvedAt) {
      reply =
        'Nothing approved yet. Finish the interview, review the summary, and say **approve** first. Then /test.';
    } else if (profile.flowiseSyncPending) {
      reply =
        'Still syncing to Flowise (it may be waking up). Wait for the ready message, then try /test again.';
      wakeFlowiseFn(session)().catch(() => {});
    } else if (!profile.flowiseSyncOk) {
      reply =
        'Approved facts are not synced to Flowise yet. Say **approve** again to retry sync, then /test.';
    } else {
      reply =
        'Nothing approved yet. Finish the interview, review the summary, and say **approve** first. Then /test.';
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
    'TEST mode — you are now a customer talking to your business bot (Flowise). Type /end to return to BUILD.';
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
  const lang = ownerLanguage(session.buildHistory);
  const profile = await loadAsync(session);
  if (profile.approvedAt) {
    const reply = renderReturnToEditing(lang);
    session.buildHistory.push({ role: 'assistant', content: reply, nav: 'menu' });
    return {
      ok: true,
      reply,
      source: 'app',
      event: 'enter_build',
      ...(await getStateAsync(session)),
    };
  }
  const reply = renderSetupContinue(lang);
  return {
    ok: true,
    reply,
    source: 'app',
    event: 'enter_build',
    ...(await getStateAsync(session)),
  };
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
  let event = 'build_turn';
  let syncNote = '';

  if (result.approved) {
    const merged = mergeDraft(profile, result.draft);
    Object.assign(profile, {
      name: merged.name,
      whatWeDo: merged.whatWeDo,
      ownerGoal: merged.ownerGoal,
      services: merged.services || [],
      hours: merged.hours,
      locationOrArea: merged.locationOrArea,
      commonQuestions: merged.commonQuestions || [],
      informationToCollect: Array.isArray(merged.informationToCollect)
        ? merged.informationToCollect
        : [],
      unknowns: merged.unknowns || [],
      tone: merged.tone,
      responseLength: merged.responseLength ?? null,
      priceDisclosure: merged.priceDisclosure ?? null,
      assistantName: merged.assistantName ?? null,
      openingMessage: merged.openingMessage ?? null,
      draft: result.draft,
      approvedAt: new Date().toISOString(),
      // Until Flowise sync succeeds, /test stays blocked
      flowiseSyncOk: false,
      flowiseSyncPending: false,
      flowiseSyncRequestedAt: null,
    });

    const sync = await syncApprovedProfile(session, profile);
    syncNote = sync.syncNote;
    event = sync.event;
    if (sync.sourceSuffix) {
      result.source = `${result.source}${sync.sourceSuffix}`;
    }
  }

  await saveAsync(session, profile);
  const reply = result.message + syncNote;
  session.buildHistory.push(
    event === 'approved_synced'
      ? { role: 'assistant', content: reply, nav: 'menu' }
      : { role: 'assistant', content: reply }
  );

  return {
    ok: true,
    reply,
    source: result.source,
    event,
    readyForReview: result.readyForReview,
    approved: result.approved,
    ...(await getStateAsync(session)),
  };
}

export function bootstrapSession(session) {
  const open = openingMessage();
  if (session.buildHistory.length === 0) {
    session.buildHistory.push({ role: 'assistant', content: open.message });
  }
  // Sync getState for file sessions; store sessions use histories only until persist
  if (session.store && session.senderId) {
    return {
      ok: true,
      reply: open.message,
      source: open.source,
      mode: session.mode,
      buildHistory: session.buildHistory,
      testHistory: session.testHistory,
    };
  }
  return {
    ok: true,
    reply: open.message,
    source: open.source,
    ...getState(session),
  };
}
