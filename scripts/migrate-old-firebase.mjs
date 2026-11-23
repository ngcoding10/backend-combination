// One-off: copy an app's accounts and data from its old Firebase project into this one.
//   node scripts/migrate-old-firebase.mjs whyb            look only (saves a backup, prints counts)
//   node scripts/migrate-old-firebase.mjs whyb --commit   also writes
//   node scripts/migrate-old-firebase.mjs pantry [--commit]
// Needs env: OLD_SERVICE_ACCOUNT (JSON key of the OLD project), NEW_SERVICE_ACCOUNT (JSON key of the new one).
// People keep the same account id, so Google sign-in lands on the same data. Safe to run twice.
import { connect, importUsers, saveBackup, settleUsernames } from './lib/admin.mjs';

const app = process.argv[2];
const commit = process.argv.includes('--commit');
if (!['whyb', 'pantry'].includes(app)) throw new Error('first argument must be whyb or pantry');
const old = connect('OLD_SERVICE_ACCOUNT', 'old');
const fresh = connect('NEW_SERVICE_ACCOUNT', 'new');
if (old.projectId === fresh.projectId) throw new Error('old and new project are the same');

const all = async (coll) => (await old.db.collection(coll).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
const users = [];
for (let page; ;) {
  const res = await old.auth.listUsers(1000, page);
  users.push(...res.users);
  if (!(page = res.pageToken)) break;
}
const authImport = users.map((u) => ({
  uid: u.uid, email: u.email, emailVerified: u.emailVerified, displayName: u.displayName, photoURL: u.photoURL,
  metadata: { creationTime: u.metadata.creationTime, lastSignInTime: u.metadata.lastSignInTime },
  providerData: u.providerData.filter((p) => p.providerId === 'google.com').map((p) => ({ providerId: p.providerId, uid: p.uid, email: p.email, displayName: p.displayName, photoURL: p.photoURL })),
}));

const docs = [];
const put = (path, data) => docs.push({ path, data });
let backup;

if (app === 'pantry') {
  const people = await all('users');
  backup = { users: authImport, people, recipes: {} };
  for (const p of people) {
    put(`pantry_users/${p.id}`, { pantry: Array.isArray(p.data.pantry) ? p.data.pantry.slice(0, 200) : [], updatedAt: new Date() });
    const recipes = (await old.db.collection(`users/${p.id}/recipes`).get()).docs;
    backup.recipes[p.id] = recipes.map((d) => ({ id: d.id, data: d.data() }));
    for (const r of recipes) put(`pantry_users/${p.id}/recipes/${r.id}`, r.data());
  }
} else {
  const [books, profiles, names, requests] = await Promise.all([all('users'), all('profiles'), all('usernames'), all('requests')]);
  backup = { users: authImport, books, profiles, names, requests };
  const nameOf = new Map(profiles.filter((p) => p.data.username).map((p) => [p.id, p.data.username]));
  const settled = await settleUsernames(fresh.db, [...nameOf].map(([uid, username]) => ({ uid, username, fallback: 'traveller' })));
  const display = new Map(users.map((u) => [u.uid, (u.displayName ?? '').slice(0, 40)]));
  for (const b of books) put(`whyb_users/${b.id}`, { book: String(b.data.book ?? ''), settings: String(b.data.settings ?? '{}'), name: String(b.data.name ?? ''), updatedAt: new Date() });
  for (const [uid, username] of settled) {
    const existing = await fresh.db.doc(`accounts/${uid}`).get();
    if (!existing.exists) {
      put(`accounts/${uid}`, { username, displayName: display.get(uid) ?? '', createdAt: new Date(), updatedAt: new Date() });
      put(`usernames/${username}`, { uid });
    }
  }
  for (const p of profiles) {
    if (!settled.has(p.id)) continue;
    const { username, name, stats, visited, friends } = p.data;
    put(`whyb_profiles/${p.id}`, { username: settled.get(p.id), name: String(name ?? '').slice(0, 40), stats: stats ?? {}, visited: visited ?? {}, friends: Array.isArray(friends) ? friends : [], updatedAt: new Date() });
  }
  for (const r of requests) {
    if (!settled.has(r.data.from) || !settled.has(r.data.to)) continue;
    put(`whyb_requests/${r.id}`, { from: r.data.from, to: r.data.to, fromName: settled.get(r.data.from), toName: settled.get(r.data.to), createdAt: r.data.createdAt ?? new Date() });
  }
}

const byCollection = {};
for (const d of docs) byCollection[d.path.split('/')[0]] = (byCollection[d.path.split('/')[0]] ?? 0) + 1;
console.log(`read from ${app}'s old project: ${users.length} accounts`);
console.log('backup saved in the new project:', await saveBackup(fresh.db, `${app}-old-firebase`, backup));
console.log('would write:', byCollection);
if (!commit) { console.log('Look-only run. Nothing was written except the backup. Run again with --commit.'); process.exit(0); }
console.log('accounts:', await importUsers(fresh.auth, authImport.filter((u) => u.email)));
const writer = fresh.db.bulkWriter();
for (const d of docs) writer.set(fresh.db.doc(d.path), d.data);
await writer.close();
console.log(`wrote ${docs.length} documents. Done.`);
