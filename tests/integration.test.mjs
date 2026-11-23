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
  await assert.rejects(carol.core.call('pantryGenerateRecipe', req), (e) => e.code === 'resource-exhausted' && /8 AI requests/.test(e.message));
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
  assert.equal((await F.getDocs(F.collection(alice.db, 'usernames'))).docs.some((d) => d.get('uid') === dan.uid), false);
  await assert.rejects(dan.core.call('accountDeleteMyData', { app: 'nope' }));
});
