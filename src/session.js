import {
  loadProfile,
  saveProfile,
  mergeDraft,
  formatSummary,
  emptyProfile,
  defaultProfilePath,
} from './profile.js';
import { runBuilderTurn, openingMessage } from './builder.js';
import { createOrUpdateChatflow, predict } from './flowise.js';

/**
 * In-memory session. Profile persists on disk at session.profilePath
 * (default: data/business-profile.json) unless session.store + senderId set.
 */
export function createSession(profilePath) {
  return {
    mode: 'BUILD', // BUILD | TEST
    buildHistory: [],
    testHistory: [],
    testSessionId: `test-${Date.now()}`,
    profilePath: profilePath || defaultProfilePath(),
    store: null,
    senderId: null,
  };
}

/**
 * Load WhatsApp / store-backed session for one sender (isolated).
 */
export async function createSenderSession(store, senderId) {
  const saved = await store.loadSession(senderId);
  return {
    mode: saved.mode || 'BUILD',
    buildHistory: saved.buildHistory || [],
    testHistory: saved.testHistory || [],
    testSessionId: saved.testSessionId || `test-${Date.now()}`,
    profilePath: null,
    store,
    senderId,
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
    summary: formatSummary(mergeDraft(profile, profile.draft || {})),
    hasChatflow: !!profile.chatflowId,
    approvedAt: profile.approvedAt,
    flowiseSyncOk: !!profile.flowiseSyncOk,
    flowiseSyncedAt: profile.flowiseSyncedAt || null,
    buildHistory: session.buildHistory,
    testHistory: session.testHistory,
  };
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
  return handleBuild(session, trimmed);
}

async function enterTest(session) {
  const profile = await loadAsync(session);
  if (!profile.approvedAt || !profile.chatflowId || !profile.flowiseSyncOk) {
    return {
      ok: false,
      reply:
        !profile.approvedAt
          ? 'Nothing approved yet. Finish the interview, review the summary, and say **approve** first. Then /test.'
          : !profile.flowiseSyncOk
            ? 'Approved facts are not synced to Flowise yet. Say **approve** again after fixing Flowise, or wait for a successful sync.'
            : 'Nothing approved yet. Finish the interview, review the summary, and say **approve** first. Then /test.',
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
  const reply =
    'Back in BUILD mode. Tell me any updates (e.g. a price change), or type /test when ready.';
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
    reply = await predict(profile.chatflowId, question, sid);
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
        const newId = await createOrUpdateChatflow(profile);
        profile.chatflowId = newId;
        profile.flowiseSyncOk = true;
        profile.flowiseSyncedAt = new Date().toISOString();
        await saveAsync(session, profile);
        reply = await predict(newId, question, sid);
        source = 'real-flowise';
      } catch (recoverErr) {
        reply = `Flowise error: ${recoverErr.message}`;
        source = 'error';
      }
    } else {
      reply = `Flowise error: ${err.message}`;
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
    result = await runBuilderTurn({
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

  profile.draft = result.draft;
  let event = 'build_turn';
  let syncNote = '';

  if (result.approved) {
    const merged = mergeDraft(profile, result.draft);
    Object.assign(profile, {
      name: merged.name,
      whatWeDo: merged.whatWeDo,
      services: merged.services || [],
      hours: merged.hours,
      locationOrArea: merged.locationOrArea,
      commonQuestions: merged.commonQuestions || [],
      informationToCollect: Array.isArray(merged.informationToCollect)
        ? merged.informationToCollect
        : [],
      unknowns: merged.unknowns || [],
      tone: merged.tone,
      draft: result.draft,
      approvedAt: new Date().toISOString(),
      // Until Flowise sync succeeds, /test stays blocked
      flowiseSyncOk: false,
    });

    try {
      const chatflowId = await createOrUpdateChatflow(profile);
      profile.chatflowId = chatflowId;
      profile.flowiseSyncOk = true;
      profile.flowiseSyncedAt = new Date().toISOString();
      syncNote = `\n\n[Bot updated in Flowise — chatflow ${chatflowId}. Type /test to try it.]`;
      event = 'approved_synced';
      result.source = `${result.source}+real-flowise-sync`;
    } catch (err) {
      profile.flowiseSyncOk = false;
      syncNote = `\n\n[Approved locally, but Flowise sync failed: ${err.message}. /test is blocked until sync succeeds.]`;
      event = 'approved_sync_failed';
    }
  }

  await saveAsync(session, profile);
  const reply = result.message + syncNote;
  session.buildHistory.push({ role: 'assistant', content: reply });

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
