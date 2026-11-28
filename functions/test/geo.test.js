// GeoHistory suggestions and the admin view, with an in-memory store and meter: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserFacingError } from '../src/errors.js';
import { checkUrl, fileAdmins, handleAdmin, handleSuggest, ipKey, matches, parseSuggestion, MIN_FORM_MS } from '../src/geo.js';

const code = (c) => (e) => e instanceof UserFacingError && e.code === c;

function memStore() {
  const docs = new Map();
  let n = 0;
  return {
    docs,
    async salt() { return 'test-salt'; },
    async add(rec) { const id = `s${String(++n).padStart(11, '0')}`; docs.set(id, { ...rec, id, createdAt: n }); return id; },
    async page({ status, after, n: lim }) {
      let all = [...docs.values()].filter((d) => !status || d.status === status).sort((a, b) => b.createdAt - a.createdAt);
      if (after) all = all.slice(all.findIndex((d) => d.id === after) + 1);
      return all.slice(0, lim);
    },
    async counts() { const c = { all: docs.size, new: 0, reviewing: 0, added: 0, rejected: 0 }; for (const d of docs.values()) c[d.status]++; return c; },
    async exists(id) { return docs.has(id); },
    async update(id, f) { docs.set(id, { ...docs.get(id), ...f }); },
    async remove(id) { docs.delete(id); },
  };
}
function memMeter() {
  const counts = new Map();
  return {
    counts,
    async consume(app, key, { perUser, total }) {
      const u = counts.get(key) ?? 0, t = counts.get('total') ?? 0;
      if (u >= perUser || t >= total) throw new UserFacingError('resource-exhausted', 'limit');
      counts.set(key, u + 1); counts.set('total', t + 1);
    },
  };
}
const good = { text: 'The Treaty of Paris ended the Seven Years War.', place: 'Paris', date: '10 February 1763', year: 1763, subject: { kind: 'polity', id: 'France', name: 'Kingdom of France' }, sourceUrl: 'https://en.wikipedia.org/wiki/Treaty_of_Paris_(1763)', email: '', hp: '', ms: 9000 };
const deps = (o = {}) => ({ store: memStore(), meter: memMeter(), day: '2026-11-28', limits: { perIp: 3, total: 5 }, ...o });

test('geo: suggestions are validated for length and shape', () => {
  const r = parseSuggestion({ ...good, text: '  The Treaty\u200b of Paris\r\n\n\n\nended it.  ', email: ' Me@Example.COM ' });
  assert.equal(r.rec.text, 'The Treaty of Paris\n\nended it.');
  assert.equal(r.rec.email, 'me@example.com');
  assert.deepEqual(r.rec.subject, { kind: 'polity', id: 'France', name: 'Kingdom of France' });
  for (const bad of [
    { ...good, text: 'too short' },
    { ...good, text: 'x'.repeat(2001) },
    { ...good, text: '1234567890 1234' },                              // no words
    { ...good, text: 'see https://a.com https://b.com https://c.com https://d.com please' },
    { ...good, sourceUrl: 'javascript:alert(1)' },
    { ...good, sourceUrl: 'ftp://example.com/x' },
    { ...good, sourceUrl: 'https://user:pw@example.com/' },
    { ...good, sourceUrl: 'not a link' },
    { ...good, email: 'nobody' },
    { ...good, email: 'a@b' },
    { ...good, year: 1763.5 },
    { ...good, year: 99999 },
    { ...good, subject: { kind: 'planet', id: 'Mars' } },
    { ...good, subject: { kind: 'event', id: '<script>' } },
    { ...good, extra: 'field' },                                       // unknown fields are refused
    { ...good, text: 42 },
    null,
  ]) assert.throws(() => parseSuggestion(bad), code('invalid-argument'), JSON.stringify(bad)?.slice(0, 80));
  assert.equal(parseSuggestion({ text: 'Only the text is required here.' }).rec.sourceUrl, '');
  assert.equal(checkUrl('https://en.wikipedia.org/wiki/1763'), 'https://en.wikipedia.org/wiki/1763');
  assert.equal(checkUrl(''), '');
});

test('geo: a filled honeypot looks accepted but nothing is stored or counted', async () => {
  const d = deps();
  assert.deepEqual(await handleSuggest('1.2.3.4', { ...good, hp: 'http://spam.example' }, d), { ok: true });
  assert.equal(d.store.docs.size, 0);
  assert.equal(d.meter.counts.size, 0);
});

test('geo: a form sent faster than a person could write is refused', async () => {
  const d = deps();
  await assert.rejects(handleSuggest('1.2.3.4', { ...good, ms: MIN_FORM_MS - 1 }, d), code('failed-precondition'));
  await assert.rejects(handleSuggest('1.2.3.4', { ...good, ms: undefined }, d), code('failed-precondition'));
  assert.equal(d.store.docs.size, 0);
});

test('geo: a good suggestion is stored as new, with no address in it', async () => {
  const d = deps();
  assert.deepEqual(await handleSuggest('1.2.3.4', good, d), { ok: true });
  const [s] = d.store.docs.values();
  assert.equal(s.status, 'new');
  assert.equal(s.note, '');
  assert.equal(s.year, 1763);
  assert.equal(s.sourceUrl, good.sourceUrl);
  assert.ok(!JSON.stringify(s).includes('1.2.3.4'));
  assert.ok(![...d.meter.counts.keys()].some((k) => k.includes('1.2.3.4')));
});

test('geo: daily caps per address (salted hash) and for everyone', async () => {
  const d = deps();
  for (let i = 0; i < 3; i++) await handleSuggest('1.2.3.4', good, d);
  await assert.rejects(handleSuggest('1.2.3.4', good, d), (e) => e.code === 'resource-exhausted' && /tomorrow/.test(e.message));
  await handleSuggest('5.6.7.8', good, d);                           // another address has its own count
  await handleSuggest('9.9.9.9', good, d);
  await assert.rejects(handleSuggest('8.8.8.8', good, d), code('resource-exhausted')); // the total of 5 is reached
  assert.equal(d.store.docs.size, 5);
  assert.notEqual(ipKey('1.2.3.4', 'd1', 's'), ipKey('1.2.3.4', 'd2', 's'));
  assert.notEqual(ipKey('1.2.3.4', 'd1', 's'), ipKey('1.2.3.4', 'd1', 't'));
  assert.match(ipKey('1.2.3.4', 'd1', 's'), /^ip-[0-9a-f]{32}$/);
});

async function seeded() {
  const store = memStore();
  const rows = [
    [1492, 'Columbus reached the Bahamas in October.', 'Bahamas'],
    [1776, 'The Battle of Long Island is missing.', 'Brooklyn'],
    [1789, 'The storming of the Bastille should be shown.', 'Paris'],
    [null, 'Something with no year at all, but described.', ''],
  ];
  for (const [year, text, place] of rows) await store.add({ text, place, date: '', year, subject: null, sourceUrl: '', email: '', status: 'new', note: '' });
  return store;
}

test('geo admin: only uids on the allow-list get in', async () => {
  const store = await seeded();
  const d = { store, admins: async () => ['owner-uid-123'] };
  await assert.rejects(handleAdmin(undefined, { action: 'list' }, d), code('unauthenticated'));
  await assert.rejects(handleAdmin('someone-else', { action: 'list' }, d), (e) => e.code === 'permission-denied' && e.message === 'Not an admin.');
  await assert.rejects(handleAdmin('someone-else', { action: 'delete', id: [...store.docs.keys()][0] }, d), code('permission-denied'));
  assert.equal(store.docs.size, 4);
  await assert.rejects(handleAdmin('owner-uid-123', { action: 'drop' }, d), code('invalid-argument'));
});

test('geo admin: list newest first with filters, counts and paging; update and delete', async () => {
  const store = await seeded();
  const d = { store, admins: async () => ['owner-uid-123'] };
  const call = (data) => handleAdmin('owner-uid-123', data, d);
  const all = await call({ action: 'list' });
  assert.deepEqual(all.items.map((s) => s.year), [null, 1789, 1776, 1492]);
  assert.deepEqual(all.counts, { all: 4, new: 4, reviewing: 0, added: 0, rejected: 0 });
  assert.equal(all.cursor, null);
  assert.deepEqual((await call({ action: 'list', yearFrom: 1700, yearTo: 1800 })).items.map((s) => s.year), [1789, 1776]);
  assert.deepEqual((await call({ action: 'list', yearFrom: 1800, yearTo: 1700 })).items.map((s) => s.year), [1789, 1776]); // swapped range
  assert.deepEqual((await call({ action: 'list', q: 'BASTILLE paris' })).items.map((s) => s.year), [1789]);
  const p1 = await call({ action: 'list', limit: 2 });
  assert.equal(p1.items.length, 2);
  const p2 = await call({ action: 'list', limit: 2, cursor: p1.cursor });
  assert.deepEqual(p2.items.map((s) => s.year), [1776, 1492]);

  const id = all.items[1].id;
  assert.deepEqual(await call({ action: 'update', id, status: 'added', note: '  Added to 1789.  ' }), { ok: true, id, status: 'added', note: 'Added to 1789.' });
  assert.equal(store.docs.get(id).updatedBy, 'owner-uid-123');
  assert.deepEqual((await call({ action: 'list', status: 'added' })).items.map((s) => s.id), [id]);
  assert.equal((await call({ action: 'list' })).counts.added, 1);
  await assert.rejects(call({ action: 'update', id, status: 'done' }), code('invalid-argument'));
  await assert.rejects(call({ action: 'update', id }), code('invalid-argument'));
  await call({ action: 'delete', id });
  assert.equal(store.docs.has(id), false);
  await assert.rejects(call({ action: 'update', id, status: 'new' }), code('not-found'));
});

test('geo admin: the committed allow-list file is read and checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'));
  const f = join(dir, 'admins.json');
  writeFileSync(f, JSON.stringify({ geohistory: ['AbCdEf123456', 'bad uid!', 7] }));
  assert.deepEqual(fileAdmins(f), ['AbCdEf123456']);
  assert.deepEqual(fileAdmins(join(dir, 'missing.json')), []);
  assert.ok(Array.isArray(fileAdmins()));          // the real functions/admins.json parses
  assert.ok(matches({ text: '\u00c9mile', year: 5 }, { q: 'emile' }));
});
