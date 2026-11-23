// Deleting data. Apps are separate: deleting your Movi data leaves The Pantry and Where Have
// You Been alone. The sign-in itself (and the shared username) is removed only when no app
// has anything left for that person, or when they ask for everything to go.
import { UserFacingError } from './errors.js';

export const APPS = ['pantry', 'whyb', 'movi'];

async function deleteQuery(db, writer, query) {
  const snap = await query.get();
  snap.docs.forEach((d) => writer.delete(d.ref));
}

const erase = {
  async pantry(db, uid, writer) {
    await deleteQuery(db, writer, db.collection(`pantry_users/${uid}/recipes`));
    writer.delete(db.doc(`pantry_users/${uid}`));
  },
  async whyb(db, uid, writer, FieldValue) {
    const friendsOf = await db.collection('whyb_profiles').where('friends', 'array-contains', uid).get();
    friendsOf.docs.forEach((d) => writer.update(d.ref, { friends: FieldValue.arrayRemove(uid) }));
    await deleteQuery(db, writer, db.collection('whyb_requests').where('from', '==', uid));
    await deleteQuery(db, writer, db.collection('whyb_requests').where('to', '==', uid));
    writer.delete(db.doc(`whyb_profiles/${uid}`));
    writer.delete(db.doc(`whyb_users/${uid}`));
  },
  async movi(db, uid, writer) {
    const c = (name) => db.collection(name);
    await Promise.all([
      deleteQuery(db, writer, c('movi_entries').where('uid', '==', uid)),
      deleteQuery(db, writer, c('movi_follows').where('follower', '==', uid)),
      deleteQuery(db, writer, c('movi_follows').where('followee', '==', uid)),
      deleteQuery(db, writer, c('movi_activities').where('uid', '==', uid)), // likes/comments on them go via onActivityDeleted
      deleteQuery(db, writer, c('movi_likes').where('uid', '==', uid)),
      deleteQuery(db, writer, c('movi_comments').where('uid', '==', uid)),
      deleteQuery(db, writer, c('movi_recs').where('from', '==', uid)),
      deleteQuery(db, writer, c('movi_recs').where('to', '==', uid)),
      deleteQuery(db, writer, c('movi_notifications').where('uid', '==', uid)),
      deleteQuery(db, writer, c('movi_notifications').where('actor', '==', uid)),
    ]);
    for (const name of ['movi_lists', 'movi_watchlists', 'movi_backlogs', 'movi_profiles']) writer.delete(db.doc(`${name}/${uid}`));
  },
};

const HOME = { pantry: 'pantry_users', whyb: 'whyb_users', movi: 'movi_profiles' };

/**
 * @param app 'pantry' | 'whyb' | 'movi' | 'all'
 * @returns {{ deleted: string[], accountDeleted: boolean }}
 */
export async function deleteMyData({ db, auth, FieldValue }, uid, app) {
  if (!uid) throw new UserFacingError('unauthenticated', 'Sign in first.');
  if (app !== 'all' && !APPS.includes(app)) throw new UserFacingError('invalid-argument', 'Unknown app.');
  const targets = app === 'all' ? APPS : [app];
  const writer = db.bulkWriter();
  for (const a of targets) await erase[a](db, uid, writer, FieldValue);
  await writer.close();

  const left = await Promise.all(APPS.filter((a) => !targets.includes(a)).map((a) => db.doc(`${HOME[a]}/${uid}`).get()));
  const accountDeleted = left.every((s) => !s.exists);
  if (accountDeleted) {
    const account = await db.doc(`accounts/${uid}`).get();
    const batch = db.batch();
    const name = account.get('username');
    if (name) batch.delete(db.doc(`usernames/${name}`));
    batch.delete(db.doc(`accounts/${uid}`));
    await batch.commit();
    await auth.deleteUser(uid).catch((e) => { if (e?.code !== 'auth/user-not-found') throw e; });
  }
  return { deleted: targets, accountDeleted };
}
