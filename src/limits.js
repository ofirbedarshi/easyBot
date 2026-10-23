/**
 * Demo usage caps (server-side). Defaults keep personal WhatsApp demos cheap.
 */

export function maxMessageChars() {
  return Number(process.env.DEMO_MAX_MSG_CHARS) || 2000;
}

export function maxMsgsPerSenderPerHour() {
  return Number(process.env.DEMO_MAX_MSGS_PER_SENDER_PER_HOUR) || 30;
}

export function maxMsgsPerSenderPerDay() {
  return Number(process.env.DEMO_MAX_MSGS_PER_SENDER_PER_DAY) || 100;
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
