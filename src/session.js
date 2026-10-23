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
 * (default: data/business-profile.json).
 */
export function createSession(profilePath) {
  return {
    mode: 'BUILD', // BUILD | TEST
    buildHistory: [],
    testHistory: [],
    testSessionId: `test-${Date.now()}`,
    profilePath: profilePath || defaultProfilePath(),
  };
}

function load(session) {
  return loadProfile(session.profilePath);
}

function save(session, profile) {
  return saveProfile(profile, session.profilePath);
}

export function getState(session) {
  const profile = load(session);
  return {
    mode: session.mode,
    profile: {
      ...profile,
      // never send API keys
    },
    summary: formatSummary(mergeDraft(profile, profile.draft || {})),
    hasChatflow: !!profile.chatflowId,
    approvedAt: profile.approvedAt,
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
    return { ok: false, error: 'Empty message', ...getState(session) };
  }

  // Commands handled in app code — never by the LLM
  if (trimmed === '/test') {
    return enterTest(session);
  }
  if (trimmed === '/end') {
    return enterBuild(session);
  }
  if (trimmed === '/reset') {
    save(session, emptyProfile());
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
      ...getState(session),
    };
  }

  if (session.mode === 'TEST') {
    return handleTest(session, trimmed, options.flowiseSessionId);
  }
  return handleBuild(session, trimmed);
}

async function enterTest(session) {
  const profile = load(session);
  if (!profile.approvedAt || !profile.chatflowId) {
    return {
      ok: false,
      reply:
        'Nothing approved yet. Finish the interview, review the summary, and say **approve** first. Then /test.',
      source: 'app',
      ...getState(session),
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
    ...getState(session),
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
    ...getState(session),
  };
}

async function handleTest(session, question, flowiseSessionId) {
  const profile = load(session);
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
    reply = `Flowise error: ${err.message}`;
    source = 'error';
  }

  // Isolated Flowise ids (parallel customer probes) skip shared history to avoid races
  if (!flowiseSessionId || flowiseSessionId === session.testSessionId) {
    session.testHistory.push({ role: 'user', content: question });
    session.testHistory.push({ role: 'assistant', content: reply });
  }

  const afterProfile = load(session);
  const after = JSON.stringify({
    name: afterProfile.name,
    services: afterProfile.services,
    hours: afterProfile.hours,
  });
  if (before !== after) {
    // Should be impossible — restore if somehow mutated
    save(session, profile);
  }

  return {
    ok: true,
    reply,
    source,
    event: 'test_turn',
    profileUnchanged: before === after,
    ...getState(session),
  };
}

async function handleBuild(session, userMessage) {
  const profile = load(session);
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
      ...getState(session),
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
    });

    try {
      const chatflowId = await createOrUpdateChatflow(profile);
      profile.chatflowId = chatflowId;
      syncNote = `\n\n[Bot updated in Flowise — chatflow ${chatflowId}. Type /test to try it.]`;
      event = 'approved_synced';
      result.source = `${result.source}+real-flowise-sync`;
    } catch (err) {
      syncNote = `\n\n[Approved locally, but Flowise sync failed: ${err.message}]`;
      event = 'approved_sync_failed';
    }
  }

  save(session, profile);
  const reply = result.message + syncNote;
  session.buildHistory.push({ role: 'assistant', content: reply });

  return {
    ok: true,
    reply,
    source: result.source,
    event,
    readyForReview: result.readyForReview,
    approved: result.approved,
    ...getState(session),
  };
}

export function bootstrapSession(session) {
  const open = openingMessage();
  if (session.buildHistory.length === 0) {
    session.buildHistory.push({ role: 'assistant', content: open.message });
  }
  return {
    ok: true,
    reply: open.message,
    source: open.source,
    ...getState(session),
  };
}
