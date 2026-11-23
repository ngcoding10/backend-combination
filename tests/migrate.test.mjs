// The Supabase -> Firestore conversion, checked on a small made-up dump (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authRecords, transformMovi } from '../scripts/lib/movi-transform.mjs';

const t = '2026-11-01T10:00:00.000Z';
const dump = {
  profiles: [
    { id: 'u1', username: 'nico', display_name: 'Nico', bio: 'hi', avatar_hue: 200, is_private: true, yearly_goal: 30, ranked_count: 3, created_at: t },
    { id: 'u2', username: 'sam', display_name: '', bio: '', avatar_hue: 10, is_private: false, yearly_goal: 52, ranked_count: 0, created_at: t },
  ],
  rankings: [
    { user_id: 'u1', film_id: 7, bucket: 'loved', pos: 1, score: 6.8, note: '', watched_on: null, watched_where: '', watched_with: '', rewatch: false, created_at: t, updated_at: t },
    { user_id: 'u1', film_id: 5, bucket: 'loved', pos: 0, score: 10, note: 'great', watched_on: '2026-10-01', watched_where: 'Theater', watched_with: 'Sam', rewatch: true, created_at: t, updated_at: t },
    { user_id: 'u1', film_id: 9, bucket: 'disliked', pos: 0, score: 2.5, note: '', watched_on: null, watched_where: '', watched_with: '', rewatch: false, created_at: t, updated_at: t },
  ],
  watchlist: [{ user_id: 'u2', film_id: 5, from_user: 'u1', created_at: t }, { user_id: 'u2', film_id: 6, from_user: 'gone', created_at: t }],
  backlog: [{ user_id: 'u1', film_id: 11, created_at: t }],
  follows: [{ follower: 'u2', followee: 'u1', status: 'pending', created_at: t }, { follower: 'u1', followee: 'u2', status: 'accepted', created_at: t }],
  activities: [{ id: 3, user_id: 'u1', kind: 'ranked', film_id: 5, bucket: 'loved', score: '10.0', note: '', created_at: t }, { id: 4, user_id: 'gone', kind: 'want', film_id: 1, bucket: null, score: null, note: '', created_at: t }],
  likes: [{ activity_id: 3, user_id: 'u2', created_at: t }, { activity_id: 4, user_id: 'u2', created_at: t }],
  comments: [{ id: 8, activity_id: 3, user_id: 'u2', body: 'yes', created_at: t }],
  recommendations: [{ id: 2, from_user: 'u2', to_user: 'u1', film_id: 6, message: 'try it', created_at: t }],
};

test('movi dump becomes the documented Firestore shape', () => {
  const docs = new Map(transformMovi(dump, new Map([['u1', 'nico'], ['u2', 'sam']])).map((d) => [d.path, d.data]));
  assert.deepEqual(docs.get('usernames/nico'), { uid: 'u1' });
  const p = docs.get('movi_profiles/u1');
  assert.deepEqual([p.username, p.displayName, p.nameLower, p.rankedCount, p.avatarHue, p.yearlyGoal], ['nico', 'Nico', 'nico', 3, 200, 30]);
  assert.equal('isPrivate' in p, false);
  assert.equal(docs.get('movi_profiles/u2').displayName, 'sam'); // empty display name falls back to the username
  const lists = docs.get('movi_lists/u1');
  assert.deepEqual([lists.loved, lists.fine, lists.disliked], [[5, 7], [], [9]]); // ordered by position
  assert.equal(lists.at[5], Date.parse(t));
  assert.deepEqual(Object.keys(docs.get('movi_entries/u1_5')).sort(), ['filmId', 'note', 'rewatch', 'uid', 'updatedAt', 'watchedOn', 'watchedWhere', 'watchedWith']);
  assert.equal(docs.has('movi_entries/u1_7'), false); // nothing to keep
  assert.deepEqual(docs.get('movi_watchlists/u2').items, { 5: { at: Date.parse(t), from: 'u1' }, 6: { at: Date.parse(t), from: null } });
  assert.deepEqual(docs.get('movi_backlogs/u1').items, { 11: Date.parse(t) });
  assert.equal(docs.has('movi_follows/u1_u2'), true);
  assert.equal(docs.has('movi_follows/u2_u1'), false); // pending requests are dropped
  const act = docs.get('movi_activities/sb3');
  assert.deepEqual([act.uid, act.score, act.likeCount, act.commentCount], ['u1', 10, 1, 1]);
  assert.equal(docs.has('movi_activities/sb4'), false); // author no longer exists
  assert.equal(docs.has('movi_likes/sb4_u2'), false);
  assert.equal(docs.get('movi_comments/sb8').activityId, 'sb3');
  assert.equal(docs.get('movi_recs/sb2').to, 'u1');
});

test('auth users keep their id and Google link', () => {
  const [a, b] = authRecords([
    { id: 'u1', email: 'n@example.com', email_confirmed_at: t, created_at: t, user_metadata: { full_name: 'Nico G' }, identities: [{ provider: 'google', identity_data: { sub: '12345' } }] },
    { id: 'u2', email: 's@example.com', created_at: t, user_metadata: {}, identities: [{ provider: 'email' }] },
    { id: 'u3' },
  ]);
  assert.deepEqual([a.uid, a.emailVerified, a.displayName, a.providerData[0].uid, a.providerData[0].providerId], ['u1', true, 'Nico G', '12345', 'google.com']);
  assert.deepEqual([b.uid, b.emailVerified, b.providerData], ['u2', false, []]);
});
