// Movi site-wide averages rebuilt from everyone's lists, against the Firestore emulator.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rebuildStats } from '../functions/src/movi-stats.js';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: 'demo-apps' }, 'stats-test');
const db = getFirestore(app);
after(() => deleteApp(app));

test('averages, top list, skip when nothing changed, cleanup of emptied chunks', async () => {
  for (const coll of ['movi_lists', 'movi_film_stats', 'movi_stats']) for (const d of (await db.collection(coll).get()).docs) await d.ref.delete();
  const t0 = new Date(Date.now() - 60_000);
  await db.doc('movi_lists/a').set({ loved: [1, 2], fine: [], disliked: [4001], at: {}, updatedAt: t0 });
  await db.doc('movi_lists/b').set({ loved: [2], fine: [1], disliked: [], at: {}, updatedAt: t0 });

  const first = await rebuildStats(db);
  assert.deepEqual([first.skipped, first.members, first.films], [false, 2, 3]);
  assert.deepEqual((await db.doc('movi_film_stats/0').get()).get('films')['1'], [8, 2]);
  assert.deepEqual((await db.doc('movi_film_stats/2').get()).get('films')['4001'], [2.5, 1]);
  assert.deepEqual((await db.doc('movi_stats/top').get()).get('films').map((f) => f.filmId), [2, 1]);

  assert.equal((await rebuildStats(db)).skipped, true); // nobody ranked anything since

  await db.doc('movi_lists/a').set({ loved: [1, 2], fine: [], disliked: [], at: {}, updatedAt: new Date() });
  assert.equal((await rebuildStats(db)).skipped, false);
  assert.equal((await db.doc('movi_film_stats/2').get()).exists, false); // film 4001 no longer ranked by anyone
});
