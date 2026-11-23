# How every app is built

One rule: **an app repo holds a website and a public config file. Everything else lives here.**
A new project follows the same eight points, so there is one place to look for each thing.

1. **One Firebase project** for sign-in, database and functions. One Claude console for AI keys. Nothing else.
2. **Sign-in** is Firebase Auth: Google, plus email and password. The app calls `core.signInWithGoogle()`
   directly in the button's click handler, with nothing awaited first (that is what keeps the sign-in
   window from being blocked).
3. **`web/core.js` is copied into the app unchanged.** It sets up Firebase, App Check, sign-in, the shared
   account and function calls. To change it, edit it here, raise `CORE_VERSION`, and copy it out again
   (`scripts/sync-web-core.sh <path in the app>`). Every app uses the Firebase SDK version named in it.
4. **Data** goes in collections that start with the app's prefix (`pantry_`, `whyb_`, `movi_`, next app:
   pick a short one). Only `accounts` and `usernames` are shared. An app's rules go in its own section of
   `firestore.rules`, with tests in `tests/rules.test.mjs`. Using one app never creates data in another.
5. **Usernames** come from `core.account` only. One per person, 3–20 of `a-z 0-9 . _`.
6. **AI** always runs in a Cloud Function named `<app><Action>`, with that app's own key
   (`<APP>_ANTHROPIC_KEY` in Secret Manager) and its own daily limits (`functions/.env`). No key is ever
   typed into, stored in, or sent from a browser. Every AI function goes through `metered()` in
   `functions/src/ai.js`.
7. **Browser storage** keys start with the app's name and a dot (`movi.…`), because all the apps share one
   website address and therefore one storage area.

8. **Search forgives typos.** Every search box falls back to `web/fuzzy.js` (copied unchanged, like
   `core.js`) when the normal search finds little or nothing, so "avenjers", "madird" or "xantham gum" still
   find the right thing. Results from the fallback are shown the same way as normal ones.

## Adding a new app

1. Pick a prefix. Add its section to `firestore.rules` and tests for it. Add indexes if its queries need them.
2. Add its functions in `functions/src/<app>.js`, export them from `functions/index.js`, add its key and limits.
3. Add its delete routine to `functions/src/account.js` (so "delete my data" works) and, if it has a
   profile that shows the username, add that collection to the two lists that keep usernames in step
   (`appProfileFollows` in the rules, `PROFILE_COLLECTIONS` in `web/core.js`).
4. Register a web app in the Firebase console, add it to App Check, and put the public config in the app repo.
5. `npm test`, push to `main`; the Deploy workflow publishes it.

## Where things are checked

| Check | Where |
|---|---|
| Function logic (limits, input cleaning, scores) | `functions/test/` |
| Who can read and write what | `tests/rules.test.mjs` |
| Sign-in → database → functions together | `tests/integration.test.mjs` |
| Old-data conversion | `tests/migrate.test.mjs` |
| Typo-tolerant search | `tests/fuzzy.test.mjs` |

## Ads (planned, per site)

Each site may carry its own Google ads later. To keep that a small change:
- Ads are website-only: a script tag and ad slots in the app repo. Nothing in this backend changes.
- Every site already has a privacy page; it must be updated to mention advertising cookies when ads go on,
  and visitors in Europe and some US states must be shown a consent choice first (Google provides one).
- Ad scripts never get access to sign-in or the database: App Check and the security rules work per
  request, whatever else runs on the page. Never put account data in page addresses, where ad scripts can read it.
- Google AdSense approves sites by domain and needs an `ads.txt` file at the domain's root. On
  `ngcoding10.github.io/<app>` the root belongs to GitHub Pages' user site, and AdSense rarely approves
  `github.io` addresses, so plan on a domain of your own before applying. A new domain must then be added in
  four places: Firebase Authentication's authorized domains, the App Check reCAPTCHA key's domains, the
  `CORS` list in `functions/index.js`, and the app's canonical links.
