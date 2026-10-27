/**
 * Demo usage caps (server-side). Defaults keep personal WhatsApp demos cheap.
 */

import { E164_RE } from './phone.js';

export const BURST_LIMIT_REPLY =
  "You're sending a bit fast. Wait a few minutes and try again.";

/**
 * E.164 from a sender id or env list entry.
 * Tolerates surrounding whitespace and an optional `whatsapp:` prefix.
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeLimitsSender(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const rest = raw.toLowerCase().startsWith('whatsapp:')
    ? raw.slice('whatsapp:'.length).trim()
    : raw;
  return E164_RE.test(rest) ? rest : null;
}

/**
 * Comma-separated E.164 phones in LIMITS_EXEMPT_SENDERS.
 * Unset or empty env means no exemptions. Invalid entries are ignored.
 * @param {string} [envValue]
 * @returns {string[]}
 */
export function parseLimitsExemptSenders(
  envValue = process.env.LIMITS_EXEMPT_SENDERS
) {
  if (envValue == null || String(envValue).trim() === '') return [];
  return String(envValue)
    .split(',')
    .map((part) => normalizeLimitsSender(part))
    .filter(Boolean);
}

/**
 * Hourly / daily / burst volume caps are skipped for listed senders.
 * The per-message character cap still applies.
 * @param {string} senderId
 * @param {string} [envValue]
 */
export function isLimitsExemptSender(
  senderId,
  envValue = process.env.LIMITS_EXEMPT_SENDERS
) {
  const phone = normalizeLimitsSender(senderId);
  if (!phone) return false;
  return parseLimitsExemptSenders(envValue).includes(phone);
}

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
