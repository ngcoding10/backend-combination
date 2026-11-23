// Admin connections for the one-off data moves. Credentials come from environment variables
// (GitHub Actions secrets); nothing here is ever written to the repo or the logs.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

export { FieldValue, Timestamp };

/** @param envName name of the env var holding a service-account JSON key */
export function connect(envName, label) {
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} is not set`);
  const key = JSON.parse(raw);
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, label);
  return { projectId: key.project_id, auth: getAuth(app), db: getFirestore(app) };
}

export const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;

/** Keep a private copy of everything that was read, inside the new project (admin-only collection). */
export async function saveBackup(db, name, data) {
  const json = JSON.stringify(data);
  const size = 800_000, parts = Math.ceil(json.length / size) || 1;
  const id = `${name}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (let i = 0; i < parts; i++) await db.doc(`_migration_backups/${id}_${String(i).padStart(3, '0')}`).set({ name, part: i, parts, json: json.slice(i * size, (i + 1) * size), at: new Date() });
  return { id, parts, bytes: json.length };
}

/** Give each person a username that is valid and not taken; returns Map<uid, username>. */
export async function settleUsernames(db, wanted /* Array<{uid, username, fallback}> */) {
  const out = new Map(), taken = new Map();
  for (const { uid, username, fallback } of wanted) {
    const existing = await db.doc(`accounts/${uid}`).get();
    if (existing.exists) { out.set(uid, existing.get('username')); continue; } // already has one (from another app)
    let base = String(username || fallback || 'user').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20);
    if (base.length < 3) base = `user${base}`.slice(0, 20);
    let name = base;
    for (let i = 0; ; i++) {
      const owner = taken.get(name) ?? (await db.doc(`usernames/${name}`).get()).get('uid');
      if (!owner || owner === uid) break;
      name = `${base.slice(0, 16)}${1000 + Math.floor(Math.random() * 9000)}`;
      if (i > 50) throw new Error('could not find a free username');
    }
    taken.set(name, uid); out.set(uid, name);
  }
  return out;
}

/** Create Auth users in the new project with the SAME ids, skipping ones that already exist. */
export async function importUsers(auth, users) {
  const fresh = [];
  for (const u of users) {
    try { await auth.getUser(u.uid); } catch { fresh.push(u); }
  }
  if (!fresh.length) return { imported: 0, skipped: users.length, errors: 0 };
  const res = await auth.importUsers(fresh);
  return { imported: res.successCount, skipped: users.length - fresh.length, errors: res.failureCount, errorCodes: res.errors.map((e) => e.error.code) };
}
