// Export MyPalette's consented, anonymous training sessions for evaluation.
//   NEW_SERVICE_ACCOUNT='<deploy key JSON>' node scripts/export-palette-sessions.mjs palette-sessions.json
// The file is what `node tools/evaluate.mjs palette-sessions.json` in the mypalette repo reads.
// Sessions hold a random id, intake answers (no free text) and menu choices; no names, emails or uids.
import { writeFileSync } from 'node:fs';
import { connect } from './lib/admin.mjs';

const out = process.argv[2] ?? 'palette-sessions.json';
const { db } = connect('NEW_SERVICE_ACCOUNT', 'palette-export');
const snap = await db.collection('palette_sessions').get();
const sessions = snap.docs.map((d) => {
  const s = d.data();
  return { id: d.id, intake: s.intake ?? {}, rounds: s.rounds ?? [], updatedAt: s.updatedAt?.toDate?.().toISOString() ?? null };
});
writeFileSync(out, `${JSON.stringify({ exportedAt: new Date().toISOString(), sessions }, null, 1)}\n`);
console.log(`${sessions.length} sessions, ${sessions.reduce((a, s) => a + s.rounds.length, 0)} rounds -> ${out}`);
