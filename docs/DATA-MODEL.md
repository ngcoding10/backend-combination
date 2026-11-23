# Data model

One Firestore database for every app. Shared collections have no prefix; each app's
collections start with its prefix. `firestore.rules` is the source of truth for who can do
what; this page is the map.

Every write that says "server time" must use `serverTimestamp()` — the rules reject anything else.

## Shared

| Path | Fields | Who |
|---|---|---|
| `accounts/{uid}` | `username`, `displayName` (≤40), `createdAt`, `updatedAt` (server time) | read: any signed-in person. write: owner, only together with `usernames/{username}` |
| `usernames/{name}` | `uid` | anyone can look up one exact name; nobody can list them. One name per person; names are `^[a-z0-9_.]{3,20}$` |
| `ai_usage/{app}_{day}_{uid}` and `…_total` | daily AI counters | Cloud Functions only |

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

## Everything else

`accountDeleteMyData({ app })` with `app` = `pantry`, `whyb`, `movi` or `all` deletes that
person's data for the app. The sign-in and username are removed only when no app has anything
left for them.
