import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHubspotSignature } from './webhook.js';

const CLIENT_SECRET = 'super-secret-app-client-secret';

function makeSignature(method: string, uri: string, body: string, timestamp: string): string {
  return createHmac('sha256', CLIENT_SECRET)
    .update(`${method}${uri}${body}${timestamp}`, 'utf8')
    .digest('base64');
}

describe('verifyHubspotSignature', () => {
  const now = 1_700_000_000_000;
  const timestamp = String(now - 60_000); // 1 minute ago
  const method = 'POST';
  const uri = 'https://example.com/webhooks/hubspot';
  const body = JSON.stringify([{ eventId: 1, subscriptionType: 'contact.creation' }]);

  it('accepts a valid signature', () => {
    const sig = makeSignature(method, uri, body, timestamp);
    const result = verifyHubspotSignature({
      method,
      uri,
      rawBody: body,
      signatureHeader: sig,
      timestampHeader: timestamp,
      clientSecret: CLIENT_SECRET,
      now,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects missing signature header', () => {
    const result = verifyHubspotSignature({
      method,
      uri,
      rawBody: body,
      signatureHeader: undefined,
      timestampHeader: timestamp,
      clientSecret: CLIENT_SECRET,
      now,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects missing timestamp header', () => {
    const sig = makeSignature(method, uri, body, timestamp);
    const result = verifyHubspotSignature({
      method,
      uri,
      rawBody: body,
      signatureHeader: sig,
      timestampHeader: undefined,
      clientSecret: CLIENT_SECRET,
      now,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_timestamp' });
  });

  it('rejects timestamp older than 5 minutes (replay protection)', () => {
    const staleTs = String(now - 10 * 60 * 1000);
    const sig = makeSignature(method, uri, body, staleTs);
    const result = verifyHubspotSignature({
      method,
      uri,
      rawBody: body,
      signatureHeader: sig,
      timestampHeader: staleTs,
      clientSecret: CLIENT_SECRET,
      now,
    });
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects signature computed with wrong secret', () => {
    const sigWithWrongSecret = createHmac('sha256', 'wrong-secret')
      .update(`${method}${uri}${body}${timestamp}`, 'utf8')
      .digest('base64');
    const result = verifyHubspotSignature({
      method,
      uri,
      rawBody: body,
      signatureHeader: sigWithWrongSecret,
      timestampHeader: timestamp,
      clientSecret: CLIENT_SECRET,
      now,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects signature when body has been tampered with', () => {
    const sig = makeSignature(method, uri, body, timestamp);
    const tamperedBody = body.replace('contact.creation', 'contact.deletion');
    const result = verifyHubspotSignature({
      method,
      uri,
      rawBody: tamperedBody,
      signatureHeader: sig,
      timestampHeader: timestamp,
      clientSecret: CLIENT_SECRET,
      now,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});
