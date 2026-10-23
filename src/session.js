import {
  loadProfile,
  saveProfile,
  mergeDraft,
  formatSummary,
  emptyProfile,
} from './profile.js';
import { runBuilderTurn, openingMessage } from './builder.js';
import { createOrUpdateChatflow, predict } from './flowise.js';

/**
 * In-memory session (one business POC). Profile persists on disk.
 */
export function createSession() {
  return {
    mode: 'BUILD', // BUILD | TEST
    buildHistory: [],
    testHistory: [],
    testSessionId: `test-${Date.now()}`,
  };
}

export function getState(session) {
  const profile = loadProfile();
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

export async function handleMessage(session, text) {
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
    saveProfile(emptyProfile());
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
    return handleTest(session, trimmed);
  }
  return handleBuild(session, trimmed);
}

async function enterTest(session) {
  const profile = loadProfile();
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

async function handleTest(session, question) {
  const profile = loadProfile();
  // TEST must never modify business facts
  const before = JSON.stringify({
    name: profile.name,
    services: profile.services,
    hours: profile.hours,
  });

  let reply;
  let source = 'real-flowise';
  try {
    reply = await predict(
      profile.chatflowId,
      question,
      session.testSessionId
    );
  } catch (err) {
    reply = `Flowise error: ${err.message}`;
    source = 'error';
  }

  session.testHistory.push({ role: 'user', content: question });
  session.testHistory.push({ role: 'assistant', content: reply });

  const afterProfile = loadProfile();
  const after = JSON.stringify({
    name: afterProfile.name,
    services: afterProfile.services,
    hours: afterProfile.hours,
  });
  if (before !== after) {
    // Should be impossible — restore if somehow mutated
    saveProfile(profile);
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
  const profile = loadProfile();
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

  saveProfile(profile);
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
