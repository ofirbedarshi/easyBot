import twilio from 'twilio';

/**
 * Validate X-Twilio-Signature per Twilio docs:
 * Auth Token + exact public URL + all form params.
 *
 * @param {object} opts
 * @param {string} opts.authToken
 * @param {string|undefined} opts.signature
 * @param {string} opts.webhookUrl - full public URL Twilio POSTed to (no fragment)
 * @param {Record<string, string>} opts.params - all received form fields
 */
export function validateTwilioSignature({
  authToken,
  signature,
  webhookUrl,
  params,
}) {
  if (!authToken) {
    return { ok: false, reason: 'TWILIO_AUTH_TOKEN not configured' };
  }
  if (!signature) {
    return { ok: false, reason: 'missing X-Twilio-Signature' };
  }
  if (!webhookUrl) {
    return { ok: false, reason: 'PUBLIC_BASE_URL / webhook URL not configured' };
  }
  const valid = twilio.validateRequest(
    authToken,
    signature,
    webhookUrl,
    params || {}
  );
  if (!valid) {
    return { ok: false, reason: 'invalid signature' };
  }
  return { ok: true };
}

/**
 * Build the exact URL Twilio used for signing (scheme + host + path + query).
 * Prefer PUBLIC_BASE_URL so proxies / Render host headers stay consistent.
 */
export function resolveWebhookUrl(req, pathSuffix = '/webhooks/twilio/whatsapp') {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (base) {
    const q = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    // If originalUrl already includes path, prefer pathSuffix + query from request
    const pathOnly = req.path || pathSuffix;
    const query =
      req.url && req.url.includes('?')
        ? req.url.slice(req.url.indexOf('?'))
        : q && !pathOnly.includes('?')
          ? q
          : '';
    return `${base}${pathSuffix}${query}`;
  }
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${req.originalUrl}`;
}
