import twilio from 'twilio';

/**
 * Send WhatsApp reply via Messages API (after webhook ACK).
 * @returns {Promise<{ sid: string } | null>}
 */
export async function sendWhatsAppReply({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!accountSid || !authToken || !from) {
    console.warn('Twilio outbound skipped: TWILIO_ACCOUNT_SID / AUTH_TOKEN / WHATSAPP_FROM missing');
    return null;
  }
  if (!body) return null;
  const client = twilio(accountSid, authToken);
  const msg = await client.messages.create({
    from,
    to,
    body: String(body).slice(0, 1600),
  });
  return { sid: msg.sid };
}

/** Empty TwiML — acknowledge webhook without inline reply. */
export function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}
