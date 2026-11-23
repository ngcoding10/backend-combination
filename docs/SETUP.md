# Setup checklist

Everything only the owner can do, in order. Nothing here is typed into a chat: keys go
straight from one console into another. Menu names in Google's consoles shift now and then;
if one doesn't match, the nearest-sounding option is almost always it.

## A. Create the Firebase project (about 10 minutes)

1. Open <https://console.firebase.google.com> → **Create a project**. Pick a neutral name (for example
   `ng-apps`); the project ID under the name is permanent and appears in the Google sign-in window.
   Turn Google Analytics **off**.
2. Bottom-left of the console: **Spark → Upgrade → Blaze (pay as you go)** and attach a billing account.
3. Budget alert: <https://console.cloud.google.com/billing/budgets> → **Create budget** → scope: this
   project → amount (say $10) → alerts at 50%, 90%, 100%. This only emails you; the real spending caps
   are the daily AI limits and the Claude spend limits in part C.
4. Sign-in: <https://console.firebase.google.com/project/_/authentication/providers> → **Get started**
   → enable **Google** (choose your support email) and **Email/Password** (leave "email link" off).
5. Allowed sites: <https://console.firebase.google.com/project/_/authentication/settings> →
   **Authorized domains** → add `ngcoding10.github.io` and `ascoding11.github.io`.
6. Same Settings page → **User actions** → keep **Email enumeration protection** on.
   If the page offers **Upgrade to Identity Platform**, accept it (free at this size): it is what lets
   App Check protect sign-in itself in part B.
7. Database: <https://console.firebase.google.com/project/_/firestore> → **Create database** →
   Standard edition → database ID `(default)` → location **`nam5` (United States)** (permanent) →
   **production mode**.
8. Web apps: <https://console.firebase.google.com/project/_/settings/general> → **Your apps** → **Web
   (`</>`)** → register three: `The Pantry`, `Where Have You Been`, `Movi` (do not tick Hosting).
   Each shows a `firebaseConfig` block. These are public, not secrets: send all three as they are.

## B. Bot protection: App Check (about 10 minutes)

App Check makes Google verify that a request comes from the real website in a real browser before
the database, sign-in or any function will answer. Scripts and scrapers get nothing.

1. <https://console.cloud.google.com/security/recaptcha> → **Create key** → type **Website** → domains
   `ngcoding10.github.io` and `ascoding11.github.io` → leave "checkbox challenge" off → **Create**.
   Copy the **site key** (public).
2. <https://console.firebase.google.com/project/_/appcheck/apps> → for each of the three web apps:
   **Register → reCAPTCHA Enterprise** → paste the same site key → Save.
3. Send the site key (it is public). After the apps are live with it and the App Check **Requests**
   graphs show verified traffic: <https://console.firebase.google.com/project/_/appcheck/products> →
   **Cloud Firestore → Enforce** and **Authentication → Enforce**. (The Cloud Functions already refuse
   requests without App Check; no click needed.)

## C. Claude keys (about 5 minutes)

1. <https://console.anthropic.com/settings/workspaces> → create two workspaces: `The Pantry` and `Movi`.
   In each, set a monthly **spend limit** (Limits). That is the hard ceiling for that app.
2. In each workspace → **API keys → Create key**. Keep the tab open.
3. <https://console.cloud.google.com/security/secret-manager> (pick the new project; enable the API if
   asked) → **Create secret** twice:
   - name `PANTRY_ANTHROPIC_KEY`, value = the Pantry key
   - name `MOVI_ANTHROPIC_KEY`, value = the Movi key

Daily limits per person and per app are in `functions/.env` in this repo (not secret).

## D. Let GitHub deploy (about 5 minutes)

1. <https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk> → **Generate new
   private key**. A `.json` file downloads.
2. <https://console.cloud.google.com/iam-admin/iam> → find the account that starts with
   `firebase-adminsdk` → pencil → **Add another role** until it has: **Editor**, **Cloud Functions Admin**,
   **Firebase Rules Admin**, **Secret Manager Secret Accessor** → Save.
3. <https://github.com/ngcoding10/backend-combination/settings/secrets/actions> → **New repository
   secret** → name `FIREBASE_SERVICE_ACCOUNT` → paste the whole contents of the `.json` file → Add.
   Then delete the file from your computer.
4. <https://github.com/ngcoding10/backend-combination/actions/workflows/deploy.yml> → **Run workflow**.
   A red run usually means one more role or API is needed; the log names it.

## E. Move the old data (about 10 minutes, after D works)

Same secrets page as D3. Add:
- `OLD_WHYB_SERVICE_ACCOUNT`: a private key generated the same way as D1, but from the OLD project
  `where-have-you-been-f130a` (<https://console.firebase.google.com/project/where-have-you-been-f130a/settings/serviceaccounts/adminsdk>).
- `SUPABASE_URL`: `https://plnqlxyzqxnhnxgdooiq.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`: from <https://supabase.com/dashboard/project/plnqlxyzqxnhnxgdooiq/settings/api-keys>
  (the secret / service_role key).

Then <https://github.com/ngcoding10/backend-combination/actions/workflows/migrate.yml> → **Run workflow**:
1. `movi-from-supabase`, mode `look`. Read the counts. Then again with mode `commit`.
2. `whyb-from-old-firebase`, mode `look`, then `commit`.

Movi is moved first on purpose: account ids come from whichever move creates the account, and Movi's
are the ones its rankings hang on. Each run saves a private backup inside the new project. People keep
their data and sign in with Google as before; anyone who used an email and password on Movi clicks
"Forgot password" once. Remove the three secrets afterwards.

## F. After each app is confirmed working

Leave the old projects alone until then. When an app is confirmed on the new backend:
- Where Have You Been: <https://console.firebase.google.com/project/where-have-you-been-f130a/settings/general> → Delete project.
- The Pantry: <https://console.firebase.google.com/project/the-pantry-8e315/settings/general> → Delete project.
- Movi: <https://supabase.com/dashboard/project/plnqlxyzqxnhnxgdooiq/settings/general> → Pause, and delete later.
