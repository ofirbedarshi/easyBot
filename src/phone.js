/**
 * WhatsApp / Twilio sender id → E.164. No guessing: invalid input is null.
 */

const E164_RE = /^\+[1-9][0-9]{7,14}$/;

/**
 * @param {string} senderId Twilio From, e.g. whatsapp:+15551234567 or +15551234567
 * @returns {string|null} E.164 or null
 */
export function phoneE164FromSenderId(senderId) {
  const raw = String(senderId || '').trim();
  if (!raw) return null;
  const rest = raw.toLowerCase().startsWith('whatsapp:')
    ? raw.slice('whatsapp:'.length)
    : raw;
  return E164_RE.test(rest) ? rest : null;
}

export { E164_RE };
