# Handoff: one backend for The Pantry, Where Have You Been and Movi

Read this first in a new chat. It replaces the long chat that built everything. Last updated 25 Nov 2026.

## How the owner wants to work

- To-do lists for the owner go **in chat**, numbered, one step per line, **with a link on every step**. Not in docs.
- When something needs several steps from him, give them one at a time if he asks.
- Never ask him to paste a secret in chat. Public values (Firebase web config, reCAPTCHA site key) are fine.
- Be blunt about what is and isn't tested. No inflated praise.
- He is watching usage: keep tests to what is needed, avoid screenshots unless asked, use small fresh agents
  for self-contained jobs, and write a handoff like this one when a chat gets long.
- Hosting stays on `ngcoding10.github.io` for now. Moving onto the ASCoding site is a later, separate job.
- Ads (Google) are planned per site later. See `docs/STANDARD.md` → Ads.

## The pieces

| Piece | Repo | Live branch | Work branch | Live? |
|---|---|---|---|---|
| Backend (rules, functions, tests, shared web code) | `ngcoding10/backend-combination` | `main` (push = test + deploy) | `main` | **Yes**, on Firebase project `combination-23e84` |
| The Pantry (Astro + React) | `ngcoding10/recipes` | `claude/recipe-library-site-y0b77e` (GitHub Actions → Pages) | `claude/stoic-keller-0m98rl` | **Yes**, on the new backend since 24 Nov. Owner has not yet confirmed sign-in + an AI recipe work. |
| Where Have You Been (static) | `ngcoding10/wherehaveyoubeen` | `main` (Pages from branch) | `claude/stoic-keller-0m98rl` | **No.** Still the old version on old project `where-have-you-been-f130a`. |
| Movi (static, in `docs/`) | `ngcoding10/claude` | `claude/beli-app-template-BJhj8` (Pages from branch, `/docs`) | `claude/stoic-keller-0m98rl` | **No.** Still the old Supabase version. |

Each live branch got a `HANDOVER.md` describing the OLD setup. They are history now; this file is current.

Read next, in this repo: `docs/STANDARD.md` (the rules every app follows), `docs/DATA-MODEL.md`, `firestore.rules`.

## What is built and verified

- **Backend:** rules, indexes, 10 functions deployed. `npm test` = 44 checks (functions 10, conversion + fuzzy 7,
  rules 22, emulator end-to-end 5). Deploy and Tests workflows are green. Checked from outside: functions refuse
  callers without App Check; accounts cannot be listed.
- **Shared web code:** `web/core.js` (v1.1.0: sign-in, shared account + username, App Check, function calls) and
  `web/fuzzy.js` (typo-tolerant search). Each app holds a byte-identical copy; never edit a copy.
- **All three apps** on their work branches: pointed at `combination-23e84` with App Check site key, typo-tolerant
  search everywhere, emulator walkthroughs passing (Pantry 48/48 via `npm run test:e2e`; Where Have You Been 51/51
  three runs in a row via `tools/e2e-emulator.js`; Movi 27/27 via `tests/e2e-live.cjs`, demo tests 25/25).
- **Movi extras:** film list grew 36,115 → 39,259 (ids unchanged, new films appended), buried famous films lifted,
  alternate titles searchable, wording and design polish.

**Never tested against the real project:** a real Google sign-in, a real AI call with the owner's Claude keys,
App Check on the real domains, phones/Safari. The owner's Pantry test (below) is the first real check.

## How to run the emulator tests

Local calls must not go through the outbound proxy in the cloud sandbox:

```bash
cd backend-combination
FAKE_AI=1 env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npx firebase emulators:start --project demo-apps --only auth,firestore,functions
```

Then, with `NODE_PATH=$(npm root -g)` for Playwright: Pantry `npm run test:e2e`; Where Have You Been serve the folder
on port 8000 and `node tools/e2e-emulator.js`; Movi serve `docs/` on 8765 and `node tests/e2e-live.cjs`.
Tests stub or override the real config, so they never touch `combination-23e84`.

## What is left, in order

1. **Owner confirms The Pantry** on the live site: Google sign-in, create a recipe ("1 of 8 used today"), save,
   reload. If the AI call fails, the Pantry key in Secret Manager (`PANTRY_ANTHROPIC_KEY`) is the first suspect.
2. **Move old data, then release Where Have You Been.** Data must move BEFORE release so people keep their ids:
   owner adds repo secret `OLD_WHYB_SERVICE_ACCOUNT` (private key from the old project), then run the
   `Move old data` workflow → `whyb-from-old-firebase` in `look` mode, read the counts, then `commit`. Then release:
   merge `origin/main` (it has one extra commit: HANDOVER.md + old tests) into the work branch and fast-forward `main`.
   The script has only been tested on made-up data.
3. **Move Movi's data, then release Movi.** Owner adds `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; run
   `movi-from-supabase` `look` then `commit` (1 account, 35 rankings expected). Passwords do not carry over: an
   email+password account uses "Forgot password" once; Google accounts just sign in. Then merge the live branch's
   HANDOVER commit and fast-forward `claude/beli-app-template-BJhj8`.
   - A hand-copied Movi also lives at `ascoding11.com/movi` (repo `ASCoding11/ASCoding11.github.io`, folder `movi/`,
     plus an `/offline.js` line). It stays on Supabase until someone copies the new `docs/` over.
4. **After each app is confirmed:** switch on App Check enforcement for Firestore and Authentication
   (console → App Check → APIs). Only after all three are live and the App Check "verified requests" graphs look
   right. Then the owner can delete the old projects (`the-pantry-8e315`, `where-have-you-been-f130a`) and pause
   Supabase. Backups of what was moved are in the admin-only collection `_migration_backups`.
5. **Tidy:** owner can remove the `Project IAM Admin` role from the `firebase-adminsdk-fbsvc` account (only the
   first deploy needed it). Old key `movi-match-films` in the Claude console can go once Movi is confirmed.
6. **Movi posters:** about 1,770 of the 3,144 new films have one. `python3 tools/enrich_from_wikidata.py docs/data --minutes=110`
   adds roughly 500 per run (Wikipedia throttles). A free TMDB API key from the owner would finish it in minutes
   (`tools/fetch_tmdb_posters.py`); ask for it through the secure credential form, not chat.

## Launch checklist (owner's list), per site

Already in place on all three: HTTPS, favicon and app icons, Open Graph image and tags, unique titles and
descriptions, canonical links, `robots.txt`, `sitemap.xml`, custom 404, image alt text, mobile layout, loading /
empty / error states, sign-in, database rules with tests, secrets kept server-side, server-side input checks on
functions, daily AI limits, bot protection (App Check, to be enforced in step 4), versioned data files for caching.

| Item | State | Who |
|---|---|---|
| Privacy policy + terms | Movi has both. Pantry terms and both pages for Where Have You Been were being added on the work branches (check `git log`). | done / verify |
| Custom domain | Not set. Needed for ads, Search Console at the root, and for `robots.txt` to count (on `github.io/<app>` crawlers read only the root one). Adding a domain touches four settings: Auth authorized domains, reCAPTCHA key domains, `CORS` in `functions/index.js`, each app's canonical/sitemap URLs. | owner buys; then code change |
| Google Search Console | Needs the domain (or a `ngcoding10.github.io` user-site repo for verification). | owner |
| Database backups | Not set up. Firestore scheduled backups are a console/`gcloud` setting on `combination-23e84`. | owner clicks, or script it |
| Analytics | None, on purpose. Adding any (and ads) requires a cookie consent choice first and privacy page updates. | decide together |
| Error monitoring | None. Functions log to Google Cloud Logging. A small client error reporter is a possible addition. | to build |
| Uptime monitoring | None. A free external monitor on the three URLs is enough. | owner |
| Cookie consent | Not needed today (no analytics, no ads). Needed the day either is added. | later |
| Cross-browser / real phones | Only desktop Chromium at phone size was tested. | owner to try on a phone and Safari |
| Payments | None. | n/a |

## Things that would surprise you

- Pushing to `main` here deploys to production (after tests). There is no staging project.
- Movi film ids are positions in `docs/data/index.json`. Never reorder; only append. Anything "most popular first"
  sorts by popularity, not id.
- All apps share one origin, so they share Firebase sign-in state and browser storage; storage keys are prefixed
  `pantry.`, `whyb.`, `movi.`.
- Opening Movi while signed in elsewhere shows a "Join Movi as @name" screen; nothing is created until they join.
- `usernames/{name}` can be read by exact name without sign-in (the sign-up form needs it); neither usernames nor
  accounts can be listed.
- The owner pasted two Claude API keys and showed others in screenshots in the old chat and chose not to rotate
  them. Do not repeat them anywhere.

## Two newer apps (added 26 Nov 2026)

### GeoHistory (`ngcoding10/geohistory`, `main`, static, no backend yet)
Type a year, the world map redraws to that time, with powers, territories and events. Pushed to `main`; Pages not
yet turned on by the owner (repo must be public).
- State on 26 Nov after five rounds (`main` at `471b2ab`, pushed, clean): borders for every change-year 3400 BC-1885
  (Cliopatria, CC BY) and every year 1886-2019 (CShapes, non-commercial), sketch maps before that and as soft regions
  for stateless peoples; atlas-style look; empires draw as one at world zoom and split into parts when zoomed in (424
  dated memberships, 216 verified); Before/After in every state panel; WWI/WWII occupation overlay; about 131,000
  events (about 27,800 unverified Wikipedia year-article sentences); `tools/audit.py` 1,181 of 1,202; `tools/e2e.cjs`
  99 checks; `data/` about 104 MB (ceiling 150). Full known limits are in that repo's README.
- Clean-up round 6 finished 27 Nov (`main` at `7310d5b`, full rebuild, audit 1,222 of 1,236, e2e 100 of 100,
  `data/` 114 MB). Remote branch `wip-round6` is obsolete (its work is squashed into main); the proxy would not let
  me delete it, so the owner can delete it on GitHub.
- Left from that round: 14 audit failures (4 places blank in every source: Malwa 1450, Cuttack 1450, Berlin AD 100,
  Buenos Aires 1700; 10 source-map errors listed in the README); event types of unverified year-article entries are
  wrong or too general in 44 of 150 sampled (classifier not touched in round 6); first page load is 5.7 MB / ~7 s;
  199 empire memberships unverified; Before/After checked for only 25 states. Never checked: real phones, real GPUs.
- **The owner's priority is depth and accuracy above everything: "tons and tons of research, be super thorough".**
- Owner's decisions: non-commercial-licensed datasets ARE allowed (his call; record each in `CREDITS.md`; they must
  be swapped out or cleared before ads go on that site). Content written from AI knowledge is allowed, but mark it
  as curated, keep it conservative, and cross-check dates against Wikidata/Wikipedia wherever possible.
- Only one agent at a time in that repo.

### MyPalette (`ngcoding10/mypalette`, `main`; backend part on branch `mypalette` of THIS repo, NOT merged)
Learns what food someone likes from training rounds, then reads a menu photo and gives a top 3. Version 1 is built;
training works with no setup (`?train=1` is the link the owner sends to testers).
- **Do not merge branch `mypalette` into `main` until the secret `PALETTE_ANTHROPIC_KEY` exists**, or every deploy fails.
- Owner still has to: make the repo public (or pay for Pages), create the Claude workspace + key + secret, register a
  fourth web app and add it to App Check, turn on Pages. Then fill `js/config.js` and merge the backend branch.
- Never tested with real Claude or a real camera. Learner hit rates so far are on synthetic people only; the real
  test is `tools/evaluate.mjs` on exported tester sessions.
