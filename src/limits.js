/**
 * Demo usage caps (server-side). Defaults keep personal WhatsApp demos cheap.
 */

export const BURST_LIMIT_REPLY =
  "You're sending a bit fast. Wait a few minutes and try again.";

export function maxMessageChars() {
  return Number(process.env.DEMO_MAX_MSG_CHARS) || 1000;
}

export function maxMsgsPerSenderPerHour() {
  return Number(process.env.DEMO_MAX_MSGS_PER_SENDER_PER_HOUR) || 30;
}

export function maxMsgsPerSenderPerDay() {
  return Number(process.env.DEMO_MAX_MSGS_PER_SENDER_PER_DAY) || 100;
}

export function maxMsgsPerSenderPerBurst() {
  return Number(process.env.DEMO_MAX_MSGS_PER_SENDER_PER_BURST) || 10;
}

export function burstWindowMs() {
  return (Number(process.env.DEMO_BURST_WINDOW_MINUTES) || 10) * 60 * 1000;
}

/**
 * @param {string} body
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function checkMessageLength(body) {
  const text = String(body ?? '');
  const max = maxMessageChars();
  if (text.length > max) {
    return {
      ok: false,
      reason: `Message too long (max ${max} characters).`,
    };
  }
  return { ok: true, text };
}

/**
 * @param {number} count messages from this sender in the burst window (including current)
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkSenderBurst(count) {
  if (count > maxMsgsPerSenderPerBurst()) {
    return { ok: false, reason: BURST_LIMIT_REPLY };
  }
  return { ok: true };
}
