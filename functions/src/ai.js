// Everything the AI functions share: one metered, structured Claude call.
// Each app has its own API key (a secret) and its own daily limits, so one app
// can never spend another app's budget.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { UserFacingError } from './errors.js';

export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * Daily counters in Firestore: ai_usage/{app}_{day}_{uid} and ai_usage/{app}_{day}_total.
 * Clients cannot read or write this collection (see firestore.rules).
 */
export function firestoreMeter(db, FieldValue) {
  const refs = (app, uid, day) => [db.doc(`ai_usage/${app}_${day}_${uid}`), db.doc(`ai_usage/${app}_${day}_total`)];
  // counters delete themselves after a week (TTL on expireAt, see firestore.indexes.json)
  const expireAt = () => new Date(Date.now() + 7 * 86400_000);
  return {
    /** Count one request; throws resource-exhausted when a limit is reached. */
    async consume(app, uid, { perUser, total }) {
      const day = utcDay();
      const [userRef, totalRef] = refs(app, uid, day);
      return db.runTransaction(async (tx) => {
        const [u, t] = await Promise.all([tx.get(userRef), tx.get(totalRef)]);
        const used = u.get('count') ?? 0;
        const all = t.get('count') ?? 0;
        if (used >= perUser) throw new UserFacingError('resource-exhausted', `You have used all ${perUser} AI requests for today. They reset at midnight UTC.`);
        if (all >= total) throw new UserFacingError('resource-exhausted', 'This app has reached its AI limit for today. Try again tomorrow.');
        tx.set(userRef, { app, uid, day, count: used + 1, expireAt: expireAt() }, { merge: true });
        tx.set(totalRef, { app, day, count: all + 1, expireAt: expireAt() }, { merge: true });
        return { used: used + 1, limit: perUser };
      });
    },
    /** Give the request back when the model call failed. */
    async refund(app, uid) {
      const [userRef, totalRef] = refs(app, uid, utcDay());
      await Promise.all([
        userRef.set({ count: FieldValue.increment(-1) }, { merge: true }),
        totalRef.set({ count: FieldValue.increment(-1) }, { merge: true }),
      ]);
    },
  };
}

/** Run `fn` only if the caller is signed in and under the limits; refund if it fails. */
export async function metered({ app, uid, limits, meter }, fn) {
  if (!uid) throw new UserFacingError('unauthenticated', 'Sign in first.');
  const usage = await meter.consume(app, uid, limits);
  try {
    return { value: await fn(), usage };
  } catch (e) {
    await meter.refund(app, uid).catch(() => {});
    throw e;
  }
}

/**
 * One Claude call that returns an object matching `schema` (Zod).
 * `fallbacks: "default"` lets the API retry on another model if this one declines.
 */
export function claudeAsk({ apiKey, log = () => {} }) {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return async function ask({ model, effort, schema, system, content, maxTokens }) {
    const res = await client.beta.messages.parse({
      model,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
    });
    log({ model: res.model, input: res.usage?.input_tokens, output: res.usage?.output_tokens, stop: res.stop_reason });
    if (res.stop_reason === 'refusal') throw new UserFacingError('failed-precondition', 'The model declined this request. Try different wording.');
    if (res.stop_reason === 'max_tokens') throw new UserFacingError('internal', 'The answer was cut off. Try again.');
    if (!res.parsed_output) throw new UserFacingError('internal', 'The model did not return the expected format. Try again.');
    return res.parsed_output;
  };
}

/** Turn any failure into a { code, message } the app can show. Never leaks internals. */
export function publicError(e) {
  if (e instanceof UserFacingError) return { code: e.code, message: e.message };
  if (e instanceof Anthropic.RateLimitError) return { code: 'unavailable', message: 'The AI service is busy. Try again in a minute.' };
  if (e instanceof Anthropic.BadRequestError && /credit|billing/i.test(e.message ?? '')) return { code: 'failed-precondition', message: 'AI is switched off for now. Try again later.' };
  if (e instanceof Anthropic.APIError && (e.status === 529 || e.status === 503)) return { code: 'unavailable', message: 'The AI service is busy. Try again in a minute.' };
  return { code: 'internal', message: 'The AI request failed. Try again.' };
}

export const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
