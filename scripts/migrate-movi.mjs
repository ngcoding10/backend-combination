// One-off: copy Movi from Supabase into this Firebase project.
//   node scripts/migrate-movi.mjs            look only: reads everything, saves a backup, prints counts
//   node scripts/migrate-movi.mjs --commit   also writes accounts and data
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEW_SERVICE_ACCOUNT (JSON key of the new project).
// Safe to run twice: accounts that already exist are skipped and documents are overwritten with the same content.
// Passwords cannot be read out of Supabase this way, so email + password members use "Forgot password" once;
// members who used Google just sign in with Google.
import { connect, importUsers, saveBackup, settleUsernames } from './lib/admin.mjs';
import { authRecords, transformMovi } from './lib/movi-transform.mjs';

const commit = process.argv.includes('--commit');
const base = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function table(name) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${base}/rest/v1/${name}?select=*`, { headers: { ...headers, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    if (res.status === 404) return []; // table never created (e.g. backlog)
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
async function authUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers });
    if (!res.ok) throw new Error(`auth users: HTTP ${res.status}`);
    const body = await res.json();
    users.push(...(body.users ?? []));
    if ((body.users ?? []).length < 1000) return users;
  }
}

const tables = ['profiles', 'rankings', 'watchlist', 'backlog', 'follows', 'activities', 'likes', 'comments', 'recommendations'];
const dump = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await table(t)])));
const users = await authUsers();
console.log('read from Supabase:', Object.fromEntries([['auth users', users.length], ...tables.map((t) => [t, dump[t].length])]));

const fresh = connect('NEW_SERVICE_ACCOUNT', 'new');
console.log('backup saved in the new project:', await saveBackup(fresh.db, 'movi-supabase', { users, ...dump }));

const usernames = await settleUsernames(fresh.db, dump.profiles.map((p) => ({ uid: p.id, username: p.username, fallback: 'movi' })));
const changed = dump.profiles.filter((p) => usernames.get(p.id) !== p.username).length;
const docs = transformMovi(dump, usernames);
const byCollection = {};
for (const d of docs) byCollection[d.path.split('/')[0]] = (byCollection[d.path.split('/')[0]] ?? 0) + 1;
console.log('would write:', byCollection, `| usernames that had to change: ${changed}`);

if (!commit) { console.log('Look-only run. Nothing was written except the backup. Run again with --commit.'); process.exit(0); }
console.log('accounts:', await importUsers(fresh.auth, authRecords(users)));
const writer = fresh.db.bulkWriter();
for (const d of docs) writer.set(fresh.db.doc(d.path), d.data);
await writer.close();
console.log(`wrote ${docs.length} documents. Done.`);
