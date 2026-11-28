# Data model

One Firestore database for every app. Shared collections have no prefix; each app's
collections start with its prefix. `firestore.rules` is the source of truth for who can do
what; this page is the map.

Every write that says "server time" must use `serverTimestamp()` — the rules reject anything else.

## Shared

| Path | Fields | Who |
|---|---|---|
| `accounts/{uid}` | `username`, `displayName` (≤40), `createdAt`, `updatedAt` (server time) | a signed-in person can read one account by id; nobody can list them. write: owner, only together with `usernames/{username}` |
| `usernames/{name}` | `uid` | anyone can look up one exact name; nobody can list them. One name per person; names are `^[a-z0-9_.]{3,20}$` |
| `ai_usage/{app}_{day}_{uid}` and `…_total` | daily AI counters (also GeoHistory's suggestion caps, keyed by a salted one-day address hash) | Cloud Functions only |
| `config/admins`, `config/geo_salt` | admin uids per app (`geohistory: [uid]`, added to `functions/admins.json`); the random salt for address hashes | Cloud Functions only; no browser can read them |

Use `core.account.claim(name)` from `web/core.js` — never write these two by hand. A person gets
an account record the first time an app needs a username. Using one app does not create
anything in the others.

## The Pantry (`pantry_`)

| Path | Fields |
|---|---|
| `pantry_users/{uid}` | `pantry`: string[] (≤200), `updatedAt` (server time). Owner only. |
| `pantry_users/{uid}/recipes/{id}` | `recipe` (map with `title`), `request` (map or null), `createdAt` (timestamp). Owner only. |

Functions: `pantryGenerateRecipe(RecipeRequest) → { recipe, usage }`,
`pantryCheckLabel({ kind, text, image, flagged }) → { result, usage }`. `usage` is `{ used, limit }`.

## Where Have You Been (`whyb_`)

| Path | Fields |
|---|---|
| `whyb_users/{uid}` | `book` (JSON string), `settings` (JSON string), `name`, `updatedAt` (server time). Owner only. |
| `whyb_profiles/{uid}` | `username` (must equal the account's), `name`, `stats`, `visited`, `friends`: uid[], `updatedAt`. Read: owner and friends. |
| `whyb_requests/{to}_{from}` | the receiver must have a `whyb_profiles` doc. `from`, `to`, `fromName` (sender's username), `toName`, `createdAt` (server time) |

## Movi (`movi_`)

Every Movi account is public to signed-in members (no private accounts, no follow requests).

| Path | Fields | Notes |
|---|---|---|
| `movi_profiles/{uid}` | `username`, `displayName`, `nameLower`, `bio` (≤160), `avatarHue` 0–359, `yearlyGoal` 1–1000, `rankedCount`, `createdAt` | all eight fields required. `rankedCount` must equal the size of the lists, so write both in one batch |
| `movi_lists/{uid}` | `loved`, `fine`, `disliked`: film ids, best first. `at`: `{ filmId: ms first ranked }`. `updatedAt` (server time) | the whole ranking in one document. Scores are worked out from position (`scoreFor` in `js/model.js`), never stored |
| `movi_entries/{uid}_{filmId}` | `uid`, `filmId`, `note` (≤2000), `watchedOn` (`YYYY-MM-DD` or null), `watchedWhere`, `watchedWith`, `rewatch`, `updatedAt` | only for films that have notes or watch details |
| `movi_watchlists/{uid}` | `items`: `{ filmId: { at: ms, from: uid or null } }`, `updatedAt` | public |
| `movi_backlogs/{uid}` | `items`: `{ filmId: ms }`, `updatedAt` | private ("To rank") |
| `movi_follows/{follower}_{followee}` | `follower`, `followee`, `createdAt` | either side can delete |
| `movi_activities/{id}` | `uid`, `kind` (`ranked`/`want`), `filmId`, `bucket`, `score`, `note`, `createdAt`, `likeCount`, `commentCount` | counts start at 0 and are kept by functions |
| `movi_likes/{activityId}_{uid}` | `activityId`, `uid`, `createdAt` | |
| `movi_comments/{id}` | `activityId`, `uid`, `body` (1–500), `createdAt` | author or the post's owner can delete |
| `movi_recs/{id}` | `from`, `to`, `filmId`, `message` (≤280), `createdAt` | sender and receiver only |
| `movi_notifications/{id}` | `uid`, `actor`, `kind` (`follow`/`like`/`comment`/`rec`), `activityId`, `filmId`, `body`, `read`, `createdAt` | written by functions; owner can set `read` or delete |
| `movi_film_stats/{chunk}` | `films`: `{ filmId: [average, count] }`, `builtAt` | chunk = `floor(filmId / 2000)`. Rebuilt hourly by a function |
| `movi_stats/top` | `films`: `[{ filmId, avg, n }]` (up to 100, at least 2 rankings each) | rebuilt hourly |

Functions: `moviMatchFilms({ lines: [{ text, hints: [{ title, year }] }] }) → { results, usage }`.

Queries the rules and indexes support:
- feed, everyone: `movi_activities` ordered by `createdAt` desc
- feed, following: `where('uid', 'in', ≤30 ids)` + `orderBy('createdAt', 'desc')` (split into groups of 30 and merge)
- who ranked a film: `movi_lists` `where('loved' | 'fine' | 'disliked', 'array-contains', filmId)` (three queries)
- people search: `movi_profiles` prefix match on `username` or `nameLower` (`>= q`, `< q + ''`)
- `movi_notifications` `where('uid', '==', me)` + `orderBy('createdAt', 'desc')`; `movi_recs` `where('to', '==', me)` + `orderBy('createdAt', 'desc')`
- `movi_comments` `where('activityId', '==', id)` + `orderBy('createdAt')`

## MyPalette (`palette_`)

| Path | Fields |
|---|---|
| `palette_users/{uid}` | `intake` (map, ≤20 keys: diet rules, allergies, never-eat, spice 0–3, adventure 0–2, liked cuisines), `weights` (map, ≤400: the learner's feature weights), `stats` (map, optional), `history` (JSON string ≤600k: training rounds and meal feedback), `updatedAt` (server time). Owner only. |
| `palette_users/{uid}/meals/{id}` | `title` (≤80), `cuisine` (≤60), `dishes` (list ≤80, the menu as read), `picks` (≤3), `ordered` (≤12), `ratings` (map ≤12), `createdAt` (timestamp). Owner only. |
| `palette_sessions/{id}` | `v`, `intake` (no free text), `rounds` (`menu`, `predicted`, `picked`, `never`, `at`), `roundCount`, `updatedAt`. Anonymous training sessions shared with consent. **No browser access**: written only by `paletteShareSession`, exported by `scripts/export-palette-sessions.mjs` (or the "Export MyPalette sessions" workflow). |

Functions: `paletteReadMenu({ image?, text?, profile, context }) → { menu, usage }` (signed in, metered: `PALETTE_DAILY_PER_USER`, `PALETTE_DAILY_TOTAL`, key `PALETTE_ANTHROPIC_KEY`).
`paletteShareSession({ id, session } | { id, remove: true }) → { saved } | { removed }` (works signed out; App Check
plus a daily cap of 300 writes per person or network address, 20,000 for everyone; no AI). The photo is never stored.

## GeoHistory (`geo_`)

| Path | Fields |
|---|---|
| `geo_suggestions/{id}` | `text` (10–2,000), `place` (≤120), `date` (≤60, as typed), `year` (int or null), `subject` (`{ kind: polity/empire/event/us/colony/modern, id, name }` or null), `sourceUrl` (http(s) or ''), `email` (only if given), `status` (`new`/`reviewing`/`added`/`rejected`), `note` (admin, ≤2,000), `createdAt`, `updatedAt`, `updatedBy`. **No browser access.** No address, uid or other data about the sender is stored. |

Functions: `geoSuggest({ text, place, date, year, subject, sourceUrl, email, hp, ms }) → { ok }` (works signed out; App Check,
honeypot `hp`, at least 3 s on the form `ms`, daily caps `GEO_SUGGEST_PER_IP` per salted address hash and `GEO_SUGGEST_TOTAL`).
`geoAdminSuggestions({ action: 'list', status?, yearFrom?, yearTo?, q?, cursor?, limit? } | { action: 'update', id, status?, note? } | { action: 'delete', id })`
(signed in, uid must be in `functions/admins.json` → `geohistory` or in `config/admins`; others get `permission-denied`).

## Everything else

`accountDeleteMyData({ app })` with `app` = `pantry`, `whyb`, `movi`, `palette` or `all` deletes that
person's data for the app. The sign-in and username are removed only when no app has anything
left for them.
