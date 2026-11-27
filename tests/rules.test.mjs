// Security rules checks, run against the Firestore emulator: `npm run test:rules`.
import { test, before, after, beforeEach } from 'node:test';
import { setLogLevel } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, collection, query, where, getDocs, arrayUnion, arrayRemove, addDoc, orderBy, limit } from 'firebase/firestore';

setLogLevel('silent');
let env;
const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const ts = serverTimestamp;

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-apps', firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

/** Claim a username the way the apps do: account + username in one batch. */
function claim(uid, name, { old = null, displayName = 'Name', extra = () => {} } = {}) {
  const d = db(uid), b = writeBatch(d);
  b.set(doc(d, 'accounts', uid), { username: name, displayName, createdAt: ts(), updatedAt: ts() });
  b.set(doc(d, 'usernames', name), { uid });
  if (old) b.delete(doc(d, 'usernames', old));
  extra(b, d);
  return b.commit();
}
function rename(uid, name, old, extra = () => {}) {
  const d = db(uid), b = writeBatch(d);
  b.update(doc(d, 'accounts', uid), { username: name, updatedAt: ts() });
  b.set(doc(d, 'usernames', name), { uid });
  b.delete(doc(d, 'usernames', old));
  extra(b, d);
  return b.commit();
}
const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));

// ───────── accounts and usernames ─────────
test('account: claim a username with dots and underscores', async () => {
  await assertSucceeds(claim('alice', 'ali.ce_1'));
  await assertSucceeds(getDoc(doc(db('bob'), 'accounts', 'alice')));
  await assertFails(getDocs(collection(db('bob'), 'accounts')));              // accounts cannot be listed
  await assertFails(getDoc(doc(db(null), 'accounts', 'alice')));
  await assertSucceeds(getDoc(doc(db(null), 'usernames', 'ali.ce_1'))); // "is it taken?" works before sign-up
  await assertFails(getDocs(collection(db('bob'), 'usernames')));           // but names cannot be listed
});
test('account: invalid names are refused', async () => {
  for (const bad of ['ab', 'Alice', 'has space', 'x'.repeat(21), 'émile', 'a-b']) await assertFails(claim('alice', bad));
});
test('account: a taken name cannot be claimed or overwritten', async () => {
  await claim('alice', 'alice');
  await assertFails(claim('bob', 'alice'));
  await assertFails(setDoc(doc(db('bob'), 'usernames', 'alice'), { uid: 'bob' }));
  await assertFails(deleteDoc(doc(db('bob'), 'usernames', 'alice')));
});
test('account: username doc without the account (or the reverse) is refused', async () => {
  await assertFails(setDoc(doc(db('alice'), 'usernames', 'alice'), { uid: 'alice' }));
  await assertFails(setDoc(doc(db('alice'), 'accounts', 'alice'), { username: 'alice', displayName: '', createdAt: ts(), updatedAt: ts() }));
});
test('account: cannot hold two names, cannot squat, cannot write someone else', async () => {
  await claim('alice', 'alice');
  await assertFails(setDoc(doc(db('alice'), 'usernames', 'alice2'), { uid: 'alice' }));
  await assertFails(setDoc(doc(db('alice'), 'usernames', 'bobby'), { uid: 'bob' }));
  await assertFails(setDoc(doc(db('bob'), 'accounts', 'alice'), { username: 'alice', displayName: 'x', createdAt: ts(), updatedAt: ts() }));
});
test('account: rename releases the old name, and only in the same batch', async () => {
  await claim('alice', 'alice');
  await assertFails(deleteDoc(doc(db('alice'), 'usernames', 'alice'))); // would orphan the account
  await assertSucceeds(rename('alice', 'alice.new', 'alice'));
  await assertSucceeds(claim('bob', 'alice'));
});
test('account: extra fields, long display names and deletes are refused', async () => {
  await assertFails(claim('alice', 'alice', { extra: (b, d) => b.set(doc(d, 'accounts', 'alice'), { username: 'alice', displayName: 'x', admin: true, createdAt: ts(), updatedAt: ts() }) }));
  await assertFails(claim('alice', 'alice', { displayName: 'x'.repeat(41) }));
  await claim('alice', 'alice');
  await assertFails(deleteDoc(doc(db('alice'), 'accounts', 'alice')));
});
test('account: rename must carry the app profiles along', async () => {
  await claim('alice', 'alice');
  await assertSucceeds(setDoc(doc(db('alice'), 'whyb_profiles', 'alice'), { username: 'alice', friends: [] }));
  await assertFails(rename('alice', 'alice2', 'alice'));
  await assertSucceeds(rename('alice', 'alice2', 'alice', (b, d) => b.update(doc(d, 'whyb_profiles', 'alice'), { username: 'alice2' })));
});

// ───────── The Pantry ─────────
test('pantry: only the owner reads and writes, with bounds', async () => {
  const mine = doc(db('alice'), 'pantry_users', 'alice');
  await assertSucceeds(setDoc(mine, { pantry: ['eggs'], updatedAt: ts() }));
  await assertSucceeds(getDoc(mine));
  await assertFails(getDoc(doc(db('bob'), 'pantry_users', 'alice')));
  await assertFails(setDoc(doc(db('bob'), 'pantry_users', 'alice'), { pantry: [], updatedAt: ts() }));
  await assertFails(setDoc(mine, { pantry: Array(201).fill('x'), updatedAt: ts() }));
  await assertFails(setDoc(mine, { pantry: [], updatedAt: ts(), plan: 'pro' }));
  await assertFails(getDoc(doc(db(null), 'pantry_users', 'alice')));
});
test('pantry: saved recipes belong to their owner', async () => {
  const r = doc(db('alice'), 'pantry_users', 'alice', 'recipes', 'r1');
  await assertSucceeds(setDoc(r, { recipe: { title: 'Eggs' }, request: null, createdAt: ts() }));
  await assertFails(setDoc(r, { recipe: { title: 'x'.repeat(201) }, request: null, createdAt: ts() }));
  await assertFails(getDoc(doc(db('bob'), 'pantry_users', 'alice', 'recipes', 'r1')));
  await assertFails(getDocs(collection(db('bob'), 'pantry_users', 'alice', 'recipes')));
  await assertSucceeds(deleteDoc(r));
});

// ───────── Where Have You Been ─────────
test('whyb: private logbook is owner-only and size-bounded', async () => {
  const mine = doc(db('alice'), 'whyb_users', 'alice');
  await assertSucceeds(setDoc(mine, { book: '{}', settings: '{}', name: 'Alice', updatedAt: ts() }));
  await assertFails(getDoc(doc(db('bob'), 'whyb_users', 'alice')));
  await assertFails(setDoc(doc(db('bob'), 'whyb_users', 'alice'), { book: '{}', settings: '{}', name: '', updatedAt: ts() }));
  await assertFails(setDoc(mine, { book: 'x'.repeat(950001), settings: '{}', name: '', updatedAt: ts() }));
});
async function whybPair() {
  await claim('alice', 'alice'); await claim('bob', 'bob');
  await setDoc(doc(db('alice'), 'whyb_profiles', 'alice'), { username: 'alice', friends: [], stats: {}, visited: {} });
  await setDoc(doc(db('bob'), 'whyb_profiles', 'bob'), { username: 'bob', friends: [], stats: {}, visited: {} });
}
test('whyb: profile needs your own account username', async () => {
  await claim('alice', 'alice'); await claim('bob', 'bob');
  await assertFails(setDoc(doc(db('alice'), 'whyb_profiles', 'alice'), { username: 'bob', friends: [] }));
  await assertFails(setDoc(doc(db('carol'), 'whyb_profiles', 'carol'), { username: 'carol', friends: [] })); // no account
  await assertSucceeds(setDoc(doc(db('alice'), 'whyb_profiles', 'alice'), { username: 'alice', friends: [] }));
});
test('whyb: profiles are hidden from non-friends', async () => {
  await whybPair();
  await assertFails(getDoc(doc(db('bob'), 'whyb_profiles', 'alice')));
  await assertSucceeds(getDoc(doc(db('alice'), 'whyb_profiles', 'alice')));
});
test('whyb: friend request, accept, then both see each other; unfriend', async () => {
  await whybPair();
  // alice asks bob
  const req = { from: 'alice', to: 'bob', fromName: 'alice', toName: 'bob', createdAt: ts() };
  await assertFails(setDoc(doc(db('alice'), 'whyb_requests', 'bob_alice'), { ...req, fromName: 'someoneelse' }));
  await assertFails(setDoc(doc(db('carol'), 'whyb_requests', 'bob_alice'), req)); // forged sender
  await assertFails(setDoc(doc(db('alice'), 'whyb_requests', 'ghost_alice'), { ...req, to: 'ghost', toName: 'ghost' })); // not a member of this app
  await assertSucceeds(setDoc(doc(db('alice'), 'whyb_requests', 'bob_alice'), req));
  await assertFails(getDoc(doc(db('carol'), 'whyb_requests', 'bob_alice')));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'whyb_requests'), where('to', '==', 'bob'))));
  // alice cannot add herself to bob's friends just because she asked
  await assertFails(updateDoc(doc(db('alice'), 'whyb_profiles', 'bob'), { friends: arrayUnion('alice') }));
  // bob accepts
  const d = db('bob'), b = writeBatch(d);
  b.update(doc(d, 'whyb_profiles', 'bob'), { friends: arrayUnion('alice') });
  b.update(doc(d, 'whyb_profiles', 'alice'), { friends: arrayUnion('bob') });
  b.delete(doc(d, 'whyb_requests', 'bob_alice'));
  await assertSucceeds(b.commit());
  await assertSucceeds(getDoc(doc(db('alice'), 'whyb_profiles', 'bob')));
  await assertSucceeds(getDoc(doc(db('bob'), 'whyb_profiles', 'alice')));
  // a friend cannot edit anything else, or add a third person
  await assertFails(updateDoc(doc(db('bob'), 'whyb_profiles', 'alice'), { stats: { countries: 999 } }));
  await assertFails(updateDoc(doc(db('bob'), 'whyb_profiles', 'alice'), { friends: arrayUnion('carol') }));
  // unfriend from either side
  await assertSucceeds(updateDoc(doc(db('bob'), 'whyb_profiles', 'alice'), { friends: arrayRemove('bob') }));
  await assertFails(getDoc(doc(db('bob'), 'whyb_profiles', 'alice')));
});
test('whyb: a stranger cannot add themselves without a request from you', async () => {
  await whybPair();
  await assertFails(updateDoc(doc(db('bob'), 'whyb_profiles', 'alice'), { friends: arrayUnion('bob') }));
  // bob asking alice does not let bob into alice's list either
  await setDoc(doc(db('bob'), 'whyb_requests', 'alice_bob'), { from: 'bob', to: 'alice', fromName: 'bob', toName: 'alice', createdAt: ts() });
  await assertFails(updateDoc(doc(db('bob'), 'whyb_profiles', 'alice'), { friends: arrayUnion('bob') }));
});

// ───────── Movi ─────────
const profile = (username, over = {}) => ({ username, displayName: 'Name', nameLower: 'name', bio: '', avatarHue: 40, yearlyGoal: 52, rankedCount: 0, createdAt: ts(), ...over });
async function moviUser(uid) {
  await claim(uid, uid);
  await setDoc(doc(db(uid), 'movi_profiles', uid), profile(uid));
}
function saveLists(uid, lists, { count } = {}) {
  const d = db(uid), b = writeBatch(d);
  const total = lists.loved.length + lists.fine.length + lists.disliked.length;
  b.set(doc(d, 'movi_lists', uid), { ...lists, at: {}, updatedAt: ts() });
  b.update(doc(d, 'movi_profiles', uid), { rankedCount: count ?? total });
  return b.commit();
}
test('movi: profile rules', async () => {
  await claim('alice', 'alice');
  const p = doc(db('alice'), 'movi_profiles', 'alice');
  await assertFails(setDoc(p, profile('bob')));
  await assertFails(setDoc(p, profile('alice', { rankedCount: 500 })));
  await assertFails(setDoc(p, profile('alice', { avatarHue: 360 })));
  await assertFails(setDoc(p, profile('alice', { nameLower: 'x'.repeat(61) })));
  await assertFails(setDoc(p, profile('alice', { bio: 'x'.repeat(161) })));
  await assertFails(setDoc(p, profile('alice', { isAdmin: true })));
  await assertSucceeds(setDoc(p, profile('alice')));
  await assertSucceeds(getDoc(doc(db('bob'), 'movi_profiles', 'alice')));
  await assertFails(getDoc(doc(db(null), 'movi_profiles', 'alice')));
  await assertFails(updateDoc(doc(db('bob'), 'movi_profiles', 'alice'), { bio: 'hacked' }));
  await assertSucceeds(updateDoc(p, { bio: 'hi', displayName: 'Alice A', nameLower: 'alice a' }));
});
test('movi: lists and the ranked count move together', async () => {
  await moviUser('alice');
  await assertSucceeds(saveLists('alice', { loved: [1, 2], fine: [3], disliked: [] }));
  await assertFails(saveLists('alice', { loved: [1, 2], fine: [3], disliked: [] }, { count: 99 }));
  await assertFails(saveLists('alice', { loved: [1, 1], fine: [], disliked: [] }));
  await assertFails(saveLists('alice', { loved: [1], fine: [1], disliked: [] }));
  await assertFails(updateDoc(doc(db('alice'), 'movi_profiles', 'alice'), { rankedCount: 1000 }));
  await assertFails(setDoc(doc(db('bob'), 'movi_lists', 'alice'), { loved: [], fine: [], disliked: [], at: {}, updatedAt: ts() }));
  await assertSucceeds(getDoc(doc(db('bob'), 'movi_lists', 'alice')));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'movi_lists'), where('loved', 'array-contains', 1))));
});
test('movi: entries, watchlist, backlog', async () => {
  await moviUser('alice');
  const e = { uid: 'alice', filmId: 7, note: 'good', watchedOn: '2026-01-02', watchedWhere: 'Theater', watchedWith: '', rewatch: false, updatedAt: ts() };
  await assertSucceeds(setDoc(doc(db('alice'), 'movi_entries', 'alice_7'), e));
  await assertFails(setDoc(doc(db('alice'), 'movi_entries', 'alice_8'), e));
  await assertFails(setDoc(doc(db('bob'), 'movi_entries', 'alice_7'), e));
  await assertFails(setDoc(doc(db('alice'), 'movi_entries', 'alice_7'), { ...e, watchedOn: 'yesterday' }));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'movi_entries'), where('uid', '==', 'alice'))));
  await assertSucceeds(setDoc(doc(db('alice'), 'movi_watchlists', 'alice'), { items: { 5: { at: 1, from: null } }, updatedAt: ts() }));
  await assertSucceeds(getDoc(doc(db('bob'), 'movi_watchlists', 'alice')));
  await assertFails(setDoc(doc(db('bob'), 'movi_watchlists', 'alice'), { items: {}, updatedAt: ts() }));
  await assertSucceeds(setDoc(doc(db('alice'), 'movi_backlogs', 'alice'), { items: { 5: 1 }, updatedAt: ts() }));
  await assertFails(getDoc(doc(db('bob'), 'movi_backlogs', 'alice')));
});
test('movi: follows', async () => {
  await moviUser('alice'); await moviUser('bob');
  const f = { follower: 'alice', followee: 'bob', createdAt: ts() };
  await assertFails(setDoc(doc(db('bob'), 'movi_follows', 'alice_bob'), f));               // forged
  await assertFails(setDoc(doc(db('alice'), 'movi_follows', 'alice_alice'), { ...f, followee: 'alice' }));
  await assertFails(setDoc(doc(db('alice'), 'movi_follows', 'alice_ghost'), { ...f, followee: 'ghost' }));
  await assertFails(setDoc(doc(db('alice'), 'movi_follows', 'wrong'), f));
  await assertSucceeds(setDoc(doc(db('alice'), 'movi_follows', 'alice_bob'), f));
  await assertFails(deleteDoc(doc(db('carol'), 'movi_follows', 'alice_bob')));
  await assertSucceeds(deleteDoc(doc(db('bob'), 'movi_follows', 'alice_bob')));            // remove a follower
});
test('movi: activity, likes, comments', async () => {
  await moviUser('alice'); await moviUser('bob');
  const act = { uid: 'alice', kind: 'ranked', filmId: 3, bucket: 'loved', score: 9.1, note: '', createdAt: ts(), likeCount: 0, commentCount: 0 };
  await assertFails(setDoc(doc(db('alice'), 'movi_activities', 'a0'), { ...act, likeCount: 50 }));
  await assertFails(setDoc(doc(db('bob'), 'movi_activities', 'a0'), act));
  await assertFails(setDoc(doc(db('alice'), 'movi_activities', 'a0'), { ...act, score: 11 }));
  await assertSucceeds(setDoc(doc(db('alice'), 'movi_activities', 'a1'), act));
  await assertFails(updateDoc(doc(db('alice'), 'movi_activities', 'a1'), { likeCount: 99 }));
  await assertSucceeds(updateDoc(doc(db('alice'), 'movi_activities', 'a1'), { note: 'edit' }));
  await assertFails(updateDoc(doc(db('bob'), 'movi_activities', 'a1'), { note: 'defaced' }));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'movi_activities'), where('uid', 'in', ['alice']), orderBy('createdAt', 'desc'), limit(20))));

  const like = { activityId: 'a1', uid: 'bob', createdAt: ts() };
  await assertFails(setDoc(doc(db('alice'), 'movi_likes', 'a1_bob'), like));
  await assertFails(setDoc(doc(db('bob'), 'movi_likes', 'nope_bob'), { ...like, activityId: 'nope' }));
  await assertSucceeds(setDoc(doc(db('bob'), 'movi_likes', 'a1_bob'), like));
  await assertFails(deleteDoc(doc(db('alice'), 'movi_likes', 'a1_bob')));

  const c = { activityId: 'a1', uid: 'bob', body: 'nice', createdAt: ts() };
  await assertFails(addDoc(collection(db('bob'), 'movi_comments'), { ...c, body: '' }));
  await assertFails(addDoc(collection(db('bob'), 'movi_comments'), { ...c, body: 'x'.repeat(501) }));
  await assertFails(addDoc(collection(db('alice'), 'movi_comments'), c));
  const ref = await assertSucceeds(addDoc(collection(db('bob'), 'movi_comments'), c));
  await assertFails(deleteDoc(doc(db('carol'), 'movi_comments', ref.id)));
  await assertSucceeds(deleteDoc(doc(db('alice'), 'movi_comments', ref.id))); // owner of the activity
});
test('movi: recommendations and notifications are private', async () => {
  await moviUser('alice'); await moviUser('bob');
  const rec = { from: 'alice', to: 'bob', filmId: 4, message: 'watch', createdAt: ts() };
  await assertFails(addDoc(collection(db('carol'), 'movi_recs'), rec));
  const r = await assertSucceeds(addDoc(collection(db('alice'), 'movi_recs'), rec));
  await assertFails(getDoc(doc(db('carol'), 'movi_recs', r.id)));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'movi_recs'), where('to', '==', 'bob'), orderBy('createdAt', 'desc'))));
  await assertFails(getDocs(collection(db('carol'), 'movi_recs')));

  await seed((d) => setDoc(doc(d, 'movi_notifications', 'n1'), { uid: 'bob', actor: 'alice', kind: 'follow', read: false, createdAt: new Date() }));
  await assertFails(setDoc(doc(db('alice'), 'movi_notifications', 'n2'), { uid: 'bob', actor: 'alice', kind: 'follow', read: false }));
  await assertFails(getDoc(doc(db('alice'), 'movi_notifications', 'n1')));
  await assertSucceeds(updateDoc(doc(db('bob'), 'movi_notifications', 'n1'), { read: true }));
  await assertFails(updateDoc(doc(db('bob'), 'movi_notifications', 'n1'), { kind: 'like' }));
  await assertSucceeds(deleteDoc(doc(db('bob'), 'movi_notifications', 'n1')));
});

// ───────── MyPalette ─────────
const paletteProfile = (over = {}) => ({ intake: { spice: 2, diet: ['vegetarian'] }, weights: { 'cuisine:thai': 0.8 }, stats: { rounds: 3 }, history: '[]', updatedAt: ts(), ...over });
test('palette: the taste profile is owner-only, with a fixed shape and size limits', async () => {
  const mine = doc(db('alice'), 'palette_users', 'alice');
  await assertSucceeds(setDoc(mine, paletteProfile()));
  await assertSucceeds(getDoc(mine));
  await assertSucceeds(setDoc(mine, (({ stats, ...r }) => r)(paletteProfile()))); // stats is optional
  await assertFails(getDoc(doc(db('bob'), 'palette_users', 'alice')));
  await assertFails(getDoc(doc(db(null), 'palette_users', 'alice')));
  await assertFails(getDocs(collection(db('bob'), 'palette_users')));
  await assertFails(setDoc(doc(db('bob'), 'palette_users', 'alice'), paletteProfile()));
  await assertFails(setDoc(doc(db(null), 'palette_users', 'alice'), paletteProfile()));
  await assertFails(setDoc(mine, paletteProfile({ history: 'x'.repeat(600001) })));
  await assertFails(setDoc(mine, paletteProfile({ weights: Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`f${i}`, 0])) })));
  await assertFails(setDoc(mine, paletteProfile({ updatedAt: new Date() })));
  await assertFails(setDoc(mine, paletteProfile({ admin: true })));
  await assertFails(setDoc(mine, (({ weights, ...r }) => r)(paletteProfile())));
  await assertFails(deleteDoc(doc(db('bob'), 'palette_users', 'alice')));
  await assertSucceeds(deleteDoc(mine));
});
test('palette: meal history is owner-only and bounded', async () => {
  const meal = { title: 'Thai place', cuisine: 'Thai', dishes: [{ name: 'Pad thai' }], picks: [0], ordered: [0], ratings: { 0: true }, createdAt: ts() };
  const m = doc(db('alice'), 'palette_users', 'alice', 'meals', 'm1');
  await assertSucceeds(setDoc(m, meal));
  await assertSucceeds(updateDoc(m, { ordered: [0, 1], ratings: { 0: true, 1: false } }));
  await assertSucceeds(getDocs(collection(db('alice'), 'palette_users', 'alice', 'meals')));
  await assertFails(getDoc(doc(db('bob'), 'palette_users', 'alice', 'meals', 'm1')));
  await assertFails(getDocs(collection(db('bob'), 'palette_users', 'alice', 'meals')));
  await assertFails(setDoc(doc(db('bob'), 'palette_users', 'alice', 'meals', 'm2'), meal));
  await assertFails(setDoc(doc(db('alice'), 'palette_users', 'alice', 'meals', 'm3'), { ...meal, dishes: Array(81).fill({}) }));
  await assertFails(setDoc(doc(db('alice'), 'palette_users', 'alice', 'meals', 'm3'), { ...meal, picks: [0, 1, 2, 3] }));
  await assertFails(setDoc(doc(db('alice'), 'palette_users', 'alice', 'meals', 'm3'), { ...meal, title: 'x'.repeat(81) }));
  await assertFails(setDoc(doc(db('alice'), 'palette_users', 'alice', 'meals', 'm3'), { ...meal, photo: 'base64…' }));
  await assertFails(deleteDoc(doc(db('bob'), 'palette_users', 'alice', 'meals', 'm1')));
  await assertSucceeds(deleteDoc(m));
});
test('palette: shared training sessions cannot be read or written from a browser', async () => {
  const s = { v: 1, intake: {}, rounds: [], roundCount: 0 };
  await seed((d) => setDoc(doc(d, 'palette_sessions', 'abcdefghijklmnop'), s));
  for (const who of [null, 'alice']) {
    await assertFails(setDoc(doc(db(who), 'palette_sessions', 'qrstuvwxyz123456'), s));
    await assertFails(getDoc(doc(db(who), 'palette_sessions', 'abcdefghijklmnop')));
    await assertFails(getDocs(collection(db(who), 'palette_sessions')));
    await assertFails(deleteDoc(doc(db(who), 'palette_sessions', 'abcdefghijklmnop')));
  }
});

// ───────── server-only and unknown collections ─────────
test('server-only collections and anything unlisted are closed', async () => {
  await seed((d) => setDoc(doc(d, 'ai_usage', 'x'), { count: 1 }));
  await assertFails(getDoc(doc(db('alice'), 'ai_usage', 'x')));
  await assertFails(setDoc(doc(db('alice'), 'ai_usage', 'x'), { count: 0 }));
  await assertFails(setDoc(doc(db('alice'), 'movi_film_stats', '0'), { films: {} }));
  await assertFails(setDoc(doc(db('alice'), 'movi_stats', 'top'), { films: [] }));
  await assertSucceeds(getDoc(doc(db('alice'), 'movi_stats', 'top')));
  await assertFails(setDoc(doc(db('alice'), 'users', 'alice'), { a: 1 }));
  await assertFails(getDoc(doc(db('alice'), 'anything', 'x')));
});
