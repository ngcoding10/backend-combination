# backend-combination

The one backend behind The Pantry, Where Have You Been and Movi: sign-in, database rules,
Cloud Functions and their tests. The app repos hold only their websites and the public web config.

- `firestore.rules`, `firestore.indexes.json` — who can read and write what
- `functions/` — Cloud Functions (AI calls with daily limits, Movi notifications and averages, account deletion)
- `web/core.js` — the Firebase code every app copies unchanged
- `web/fuzzy.js` — typo-tolerant search every app copies unchanged
- `tests/` — rules tests and end-to-end tests that run on the local emulators
- `scripts/` — one-off data moves from the old projects
- `HANDOFF.md` — current state and what is left (read this first)
- `docs/` — [STANDARD.md](docs/STANDARD.md) (how every app is built), [DATA-MODEL.md](docs/DATA-MODEL.md)

```bash
npm install && npm --prefix functions install
npm test          # needs Java for the emulators
```
