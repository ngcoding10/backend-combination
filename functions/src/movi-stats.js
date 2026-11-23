// Movi site-wide film averages. Scores are never stored: they come from where a film sits in
// someone's list, with the same formula as scoreFor() in the Movi website (js/model.js).
export const BUCKETS = { loved: [6.8, 10], fine: [3.4, 6.7], disliked: [0, 3.3] };
export const CHUNK = 2000; // films per movi_film_stats document

const round1 = (x) => Math.round(x * 10) / 10;

export function scoreFor(bucket, pos, n) {
  const [lo, hi] = BUCKETS[bucket];
  return round1(n <= 1 ? lo + (hi - lo) * 0.75 : hi - (hi - lo) * (pos / (n - 1)));
}

const validId = (v) => Number.isInteger(v) && v >= 0 && v < 10_000_000;

/** Every (filmId, score) in one person's lists. Ignores junk and repeats. */
export function scoresOf(lists) {
  const out = new Map();
  for (const bucket of Object.keys(BUCKETS)) {
    const ids = (Array.isArray(lists?.[bucket]) ? lists[bucket] : []).filter(validId);
    ids.forEach((id, pos) => { if (!out.has(id)) out.set(id, scoreFor(bucket, pos, ids.length)); });
  }
  return out;
}

/**
 * @param {Iterable<object>} allLists every movi_lists document's data
 * @returns {{ chunks: Map<string, Record<string, [number, number]>>, top: Array<{filmId:number, avg:number, n:number}> }}
 *   chunks: chunk id -> { filmId: [average, count] }
 */
export function aggregate(allLists, { topLimit = 100 } = {}) {
  const sum = new Map(), cnt = new Map();
  for (const lists of allLists) {
    for (const [id, score] of scoresOf(lists)) {
      sum.set(id, (sum.get(id) ?? 0) + score);
      cnt.set(id, (cnt.get(id) ?? 0) + 1);
    }
  }
  const chunks = new Map();
  const rows = [];
  for (const [id, n] of cnt) {
    const avg = round1(sum.get(id) / n);
    const key = String(Math.floor(id / CHUNK));
    if (!chunks.has(key)) chunks.set(key, {});
    chunks.get(key)[id] = [avg, n];
    rows.push({ filmId: id, avg, n, raw: sum.get(id) / n });
  }
  const top = rows.filter((r) => r.n >= 2).sort((a, b) => b.raw - a.raw || b.n - a.n).slice(0, topLimit).map(({ raw, ...r }) => r);
  return { chunks, top };
}

/** Rebuild movi_film_stats/* and movi_stats/top. Skips the work when no list changed since the last run. */
export async function rebuildStats(db, { force = false, now = new Date() } = {}) {
  const metaRef = db.doc('movi_stats/meta');
  const meta = (await metaRef.get()).data() ?? {};
  if (!force && meta.builtAt) {
    const changed = await db.collection('movi_lists').where('updatedAt', '>', meta.builtAt).limit(1).get();
    if (changed.empty) return { skipped: true };
  }
  const snap = await db.collection('movi_lists').get();
  const { chunks, top } = aggregate(snap.docs.map((d) => d.data()));
  const writer = db.bulkWriter();
  for (const [key, films] of chunks) writer.set(db.doc(`movi_film_stats/${key}`), { films, builtAt: now });
  for (const key of meta.chunks ?? []) if (!chunks.has(key)) writer.delete(db.doc(`movi_film_stats/${key}`));
  writer.set(db.doc('movi_stats/top'), { films: top, builtAt: now });
  await writer.close();
  await metaRef.set({ builtAt: now, chunks: [...chunks.keys()], members: snap.size });
  return { skipped: false, members: snap.size, films: [...chunks.values()].reduce((a, c) => a + Object.keys(c).length, 0) };
}
