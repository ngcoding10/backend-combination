// Cloud Functions for every app in this project. Naming: <app><Action>.
// Secrets (one Claude API key per app) live in Secret Manager; limits are deploy-time settings.
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten, onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineInt, defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { claudeAsk, firestoreMeter, publicError } from './src/ai.js';
import { UserFacingError } from './src/errors.js';
import { handleCheckLabel, handleGenerateRecipe } from './src/pantry.js';
import { handleMatchFilms } from './src/movi-match.js';
import { onActivityDeleted, onCommentWritten, onFollowWritten, onLikeWritten, onRecCreated } from './src/movi-social.js';
import { rebuildStats } from './src/movi-stats.js';
import { deleteMyData } from './src/account.js';

initializeApp();
const db = getFirestore();
const REGION = 'us-central1';
const EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';

const PANTRY_ANTHROPIC_KEY = defineSecret('PANTRY_ANTHROPIC_KEY');
const MOVI_ANTHROPIC_KEY = defineSecret('MOVI_ANTHROPIC_KEY');
const PANTRY_DAILY_PER_USER = defineInt('PANTRY_DAILY_PER_USER', { default: 8, description: 'The Pantry: AI requests each person may make per day' });
const PANTRY_DAILY_TOTAL = defineInt('PANTRY_DAILY_TOTAL', { default: 100, description: 'The Pantry: AI requests for everyone per day (the spending cap)' });
const MOVI_DAILY_PER_USER = defineInt('MOVI_DAILY_PER_USER', { default: 15, description: 'Movi: AI title-matching requests each person may make per day' });
const MOVI_DAILY_TOTAL = defineInt('MOVI_DAILY_TOTAL', { default: 200, description: 'Movi: AI requests for everyone per day (the spending cap)' });

// Only pages on these addresses may call the functions, and (outside the emulator) only with a
// valid App Check token, which proves the request came from the real site and not a script.
const CORS = [/^https:\/\/ngcoding10\.github\.io$/, /^https:\/\/ascoding11\.github\.io$/, /^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
const callable = { region: REGION, cors: CORS, enforceAppCheck: !EMULATOR, maxInstances: 5, concurrency: 20 };
const ai = (secret) => ({ ...callable, secrets: [secret], timeoutSeconds: 120, memory: '512MiB' });

const meter = firestoreMeter(db, FieldValue);
// In the emulator, with no real key, the model is replaced by a canned answer (tests only).
const asker = (secret, app) => (EMULATOR && process.env.FAKE_AI === '1')
  ? async ({ schema }) => (await import('./test/fake-model.js')).fakeAnswer(schema, app)
  : claudeAsk({ apiKey: secret.value(), log: (usage) => logger.info('anthropic usage', { app, ...usage }) });

async function run(name, fn) {
  try {
    return await fn();
  } catch (e) {
    const { code, message } = publicError(e);
    if (!(e instanceof UserFacingError)) logger.error(`${name} failed`, { status: e?.status, message: e?.message });
    throw new HttpsError(code, message);
  }
}

// ───────── The Pantry ─────────
const pantryDeps = () => ({ ask: asker(PANTRY_ANTHROPIC_KEY, 'pantry'), meter, limits: { perUser: PANTRY_DAILY_PER_USER.value(), total: PANTRY_DAILY_TOTAL.value() } });
export const pantryGenerateRecipe = onCall(ai(PANTRY_ANTHROPIC_KEY), (req) => run('pantryGenerateRecipe', () => handleGenerateRecipe(req.auth?.uid, req.data, pantryDeps())));
export const pantryCheckLabel = onCall(ai(PANTRY_ANTHROPIC_KEY), (req) => run('pantryCheckLabel', () => handleCheckLabel(req.auth?.uid, req.data, pantryDeps())));

// ───────── Movi ─────────
const moviDeps = () => ({ ask: asker(MOVI_ANTHROPIC_KEY, 'movi'), meter, limits: { perUser: MOVI_DAILY_PER_USER.value(), total: MOVI_DAILY_TOTAL.value() } });
export const moviMatchFilms = onCall(ai(MOVI_ANTHROPIC_KEY), (req) => run('moviMatchFilms', () => handleMatchFilms(req.auth?.uid, req.data, moviDeps())));

const trigger = (document) => ({ document, region: REGION, maxInstances: 5 });
const ev = (e) => ({ before: e.data?.before?.data?.() ?? undefined, after: (e.data?.after ?? e.data)?.data?.() ?? undefined, id: Object.values(e.params)[0], now: new Date(e.time) });
export const moviOnLike = onDocumentWritten(trigger('movi_likes/{id}'), (e) => onLikeWritten(db, { ...ev(e), before: e.data.before.data(), after: e.data.after.data() }));
export const moviOnComment = onDocumentWritten(trigger('movi_comments/{id}'), (e) => onCommentWritten(db, { ...ev(e), before: e.data.before.data(), after: e.data.after.data() }));
export const moviOnFollow = onDocumentWritten(trigger('movi_follows/{id}'), (e) => onFollowWritten(db, { ...ev(e), after: e.data.after.data() }));
export const moviOnRec = onDocumentCreated(trigger('movi_recs/{id}'), (e) => onRecCreated(db, { after: e.data.data(), id: e.params.id, now: new Date(e.time) }));
export const moviOnActivityDeleted = onDocumentDeleted(trigger('movi_activities/{id}'), (e) => onActivityDeleted(db, { id: e.params.id }));

// Site-wide averages and the top list, rebuilt hourly (and only when someone ranked something).
export const moviRebuildStats = onSchedule({ schedule: 'every 60 minutes', region: REGION, timeoutSeconds: 300, memory: '512MiB', maxInstances: 1 }, async () => {
  logger.info('movi stats', await rebuildStats(db));
});

// ───────── Shared ─────────
export const accountDeleteMyData = onCall({ ...callable, timeoutSeconds: 120 }, (req) => run('accountDeleteMyData', () => deleteMyData({ db, auth: getAuth(), FieldValue }, req.auth?.uid, req.data?.app)));
