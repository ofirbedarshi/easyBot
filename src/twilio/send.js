import twilio from 'twilio';

/**
 * Send WhatsApp reply via Messages API (after webhook ACK).
 * Throws on failure so the worker does not mark messages done without delivery.
 * @returns {Promise<{ sid: string }>}
 */
export async function sendWhatsAppReply({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!accountSid || !authToken || !from) {
    throw new Error(
      'Twilio outbound not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM)'
    );
  }
  if (!body) {
    throw new Error('Twilio outbound skipped: empty body');
  }
  const client = twilio(accountSid, authToken);
  try {
    const msg = await client.messages.create({
      from,
      to,
      body: String(body).slice(0, 1600),
    });
    if (!msg?.sid) {
      throw new Error('Twilio messages.create returned no MessageSid');
    }
    return { sid: msg.sid };
  } catch (err) {
    const code = err.code != null ? ` code=${err.code}` : '';
    console.error(`Twilio outbound failed${code}:`, err.message);
    throw err;
  }
}

/** Empty TwiML — acknowledge webhook without inline reply. */
export function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}
