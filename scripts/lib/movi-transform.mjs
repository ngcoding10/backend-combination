// Pure conversion of a Movi Supabase dump into the Firestore documents described in
// docs/DATA-MODEL.md. No network here, so it can be tested (tests/migrate.test.mjs).
const ms = (iso) => (iso ? Date.parse(iso) : Date.now());

/**
 * @param dump { profiles, rankings, watchlist, backlog, follows, activities, likes, comments, recommendations }
 * @param usernames Map<uid, username> (already made valid and unique)
 * @returns Array<{ path, data }> where Date values are real Dates
 */
export function transformMovi(dump, usernames) {
  const docs = [];
  const put = (path, data) => docs.push({ path, data });
  const known = new Set(dump.profiles.map((p) => p.id));
  const actId = (id) => `sb${id}`;
  const liveActs = new Set(dump.activities.filter((a) => known.has(a.user_id)).map((a) => a.id));

  for (const p of dump.profiles) {
    const uid = p.id, username = usernames.get(uid);
    const mine = dump.rankings.filter((r) => r.user_id === uid);
    const lists = { loved: [], fine: [], disliked: [] }, at = {};
    const seen = new Set();
    for (const bucket of Object.keys(lists)) {
      for (const r of mine.filter((x) => x.bucket === bucket).sort((a, b) => a.pos - b.pos)) {
        if (seen.has(r.film_id)) continue;
        seen.add(r.film_id);
        lists[bucket].push(r.film_id);
        at[r.film_id] = ms(r.created_at);
      }
    }
    const displayName = String(p.display_name || username).slice(0, 40);
    const created = new Date(ms(p.created_at));
    put(`accounts/${uid}`, { username, displayName, createdAt: created, updatedAt: new Date() });
    put(`usernames/${username}`, { uid });
    put(`movi_profiles/${uid}`, {
      username, displayName, nameLower: displayName.toLowerCase(), bio: String(p.bio ?? '').slice(0, 160),
      avatarHue: Math.min(359, Math.max(0, Math.trunc(p.avatar_hue ?? 40))), yearlyGoal: Math.min(1000, Math.max(1, Math.trunc(p.yearly_goal ?? 52))),
      rankedCount: seen.size, createdAt: created,
    });
    put(`movi_lists/${uid}`, { ...lists, at, updatedAt: new Date() });
    for (const r of mine) {
      if (!(r.note || r.watched_on || r.watched_where || r.watched_with || r.rewatch)) continue;
      put(`movi_entries/${uid}_${r.film_id}`, {
        uid, filmId: r.film_id, note: String(r.note ?? '').slice(0, 2000), watchedOn: r.watched_on ?? null,
        watchedWhere: String(r.watched_where ?? '').slice(0, 40), watchedWith: String(r.watched_with ?? '').slice(0, 120),
        rewatch: !!r.rewatch, updatedAt: new Date(ms(r.updated_at)),
      });
    }
    const want = Object.fromEntries(dump.watchlist.filter((w) => w.user_id === uid).map((w) => [w.film_id, { at: ms(w.created_at), from: known.has(w.from_user) ? w.from_user : null }]));
    if (Object.keys(want).length) put(`movi_watchlists/${uid}`, { items: want, updatedAt: new Date() });
    const todo = Object.fromEntries((dump.backlog ?? []).filter((b) => b.user_id === uid).map((b) => [b.film_id, ms(b.created_at)]));
    if (Object.keys(todo).length) put(`movi_backlogs/${uid}`, { items: todo, updatedAt: new Date() });
  }
  // every account is public now: pending follow requests are dropped, accepted ones kept
  for (const f of dump.follows) {
    if (f.status !== 'accepted' || !known.has(f.follower) || !known.has(f.followee)) continue;
    put(`movi_follows/${f.follower}_${f.followee}`, { follower: f.follower, followee: f.followee, createdAt: new Date(ms(f.created_at)) });
  }
  for (const a of dump.activities) {
    if (!liveActs.has(a.id)) continue;
    put(`movi_activities/${actId(a.id)}`, {
      uid: a.user_id, kind: a.kind, filmId: a.film_id, bucket: a.bucket ?? null, score: a.score == null ? null : Number(a.score),
      note: String(a.note ?? ''), createdAt: new Date(ms(a.created_at)),
      likeCount: dump.likes.filter((l) => l.activity_id === a.id && known.has(l.user_id)).length,
      commentCount: dump.comments.filter((c) => c.activity_id === a.id && known.has(c.user_id)).length,
    });
  }
  for (const l of dump.likes) {
    if (!liveActs.has(l.activity_id) || !known.has(l.user_id)) continue;
    put(`movi_likes/${actId(l.activity_id)}_${l.user_id}`, { activityId: actId(l.activity_id), uid: l.user_id, createdAt: new Date(ms(l.created_at)) });
  }
  for (const c of dump.comments) {
    if (!liveActs.has(c.activity_id) || !known.has(c.user_id)) continue;
    put(`movi_comments/sb${c.id}`, { activityId: actId(c.activity_id), uid: c.user_id, body: String(c.body).slice(0, 500), createdAt: new Date(ms(c.created_at)) });
  }
  for (const r of dump.recommendations) {
    if (!known.has(r.from_user) || !known.has(r.to_user)) continue;
    put(`movi_recs/sb${r.id}`, { from: r.from_user, to: r.to_user, filmId: r.film_id, message: String(r.message ?? '').slice(0, 280), createdAt: new Date(ms(r.created_at)) });
  }
  return docs;
}

/** Supabase auth users -> Firebase import records (same ids; Google links kept; no passwords). */
export function authRecords(users) {
  return users.filter((u) => u.email).map((u) => {
    const google = (u.identities ?? []).find((i) => i.provider === 'google');
    const sub = google?.identity_data?.sub ?? google?.provider_id;
    const meta = u.user_metadata ?? {};
    return {
      uid: u.id, email: u.email, emailVerified: !!(u.email_confirmed_at || u.confirmed_at),
      displayName: String(meta.display_name || meta.full_name || meta.name || '').slice(0, 100) || undefined,
      metadata: { creationTime: u.created_at ? new Date(u.created_at).toUTCString() : undefined, lastSignInTime: u.last_sign_in_at ? new Date(u.last_sign_in_at).toUTCString() : undefined },
      providerData: google && sub ? [{ providerId: 'google.com', uid: String(sub), email: u.email, displayName: meta.full_name || meta.name || undefined }] : [],
    };
  });
}
