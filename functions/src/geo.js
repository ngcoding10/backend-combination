// GeoHistory: reader suggestions ("something we missed") and the owner's admin view of them.
// The website (github.com/ngcoding10/geohistory) has no sign-in for readers: anyone can send a
// suggestion. What keeps scripts out: App Check (once enforced), a honeypot field, a minimum time on
// the form, a daily cap per network address (kept only as a salted one-day hash) and one for everyone.
// Suggestions live in geo_suggestions/{id}, which no browser can read or write (see firestore.rules).
// Only uids on the admin list (functions/admins.json, plus the server-only doc config/admins) can
// list, update or delete them, through geoAdminSuggestions.
import * as z from 'zod/v4';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { UserFacingError } from './errors.js';

export const STATUSES = ['new', 'reviewing', 'added', 'rejected'];
export const SUBJECT_KINDS = ['polity', 'empire', 'event', 'us', 'colony', 'modern'];
export const LIMITS = { perIp: 6, total: 300 };    // suggestions per network address, and for everyone, per UTC day
export const MIN_FORM_MS = 3000;                     // a person needs at least this long to write something
export const TEXT_MIN = 10, TEXT_MAX = 2000;

// ───────── input checks ─────────
const tidy = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').trim();
const oneLine = (s) => tidy(s).replace(/\s+/g, ' ');
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
const ID = /^[^<>{}`\\]{1,120}$/; // names of states can hold almost anything (Ma’in, Kush/Nubia); not markup

const SuggestInput = z.strictObject({
  text: z.string().max(TEXT_MAX + 200),
  place: z.string().max(200).optional(),
  date: z.string().max(80).optional(),
  year: z.number().int().min(-10000).max(2100).nullable().optional(),
  subject: z.strictObject({
    kind: z.enum(SUBJECT_KINDS),
    id: z.string().max(200),
    name: z.string().max(200).optional(),
  }).nullable().optional(),
  sourceUrl: z.string().max(600).optional(),
  email: z.string().max(254).optional(),
  hp: z.string().max(500).optional(),        // the honeypot: a field people never see, so never fill
  ms: z.number().min(0).max(864e5).optional(), // milliseconds the form was open before sending
});

/** A source link: http(s) only, no credentials, a real-looking host. Returns the normalised URL or ''. */
export function checkUrl(s) {
  const v = oneLine(s);
  if (!v) return '';
  let u;
  try { u = new URL(v); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/^xn--/.test(u.hostname)) return null;
  const out = u.toString();
  return out.length <= 500 ? out : null;
}

const bad = (msg) => new UserFacingError('invalid-argument', msg);

/** Validate a suggestion from the browser. Returns { spam: true } for a filled honeypot, else the clean record. */
export function parseSuggestion(data) {
  const r = SuggestInput.safeParse(data ?? {});
  if (!r.success) throw bad('That suggestion was not understood. Reload the page and try again.');
  const v = r.data;
  if (tidy(v.hp)) return { spam: true };
  const text = tidy(v.text).replace(/\n{3,}/g, '\n\n');
  if (text.length < TEXT_MIN) throw bad(`Please write at least ${TEXT_MIN} characters about what happened.`);
  if (text.length > TEXT_MAX) throw bad(`Please keep it under ${TEXT_MAX.toLocaleString('en')} characters.`);
  if ((text.match(/\p{L}/gu) || []).length < 5) throw bad('Please describe what happened in words.');
  if ((text.match(/https?:\/\//gi) || []).length > 3) throw bad('Please put at most three links in the text; the source link has its own box.');
  const place = oneLine(v.place).slice(0, 120);
  const date = oneLine(v.date).slice(0, 60);
  const sourceUrl = checkUrl(v.sourceUrl);
  if (sourceUrl === null) throw bad('The source link does not look like a web address (it should start with https://).');
  const email = oneLine(v.email).toLowerCase();
  if (email && !EMAIL.test(email)) throw bad('The email address does not look right. It is optional: leave it empty if you like.');
  let subject = null;
  if (v.subject) {
    const id = oneLine(v.subject.id).slice(0, 120);
    if (!ID.test(id)) throw bad('That suggestion was not understood. Reload the page and try again.');
    subject = { kind: v.subject.kind, id, name: oneLine(v.subject.name ?? '').slice(0, 120) };
  }
  return { spam: false, ms: v.ms ?? 0, rec: { text, place, date, year: v.year ?? null, subject, sourceUrl, email } };
}

// ───────── the per-address key: a salted, one-day hash ─────────
/** The key the daily per-address cap is counted under. The address itself is never stored. */
export function ipKey(ip, day, salt) {
  return 'ip-' + createHash('sha256').update(`${salt}|${day}|${ip || 'unknown'}`).digest('hex').slice(0, 32);
}

/**
 * Send a suggestion. deps: { store, meter, day, limits? }
 * store: { salt(): Promise<string>, add(rec): Promise<string> }
 * meter: { consume(app, key, { perUser, total }) } (the shared daily counter in functions/src/ai.js)
 */
export async function handleSuggest(ip, data, deps) {
  const p = parseSuggestion(data);
  // a filled honeypot gets the same answer as a real suggestion, so a script learns nothing; nothing is kept
  if (p.spam) return { ok: true };
  if (p.ms < MIN_FORM_MS) throw new UserFacingError('failed-precondition', 'That was very quick. Take a moment to check it, then send it again.');
  const limits = deps.limits ?? LIMITS;
  try {
    await deps.meter.consume('geo_suggest', ipKey(ip, deps.day, await deps.store.salt()), { perUser: limits.perIp, total: limits.total });
  } catch (e) {
    if (e instanceof UserFacingError && e.code === 'resource-exhausted') {
      throw new UserFacingError('resource-exhausted', 'We cannot take more suggestions from here today. Thank you, and please try again tomorrow.');
    }
    throw e;
  }
  await deps.store.add({ ...p.rec, status: 'new', note: '' });
  return { ok: true };
}

// ───────── admin ─────────
/** The uids allowed into the admin view: functions/admins.json ("geohistory": [...]) plus config/admins in Firestore. */
export function fileAdmins(path = new URL('../admins.json', import.meta.url)) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return (Array.isArray(j.geohistory) ? j.geohistory : []).filter((u) => typeof u === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(u));
  } catch { return []; }
}

const AdminInput = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('list'),
    status: z.enum(STATUSES).nullable().optional(),
    yearFrom: z.number().int().min(-10000).max(2100).nullable().optional(),
    yearTo: z.number().int().min(-10000).max(2100).nullable().optional(),
    q: z.string().max(100).optional(),
    cursor: z.string().max(40).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({ action: z.literal('update'), id: z.string().regex(/^[A-Za-z0-9]{10,40}$/), status: z.enum(STATUSES).optional(), note: z.string().max(2000).optional() }),
  z.strictObject({ action: z.literal('delete'), id: z.string().regex(/^[A-Za-z0-9]{10,40}$/) }),
]);

export const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Does a suggestion pass the in-memory filters (year range, text search)? */
export function matches(s, { yearFrom = null, yearTo = null, q = '' }) {
  if (yearFrom != null && (s.year == null || s.year < yearFrom)) return false;
  if (yearTo != null && (s.year == null || s.year > yearTo)) return false;
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([s.text, s.place, s.date, s.subject?.name, s.subject?.id, s.sourceUrl, s.email, s.note].join(' '));
  return words.every((w) => hay.includes(w));
}

/**
 * The owner's view. deps: { store, admins(): Promise<string[]>, now? }
 * store: { page({ status, after, n }), counts(), update(id, fields), remove(id), exists(id) }
 */
export async function handleAdmin(uid, data, deps) {
  if (!uid) throw new UserFacingError('unauthenticated', 'Sign in first.');
  const allowed = await deps.admins();
  if (!allowed.includes(uid)) throw new UserFacingError('permission-denied', 'Not an admin.');
  const r = AdminInput.safeParse(data ?? {});
  if (!r.success) throw bad('That request was not understood.');
  const v = r.data;
  if (v.action === 'update') {
    if (v.status === undefined && v.note === undefined) throw bad('Nothing to change.');
    if (!(await deps.store.exists(v.id))) throw new UserFacingError('failed-precondition', 'That suggestion is gone (deleted?). Reload the list.');
    const fields = { updatedBy: uid };
    if (v.status !== undefined) fields.status = v.status;
    if (v.note !== undefined) fields.note = tidy(v.note).slice(0, 2000);
    await deps.store.update(v.id, fields);
    return { ok: true, id: v.id, ...(fields.status ? { status: fields.status } : {}), ...(fields.note !== undefined ? { note: fields.note } : {}) };
  }
  if (v.action === 'delete') {
    await deps.store.remove(v.id);
    return { ok: true, id: v.id };
  }
  // list: newest first, filtered by status in the query and by year and text here (the collection is small).
  const want = v.limit ?? 30;
  const filters = { yearFrom: v.yearFrom ?? null, yearTo: v.yearTo ?? null, q: v.q ?? '' };
  if (filters.yearFrom != null && filters.yearTo != null && filters.yearFrom > filters.yearTo) [filters.yearFrom, filters.yearTo] = [filters.yearTo, filters.yearFrom];
  const items = [];
  let after = v.cursor ?? null, scanned = 0, done = false;
  while (!done && items.length < want && scanned < 3000) {
    const batch = await deps.store.page({ status: v.status ?? null, after, n: 200 });
    let i = 0;
    for (; i < batch.length && items.length < want; i++) {
      scanned++;
      after = batch[i].id;
      if (matches(batch[i], filters)) items.push(batch[i]);
    }
    if (batch.length < 200 && i === batch.length) done = true;
  }
  return { items, cursor: done ? null : after, counts: await deps.store.counts() };
}

// ───────── the Firestore side (used by functions/index.js; tests use an in-memory store) ─────────
export function firestoreGeoStore(db, FieldValue) {
  const coll = db.collection('geo_suggestions');
  let salt = null;
  const out = (d) => {
    const x = d.data();
    return {
      id: d.id, text: x.text ?? '', place: x.place ?? '', date: x.date ?? '', year: x.year ?? null, subject: x.subject ?? null,
      sourceUrl: x.sourceUrl ?? '', email: x.email ?? '', status: x.status ?? 'new', note: x.note ?? '',
      createdAt: x.createdAt?.toMillis?.() ?? null, updatedAt: x.updatedAt?.toMillis?.() ?? null,
    };
  };
  return {
    /** A random salt made once and kept in config/geo_salt, which no browser can read. */
    async salt() {
      if (salt) return salt;
      const ref = db.doc('config/geo_salt');
      salt = await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.exists && typeof s.get('salt') === 'string') return s.get('salt');
        const v = randomBytes(32).toString('base64url');
        tx.set(ref, { salt: v, createdAt: FieldValue.serverTimestamp() });
        return v;
      });
      return salt;
    },
    async add(rec) {
      const doc = { ...rec, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
      if (!doc.email) delete doc.email;
      return (await coll.add(doc)).id;
    },
    async page({ status, after, n }) {
      let q = coll.orderBy('createdAt', 'desc');
      if (status) q = coll.where('status', '==', status).orderBy('createdAt', 'desc');
      if (after) { const a = await coll.doc(after).get(); if (a.exists) q = q.startAfter(a); }
      return (await q.limit(n).get()).docs.map(out);
    },
    async counts() {
      const [all, ...each] = await Promise.all([coll.count().get(), ...STATUSES.map((s) => coll.where('status', '==', s).count().get())]);
      return { all: all.data().count, ...Object.fromEntries(STATUSES.map((s, i) => [s, each[i].data().count])) };
    },
    async exists(id) { return (await coll.doc(id).get()).exists; },
    async update(id, fields) { await coll.doc(id).update({ ...fields, updatedAt: FieldValue.serverTimestamp() }); },
    async remove(id) { await coll.doc(id).delete(); },
    /** Uids on the admin list: the committed file plus config/admins { geohistory: [...] } (server-only). */
    async admins(fromFile = fileAdmins()) {
      const d = await db.doc('config/admins').get().catch(() => null);
      const extra = d?.exists && Array.isArray(d.get('geohistory')) ? d.get('geohistory').filter((u) => typeof u === 'string') : [];
      return [...new Set([...fromFile, ...extra])];
    },
  };
}
