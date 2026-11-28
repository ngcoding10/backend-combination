// End-to-end checks against the Auth, Firestore and Functions emulators, through the same
// web/core.js the apps use: `npm run test:integration`. The model is faked (FAKE_AI=1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as app from 'firebase/app';
import * as auth from 'firebase/auth';
import * as firestore from 'firebase/firestore';
import * as functions from 'firebase/functions';
import { createCore } from '../web/core.js';

firestore.setLogLevel('silent');
const sdk = { app, auth, firestore, functions, appCheck: {} };
let n = 0;
after(async () => { await Promise.all(app.getApps().map((a) => app.deleteApp(a))); });
/** A separate signed-in "browser". */
async function person(email) {
  const fbApp = { ...app, initializeApp: (cfg) => app.initializeApp(cfg, `p${n++}`) };
  const core = createCore({ appName: 'test', sdk: { ...sdk, app: fbApp }, config: null, emulator: true, offlineCache: false });
  const user = await core.emulatorSignIn(email);
  return { core, uid: user.uid, db: core.db };
}
const F = firestore;
const run = Date.now().toString(36);
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 250)); }
};
const moviProfile = (username) => ({ username, displayName: 'Name', nameLower: 'name', bio: '', avatarHue: 40, yearlyGoal: 52, rankedCount: 0, createdAt: F.serverTimestamp() });

let alice, bob;
before(async () => { alice = await person(`alice-${run}@example.com`); bob = await person(`bob-${run}@example.com`); });

test('account: claim, suggest, collide, rename', async () => {
  const a = await alice.core.account.claim(`Alice.${run}`);
  assert.equal(a.username, `alice.${run}`);
  assert.equal(await bob.core.account.isFree(`alice.${run}`), false);
  await assert.rejects(bob.core.account.claim(`alice.${run}`), /taken/);
  await assert.rejects(bob.core.account.claim('No'), /3–20/);
  const suggestion = await bob.core.account.suggest(`alice.${run}@example.com`);
  assert.notEqual(suggestion, `alice.${run}`);
  await bob.core.account.claim(suggestion);
  assert.equal((await alice.core.account.get(bob.uid)).username, suggestion);

  // rename carries an app profile with it and frees the old name
  await F.setDoc(F.doc(alice.db, 'movi_profiles', alice.uid), moviProfile(`alice.${run}`));
  await alice.core.account.claim(`alice2.${run}`);
  assert.equal((await F.getDoc(F.doc(alice.db, 'movi_profiles', alice.uid))).get('username'), `alice2.${run}`);
  assert.equal(await bob.core.account.ownerOf(`alice.${run}`), null);
});

test('pantry AI: sign-in required, answer returned, daily limit enforced, counters hidden', async () => {
  const req = { ingredients: ['eggs'], meal: 'breakfast', servings: 2, maxMinutes: 0, diets: [], strict: false, avoidZero: false, note: '' };
  const anon = createCore({ appName: 'anon', sdk: { ...sdk, app: { ...app, initializeApp: (c) => app.initializeApp(c, 'anon') } }, config: null, emulator: true, offlineCache: false });
  await assert.rejects(anon.call('pantryGenerateRecipe', req), (e) => e.code === 'unauthenticated');
  const carol = await person(`carol-${run}@example.com`);
  const first = await carol.core.call('pantryGenerateRecipe', req);
  assert.equal(first.recipe.title, 'Garlic Spinach Eggs');
  assert.deepEqual(first.usage, { used: 1, limit: 8 });
  await assert.rejects(carol.core.call('pantryGenerateRecipe', { meal: 'brunch' }), (e) => e.code === 'invalid-argument');
  for (let i = 0; i < 7; i++) await carol.core.call('pantryCheckLabel', { text: 'sugar' });
  await assert.rejects(carol.core.call('pantryGenerateRecipe', req), (e) => e.code === 'resource-exhausted' && /8 AI requests.*UTC\.$/.test(e.message));
  // the pantry limit does not touch Movi's
  const m = await carol.core.call('moviMatchFilms', { lines: [{ text: 'star wars', hints: [] }] });
  assert.equal(m.results[0].films[0].title, 'Star Wars');
  await assert.rejects(F.getDocs(F.collection(carol.db, 'ai_usage')), (e) => e.code === 'permission-denied');
});

test('movi: likes, comments, follows and recs produce counts and notifications', async () => {
  await F.setDoc(F.doc(bob.db, 'movi_profiles', bob.uid), moviProfile((await bob.core.account.get()).username));
  const act = await F.addDoc(F.collection(alice.db, 'movi_activities'), { uid: alice.uid, kind: 'ranked', filmId: 3, bucket: 'loved', score: 9, note: '', createdAt: F.serverTimestamp(), likeCount: 0, commentCount: 0 });
  await F.setDoc(F.doc(bob.db, 'movi_likes', `${act.id}_${bob.uid}`), { activityId: act.id, uid: bob.uid, createdAt: F.serverTimestamp() });
  const comment = await F.addDoc(F.collection(bob.db, 'movi_comments'), { activityId: act.id, uid: bob.uid, body: 'nice pick', createdAt: F.serverTimestamp() });
  await F.setDoc(F.doc(bob.db, 'movi_follows', `${bob.uid}_${alice.uid}`), { follower: bob.uid, followee: alice.uid, createdAt: F.serverTimestamp() });
  await F.addDoc(F.collection(bob.db, 'movi_recs'), { from: bob.uid, to: alice.uid, filmId: 9, message: 'watch this', createdAt: F.serverTimestamp() });

  const mine = F.query(F.collection(alice.db, 'movi_notifications'), F.where('uid', '==', alice.uid), F.orderBy('createdAt', 'desc'));
  const notes = await until(async () => { const s = await F.getDocs(mine); return s.size >= 4 ? s.docs.map((d) => d.data()) : null; });
  assert.deepEqual(notes.map((x) => x.kind).sort(), ['comment', 'follow', 'like', 'rec']);
  assert.ok(notes.every((x) => x.actor === bob.uid && x.read === false));
  assert.equal(notes.find((x) => x.kind === 'comment').body, 'nice pick');
  await until(async () => { const a = (await F.getDoc(act)).data(); return a.likeCount === 1 && a.commentCount === 1; });

  // unlike: count and notification go away
  await F.deleteDoc(F.doc(bob.db, 'movi_likes', `${act.id}_${bob.uid}`));
  await until(async () => (await F.getDoc(act)).get('likeCount') === 0);
  await until(async () => (await F.getDocs(mine)).docs.every((d) => d.get('kind') !== 'like'));
  // liking your own post does not notify you
  await F.setDoc(F.doc(alice.db, 'movi_likes', `${act.id}_${alice.uid}`), { activityId: act.id, uid: alice.uid, createdAt: F.serverTimestamp() });
  await until(async () => (await F.getDoc(act)).get('likeCount') === 1);
  assert.ok((await F.getDocs(mine)).docs.every((d) => d.get('kind') !== 'like'));

  // deleting the post clears its likes, comments and notifications
  await F.deleteDoc(act);
  await until(async () => !(await F.getDoc(F.doc(bob.db, 'movi_comments', comment.id))).exists());
  await until(async () => (await F.getDocs(mine)).docs.every((d) => d.get('activityId') !== act.id));
});

test('deleting one app leaves the others; deleting the last one removes the account', async () => {
  const dan = await person(`dan-${run}@example.com`);
  const name = `dan.${run}`;
  await dan.core.account.claim(name);
  await F.setDoc(F.doc(dan.db, 'movi_profiles', dan.uid), moviProfile(name));
  await F.setDoc(F.doc(dan.db, 'movi_lists', dan.uid), { loved: [], fine: [], disliked: [], at: {}, updatedAt: F.serverTimestamp() });
  await F.setDoc(F.doc(dan.db, 'pantry_users', dan.uid), { pantry: ['eggs'], updatedAt: F.serverTimestamp() });
  await F.addDoc(F.collection(dan.db, 'pantry_users', dan.uid, 'recipes'), { recipe: { title: 'Eggs' }, request: null, createdAt: F.serverTimestamp() });

  const one = await dan.core.deleteMyData('movi');
  assert.deepEqual(one, { deleted: ['movi'], accountDeleted: false });
  assert.equal((await F.getDoc(F.doc(dan.db, 'movi_profiles', dan.uid))).exists(), false);
  assert.equal((await F.getDoc(F.doc(dan.db, 'pantry_users', dan.uid))).exists(), true);
  assert.equal((await dan.core.account.get()).username, name);

  const two = await dan.core.deleteMyData('pantry');
  assert.equal(two.accountDeleted, true);
  assert.equal(await alice.core.account.ownerOf(name), null);
  await assert.rejects(dan.core.call('accountDeleteMyData', { app: 'nope' }));
});

test('palette: menu reading needs sign-in, is limited per day; sessions are shared anonymously; delete works', async () => {
  const anon = createCore({ appName: 'anon2', sdk: { ...sdk, app: { ...app, initializeApp: (c) => app.initializeApp(c, 'anon2') } }, config: null, emulator: true, offlineCache: false });
  await assert.rejects(anon.call('paletteReadMenu', { text: 'Pad thai' }), (e) => e.code === 'unauthenticated');
  // sharing a training session works without signing in, and nothing in it names the person
  const id = `s${run}`.padEnd(20, 'x');
  const session = { v: 1, intake: { diet: [], allergies: ['peanut'], never: [], spice: 2, adventure: 1, cuisines: [] }, rounds: [{ menu: 'thai', predicted: ['a', 'b', 'c'], picked: ['b'], never: [] }] };
  assert.deepEqual(await anon.call('paletteShareSession', { id, session }), { saved: 1 });
  await assert.rejects(anon.call('paletteShareSession', { id, session: { ...session, v: 2 } }), (e) => e.code === 'invalid-argument');
  await assert.rejects(F.getDoc(F.doc(alice.db, 'palette_sessions', id)), (e) => e.code === 'permission-denied');
  assert.deepEqual(await anon.call('paletteShareSession', { id, remove: true }), { removed: true });

  const erin = await person(`erin-${run}@example.com`);
  const first = await erin.core.call('paletteReadMenu', { text: 'Pad thai, green curry', profile: { allergies: ['peanut'], spice: 2 } });
  assert.equal(first.menu.cuisineGuess, 'Thai');
  assert.ok(first.menu.dishes.length >= 5 && first.menu.picks.length <= 3);
  assert.deepEqual(first.usage, { used: 1, limit: 10 });
  for (let i = 1; i < 10; i++) await erin.core.call('paletteReadMenu', { text: 'menu' });
  await assert.rejects(erin.core.call('paletteReadMenu', { text: 'menu' }), (e) => e.code === 'resource-exhausted' && /10 AI requests/.test(e.message));

  await F.setDoc(F.doc(erin.db, 'palette_users', erin.uid), { intake: {}, weights: {}, history: '[]', updatedAt: F.serverTimestamp() });
  await F.addDoc(F.collection(erin.db, 'palette_users', erin.uid, 'meals'), { dishes: [], picks: [], createdAt: F.serverTimestamp() });
  const res = await erin.core.deleteMyData('palette');
  assert.deepEqual(res, { deleted: ['palette'], accountDeleted: true });
});

test('geohistory: anyone can suggest (checked, capped per address); only listed admins can read and manage', async () => {
  const anon = createCore({ appName: 'anon3', sdk: { ...sdk, app: { ...app, initializeApp: (c) => app.initializeApp(c, 'anon3') } }, config: null, emulator: true, offlineCache: false });
  const good = { text: `Suggestion ${run}: the Treaty of Paris (1763) is missing.`, place: 'Paris', date: '10 February 1763', year: 1763, subject: { kind: 'polity', id: 'France', name: 'France' }, sourceUrl: 'https://en.wikipedia.org/wiki/Treaty_of_Paris_(1763)', email: '', hp: '', ms: 8000 };
  assert.deepEqual(await anon.call('geoSuggest', good), { ok: true });
  await assert.rejects(anon.call('geoSuggest', { ...good, text: 'short' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(anon.call('geoSuggest', { ...good, sourceUrl: 'javascript:alert(1)' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(anon.call('geoSuggest', { ...good, ms: 500 }), (e) => e.code === 'failed-precondition');
  assert.deepEqual(await anon.call('geoSuggest', { ...good, text: `Honeypot ${run} filled in by a script.`, hp: 'x' }), { ok: true });
  await assert.rejects(F.getDocs(F.collection(alice.db, 'geo_suggestions')), (e) => e.code === 'permission-denied');

  // not signed in, or signed in but not on the list: refused, and the caller can be told their own uid
  await assert.rejects(anon.call('geoAdminSuggestions', { action: 'list' }), (e) => e.code === 'unauthenticated');
  await assert.rejects(bob.core.call('geoAdminSuggestions', { action: 'list' }), (e) => e.code === 'permission-denied' && e.message === 'Not an admin.');
  // put alice on the server-side list (config/admins), the way the owner can without a deploy
  const r = await fetch('http://127.0.0.1:8080/v1/projects/demo-apps/databases/(default)/documents/config/admins', {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { geohistory: { arrayValue: { values: [{ stringValue: alice.uid }] } } } }),
  });
  assert.equal(r.status, 200);
  const list = await alice.core.call('geoAdminSuggestions', { action: 'list', q: run });
  assert.equal(list.items.length, 1);                                  // the honeypot one was never stored
  const s = list.items[0];
  assert.equal(s.status, 'new');
  assert.equal(s.year, 1763);
  assert.equal(typeof s.createdAt, 'number');
  assert.ok(!('ip' in s) && !JSON.stringify(s).includes('127.0.0.1'));
  assert.ok(list.counts.all >= 1 && list.counts.new >= 1);
  await alice.core.call('geoAdminSuggestions', { action: 'update', id: s.id, status: 'reviewing', note: 'checking' });
  const rev = await alice.core.call('geoAdminSuggestions', { action: 'list', status: 'reviewing', yearFrom: 1700, yearTo: 1800 });
  assert.deepEqual(rev.items.map((x) => [x.id, x.note]), [[s.id, 'checking']]);
  await assert.rejects(bob.core.call('geoAdminSuggestions', { action: 'delete', id: s.id }), (e) => e.code === 'permission-denied');
  await alice.core.call('geoAdminSuggestions', { action: 'delete', id: s.id });
  assert.equal((await alice.core.call('geoAdminSuggestions', { action: 'list', q: run })).items.length, 0);

  // the per-address daily cap (6 in functions/.env): one was used above
  for (let i = 0; i < 5; i++) await anon.call('geoSuggest', { ...good, text: `${good.text} (${i})` });
  await assert.rejects(anon.call('geoSuggest', good), (e) => e.code === 'resource-exhausted' && /tomorrow/.test(e.message));
});
