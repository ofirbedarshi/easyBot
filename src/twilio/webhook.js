import express from 'express';
import {
  validateTwilioSignature,
  resolveWebhookUrl,
} from './validate.js';
import { emptyTwiml } from './send.js';
import { checkMessageLength } from '../limits.js';
import { phoneE164FromSenderId } from '../phone.js';

/**
 * Fast ingest: validate signature → durable enqueue → empty TwiML.
 * Long AI work happens in the worker, not in this request.
 *
 * @param {object} store
 */
export function createTwilioWhatsAppRouter(store) {
  const router = express.Router();

  // Twilio sends application/x-www-form-urlencoded
  router.post(
    '/whatsapp',
    express.urlencoded({ extended: false }),
    async (req, res) => {
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const signature = req.get('X-Twilio-Signature') || undefined;
      const webhookUrl = resolveWebhookUrl(req);
      // All received form params (Twilio may add fields without notice)
      const params = { ...req.body };

      const check = validateTwilioSignature({
        authToken,
        signature,
        webhookUrl,
        params,
      });
      if (!check.ok) {
        console.warn('Twilio signature rejected:', check.reason);
        return res.status(403).type('text/plain').send('Forbidden');
      }

      const messageSid = params.MessageSid || params.SmsSid;
      const from = params.From;
      const body = params.Body ?? '';

      if (!messageSid || !from || !phoneE164FromSenderId(from)) {
        return res.status(400).type('text/plain').send('Bad Request');
      }

      // Soft length check at ingest — still enqueue short reject reply via worker
      // if over limit; here we only reject completely empty sid/from.

      try {
        const { inserted } = await store.enqueueInbound({
          messageSid,
          senderId: from,
          body: String(body),
        });
        if (!inserted) {
          // Duplicate MessageSid (Twilio retry) — ACK without re-processing
          return res.status(200).type('text/xml').send(emptyTwiml());
        }
      } catch (err) {
        console.error('enqueueInbound failed:', err.message);
        // 500 so Twilio retries; MessageSid unique prevents double-process once inserted
        return res.status(500).type('text/plain').send('Error');
      }

      return res.status(200).type('text/xml').send(emptyTwiml());
    }
  );

  return router;
}

export { checkMessageLength };
