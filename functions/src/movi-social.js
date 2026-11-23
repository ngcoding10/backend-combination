// Movi: notifications and like/comment counts. Members can never write a notification or a
// count themselves (see firestore.rules); these run when a like, comment, follow or
// recommendation is written. Each handler is safe to run twice for the same event:
// notification ids are derived from the thing that caused them, and counts are recounted.

const notifRef = (db, id) => db.doc(`movi_notifications/${id}`);

async function recount(db, activityId) {
  const ref = db.doc(`movi_activities/${activityId}`);
  const [likes, comments, act] = await Promise.all([
    db.collection('movi_likes').where('activityId', '==', activityId).count().get(),
    db.collection('movi_comments').where('activityId', '==', activityId).count().get(),
    ref.get(),
  ]);
  if (!act.exists) return null;
  await ref.update({ likeCount: likes.data().count, commentCount: comments.data().count });
  return act.data();
}

export async function onLikeWritten(db, { before, after, id, now }) {
  const like = after ?? before;
  const act = await recount(db, like.activityId);
  const ref = notifRef(db, `like_${id}`);
  if (!after) return ref.delete();
  if (act && act.uid !== like.uid) {
    await ref.set({ uid: act.uid, actor: like.uid, kind: 'like', activityId: like.activityId, filmId: act.filmId, body: '', read: false, createdAt: now });
  }
}

export async function onCommentWritten(db, { before, after, id, now }) {
  const c = after ?? before;
  const act = await recount(db, c.activityId);
  const ref = notifRef(db, `comment_${id}`);
  if (!after) return ref.delete();
  if (act && act.uid !== c.uid) {
    await ref.set({ uid: act.uid, actor: c.uid, kind: 'comment', activityId: c.activityId, filmId: act.filmId, body: String(c.body ?? '').slice(0, 140), read: false, createdAt: now });
  }
}

export async function onFollowWritten(db, { after, id, now }) {
  const ref = notifRef(db, `follow_${id}`);
  if (!after) return ref.delete();
  await ref.set({ uid: after.followee, actor: after.follower, kind: 'follow', activityId: null, filmId: null, body: '', read: false, createdAt: now });
}

export async function onRecCreated(db, { after, id, now }) {
  await notifRef(db, `rec_${id}`).set({ uid: after.to, actor: after.from, kind: 'rec', activityId: null, filmId: after.filmId, body: String(after.message ?? '').slice(0, 140), read: false, createdAt: now });
}

/** When a post is deleted, remove its likes, comments and the notifications about it. */
export async function onActivityDeleted(db, { id }) {
  const writer = db.bulkWriter();
  for (const coll of ['movi_likes', 'movi_comments', 'movi_notifications']) {
    const snap = await db.collection(coll).where('activityId', '==', id).get();
    snap.docs.forEach((d) => writer.delete(d.ref));
  }
  await writer.close();
}
