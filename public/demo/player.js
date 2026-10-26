/**
 * Client-only WhatsApp-style demo playback.
 * Loads /demo/<name>.json and drives the existing chat UI.
 * Never calls /api/chat, /api/start, or /api/health.
 */

export const DEMO_NAME_RE = /^[a-z0-9-]+$/i;
export const SUMMARY_HEADING = '*Luna Hair Studio*';
export const LONG_OWNER_PREFIX = 'I run Luna Hair Studio';

export const EXPECTED_CHIPS = [
  'Illustrative demo · fictional business',
  'Build your bot',
  'Try it as a customer',
];

/** Verbatim spoken lines for the luna marketing script (English). */
export const EXPECTED_LINES = [
  { role: 'incoming', text: 'Hi! Tell me about your business.' },
  {
    role: 'outgoing',
    text: "I run Luna Hair Studio in Austin. Women's haircuts are $45, men's haircuts are $30, and highlights start at $90. We're open Tuesday to Saturday, 9am to 6pm, closed Sundays and Mondays. Customers book by messaging us here.",
  },
  { role: 'incoming', text: 'What would you like your bot to help with?' },
  {
    role: 'outgoing',
    text: "Answer questions about our prices and hours, and collect the customer's name and preferred appointment time.",
  },
  { role: 'incoming', text: 'Your bot is ready to try!' },
  {
    role: 'incoming',
    text: "*Luna Hair Studio*\n• Women's haircut: $45\n• Men's haircut: $30\n• Highlights: from $90\n• Hours: Tuesday–Saturday, 9am–6pm\n• Closed: Sunday and Monday\n• Booking: by message\n• Collect: name and preferred appointment time\n\n1. Try my bot\n2. Make changes",
  },
  { role: 'outgoing', text: 'Try my bot' },
  {
    role: 'incoming',
    text: 'Test mode is on. Ask a question as if you were a customer.',
  },
  { role: 'outgoing', text: "How much is a women's haircut?" },
  { role: 'incoming', text: "A women's haircut is $45." },
  { role: 'outgoing', text: 'Are you open on Sunday?' },
  {
    role: 'incoming',
    text: "We're closed on Sundays and Mondays. We're open Tuesday to Saturday, 9am to 6pm.",
  },
  { role: 'outgoing', text: "I'd like to book a haircut." },
  {
    role: 'incoming',
    text: "What's your name, and what day and time would you prefer?",
  },
  { role: 'outgoing', text: 'Sarah. Thursday at 10am.' },
  {
    role: 'incoming',
    text: 'Thanks, Sarah! Your request is for Thursday at 10am. The salon still needs to confirm availability.',
  },
];

export function parseDemoParams(search) {
  const raw = String(search || '');
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const name = (params.get('demo') || '').trim();
  const rawSpeed = Number(params.get('speed'));
  const speed = Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : 1;
  const autostart = params.get('autostart') === '1';
  const cue = (params.get('cue') || '').trim();
  return { name, speed, autostart, cue };
}

export function demoScriptUrl(name) {
  const id = String(name || '').trim();
  if (!id || !DEMO_NAME_RE.test(id)) return null;
  return `/demo/${id}.json`;
}

export function scriptLines(script) {
  return (script?.events || [])
    .filter((ev) => ev && (ev.type === 'incoming' || ev.type === 'outgoing'))
    .map((ev) => ({ role: ev.type, text: ev.text }));
}

export function isSummaryEvent(ev) {
  return ev?.type === 'incoming' && String(ev.text || '').includes(SUMMARY_HEADING);
}

export function isLongOwnerEvent(ev) {
  return ev?.type === 'outgoing' && String(ev.text || '').startsWith(LONG_OWNER_PREFIX);
}

/** Mid-typing slice: long enough to grow the composer to several lines. */
export function typingCuePrefix(text) {
  const full = String(text || '');
  const cut = full.indexOf("We're open");
  if (cut > 40) return full.slice(0, cut);
  return full.slice(0, Math.min(160, full.length));
}

/**
 * Natural per-character delay. Faster inside words, pauses after
 * punctuation, occasional brief hesitation.
 */
export function charDelayMs(char, index, text, rng = Math.random) {
  const next = text[index + 1] || '';
  const roll = () => {
    const x = rng();
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
  };

  let ms = 36 + roll() * 32;
  const wordChar = /[A-Za-z0-9']/;
  if (wordChar.test(char) && wordChar.test(next)) {
    ms *= 0.68;
  }

  if (/[.!?]/.test(char)) {
    ms += 200 + roll() * 140;
  } else if (/[,;:]/.test(char)) {
    ms += 100 + roll() * 80;
  } else if (char === '\n') {
    ms += 160 + roll() * 100;
  } else if (char === ' ') {
    ms += 18 + roll() * 36;
  }

  if (index > 12 && roll() < 0.035) {
    ms += 140 + roll() * 200;
  }

  return ms;
}

/** Pause before the header shows "typing…". */
export function incomingThinkMs(text) {
  const n = String(text || '').length;
  return Math.min(900, Math.max(380, 280 + n * 2));
}

/** How long the header stays on "typing…", scaled to reply length. */
export function incomingTypingMs(text) {
  const n = String(text || '').length;
  return Math.min(3800, Math.max(850, 420 + n * 24));
}

/** Beat after a bubble so the line is readable on video. */
export function readPauseMs(text) {
  const n = String(text || '').length;
  return Math.min(2600, Math.max(520, 400 + n * 14));
}

export function afterSendPauseMs() {
  return 420;
}

export function createController() {
  return {
    paused: false,
    aborted: false,
    started: false,
    generation: 0,
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    togglePause() {
      this.paused = !this.paused;
    },
    abort() {
      this.aborted = true;
    },
  };
}

export async function sleepMs(ms, opts = {}) {
  const {
    speed = 1,
    controller = null,
    wait = (t) => new Promise((r) => setTimeout(r, t)),
  } = opts;
  const factor = speed > 0 ? speed : 1;
  const target = Math.max(0, Number(ms) || 0) / factor;
  const start = Date.now();
  while (Date.now() - start < target) {
    if (controller?.aborted) return;
    while (controller?.paused && !controller.aborted) {
      await wait(40);
    }
    if (controller?.aborted) return;
    const left = target - (Date.now() - start);
    await wait(Math.min(40, Math.max(0, left)));
  }
}

export async function loadDemoScript(name, fetchFn = fetch) {
  const url = demoScriptUrl(name);
  if (!url) return null;
  const res = await fetchFn(url);
  if (!res || !res.ok) return null;
  return res.json();
}

function emptyUi() {
  return {};
}

export function applyCue(script, cue, ui = emptyUi()) {
  ui.reset?.();
  const name = String(cue || '').trim() || 'idle';
  if (name === 'idle') return { cue: 'idle' };

  const events = script?.events || [];
  for (const ev of events) {
    if (name === 'typing-long-owner' && isLongOwnerEvent(ev)) {
      const prefix = typingCuePrefix(ev.text);
      ui.setInput?.(prefix);
      return { cue: name, input: prefix };
    }
    if (ev.type === 'chip') {
      ui.addChip?.(ev.text);
    } else if (ev.type === 'incoming') {
      ui.addMsg?.('assistant', ev.text, { instantRead: true, smooth: false });
    } else if (ev.type === 'outgoing') {
      ui.addMsg?.('user', ev.text, { instantRead: true, smooth: false });
    }
    if (name === 'summary' && isSummaryEvent(ev)) {
      ui.scrollToBottom?.(false);
      return { cue: name };
    }
  }
  ui.scrollToBottom?.(false);
  return { cue: 'final' };
}

async function typeOutgoing(text, ctx) {
  const { ui, speed, controller, rng } = ctx;
  ui.beginTyping?.();
  for (let i = 0; i < text.length; i++) {
    if (controller?.aborted) return;
    await sleepMs(charDelayMs(text[i], i, text, rng), { speed, controller, wait: ctx.wait });
    ui.setInput?.(text.slice(0, i + 1));
  }
  await sleepMs(220, { speed, controller, wait: ctx.wait });
  ui.pressSend?.();
  await sleepMs(110, { speed, controller, wait: ctx.wait });
  ui.releaseSend?.();
  ui.setInput?.('');
  ui.addMsg?.('user', text);
  ui.scrollToBottom?.();
}

export async function playScript(script, ctx = {}) {
  const speed = ctx.speed > 0 ? ctx.speed : 1;
  const controller = ctx.controller || createController();
  const ui = ctx.ui || emptyUi();
  const rng = ctx.rng || Math.random;
  const wait = ctx.wait;
  const playCtx = { ui, speed, controller, rng, wait };
  const events = script?.events || [];

  for (const ev of events) {
    if (controller.aborted) return;
    if (ev.type === 'chip') {
      ui.addChip?.(ev.text);
      ui.scrollToBottom?.();
      await sleepMs(560, { speed, controller, wait });
    } else if (ev.type === 'incoming') {
      await sleepMs(incomingThinkMs(ev.text), { speed, controller, wait });
      ui.setSubtitle?.('typing…');
      await sleepMs(incomingTypingMs(ev.text), { speed, controller, wait });
      ui.addMsg?.('assistant', ev.text);
      ui.setSubtitle?.('online');
      ui.scrollToBottom?.();
      await sleepMs(readPauseMs(ev.text), { speed, controller, wait });
    } else if (ev.type === 'outgoing') {
      await typeOutgoing(ev.text, playCtx);
      await sleepMs(afterSendPauseMs(), { speed, controller, wait });
    }
  }
  ui.finish?.();
}

function isSpaceKey(e) {
  return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
}

function waitForGesture(controller, { autostart, document: doc }) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (started) => {
      if (settled) return;
      settled = true;
      if (started) controller.started = true;
      root?.removeEventListener('pointerdown', onPointer);
      controller._startWithGesture = null;
      controller._cancelWait = null;
      resolve();
    };
    const onPointer = () => finish(true);
    controller._startWithGesture = () => finish(true);
    controller._cancelWait = () => finish(false);

    if (autostart) {
      setTimeout(() => finish(true), 2000);
      return;
    }
    if (!root) {
      finish(true);
      return;
    }
    root.addEventListener('pointerdown', onPointer);
  });
}

/**
 * Browser entry: load the named script and play, or jump to a still cue.
 * Tap/click or Space starts (after ~1s). autostart=1 waits 2s.
 * Space pauses/resumes after start. R restarts from a clean idle screen.
 */
export async function startDemoPlayback(opts) {
  const ui = opts.ui;
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const script = await loadDemoScript(opts.name, opts.fetchFn);
  if (!script) return { ok: false, reason: 'missing-script' };

  if (opts.cue && opts.cue !== 'idle') {
    applyCue(script, opts.cue, ui);
    return { ok: true, cue: opts.cue };
  }
  if (opts.cue === 'idle') {
    ui.reset?.();
    return { ok: true, cue: 'idle' };
  }

  const controller = createController();
  let running = false;

  const run = async () => {
    const gen = ++controller.generation;
    controller.aborted = false;
    controller.paused = false;
    controller.started = false;
    ui.reset?.();
    await waitForGesture(controller, { autostart: opts.autostart, document: doc });
    if (controller.generation !== gen) return;
    // Start delay is wall-clock so a recording cue stays predictable.
    await sleepMs(opts.autostart ? 0 : 1000, { speed: 1, controller, wait: opts.wait });
    if (controller.generation !== gen) return;
    running = true;
    await playScript(script, {
      ui,
      speed: opts.speed,
      controller,
      rng: opts.rng,
      wait: opts.wait,
    });
    if (controller.generation === gen) running = false;
  };

  if (doc && !doc.__easybotDemoKeys) {
    doc.__easybotDemoKeys = true;
    doc.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (isSpaceKey(e)) {
        e.preventDefault();
        if (!controller.started) {
          controller._startWithGesture?.();
          return;
        }
        if (running || controller.paused) controller.togglePause();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        controller.abort();
        controller._cancelWait?.();
        run();
      }
    });
  }

  await run();
  return { ok: true };
}
