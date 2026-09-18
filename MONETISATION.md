# MapMyCams Monetisation

Full monetisation stack for the security-camera floorplan planner: accounts, free/premium tiers, Stripe billing, add-ons, AI suggestions, analytics and an admin panel.

## Architecture

```
src/AppShell.jsx            ← app entry: auth → dashboard ⇄ editor / pricing / admin
src/main.jsx                ← mounts AppShell
src/monetisation/
  plans.js                  ← plan catalogue + entitlement logic
  api.js                    ← API client: PBKDF2 auth, sessions, throttle, local store
  EntitlementsContext.jsx   ← React context: user, limits, upgrade prompts
  MonetisationUI.jsx        ← login, dashboard, pricing, upgrade modal, admin panel
  snapshotBridge.js         ← editor ⇄ shell save/load bridge
src/App.jsx                 ← the floorplan editor (gated: camera limit, watermark, AI button)
api/
  _lib.js                   ← JWT, credentials, Cloudflare KV store, Resend + Stripe
  index.js                  ← all API endpoints
  email-template.js         ← the verification email body
  schema.sql                ← Postgres alternative — not used (see “Where accounts live”)
  supabase_auth.sql         ← profiles table + RLS + trigger, for the Supabase OAuth path
functions/auth/send-code.js ← Pages Function: the same mailer on *.pages.dev
scripts/
  stripe-setup.mjs          ← creates the Stripe products, prices and webhook
  test-billing.mjs          ← billing smoke test (Stripe stubbed out, no account needed)
  test-email.mjs            ← sends one real verification code, to prove Resend works
```

## Where accounts live (Cloudflare KV)

Accounts, sessions, floorplans and feature flags live in a **Cloudflare KV
namespace** bound as `MAPMYCAMS_STORE`. One key per record, so signing in is a
single read and there is no database to provision or migrate.

| Key | Holds |
|---|---|
| `user:<email>` | the account: id, name, `password_hash`, plan, add-ons, admin flag, pending verification code hash |
| `plan:<ownerId>:<planId>` | one floorplan |
| `flag:<name>` | a feature flag |

`api/_lib.js` is the only module that touches the store and `api/index.js` the
only caller, so that layout is the entire contract — swapping the storage means
editing one file.

**Two things worth knowing:**

- **KV is eventually consistent.** A write is immediately visible in the colo
  that served it and elsewhere within about 60 seconds. Sign-up, sign-in and
  verification all happen in one browser session against one colo, so those flows
  are unaffected; the case you can actually notice is a floorplan saved here
  showing up on a *different* device up to a minute later. The client softens it
  by keeping a local copy of every plan it saves and merging local + server lists
  on read, so a layout never disappears from the dashboard that drew it.
- **It is the cheapest thing that works with the deploy token in use.** Cloudflare
  D1 (SQLite, transactions, immediate consistency) is the better store and needs
  only the D1 permission added to the API token: `bunx wrangler d1 create
  mapmycams`, add `d1_databases` to `wrangler.jsonc`, and replace the store
  helpers in `api/_lib.js`. Nothing outside that file would change.

**Making an account an admin.** There is no admin sign-up path; the seeded
`Admin` / `Admin1` account is local to its browser. To promote a server account,
edit its row (Cloudflare → Workers & Pages → KV → `MAPMYCAMS_STORE`) and set
`"is_admin": true`, then refresh.

## Plans

| Tier | Price | Highlights |
|---|---|---|
| Free | £0 | 1 floorplan, 4 cameras, watermarked export, no AI |
| Premium Monthly | £4.99/mo | Unlimited everything, AI placement, no watermark, share links, health score, premium brands |
| Premium Yearly | £49/yr | Same as monthly + 2 months free |

One-time add-ons: AI Analysis Pack £7.99 · Pro PDF Report £4.99 · Family Sharing £2.99 · Brand Integration £6.99.

**Admin demo account:** `Admin` / `Admin1` — full access to every feature plus the admin panel (users, plans, analytics, announcements, feature flags).

## Run locally

```bash
bun install
bun run dev
```

Out of the box — the sandbox preview, or any static host with no API behind it —
the app runs in **demo mode**: accounts, sessions, subscriptions, floorplan
storage and analytics are persisted to `localStorage`, and checkout instantly
grants the entitlement so the product stays fully clickable.

Deployed on Cloudflare the accounts move to the server (see *Where accounts live*),
which is what makes one account work on every device. The browser store stays as
the fallback: an account created locally still signs in, and a plan is written
locally as well as server-side.

Local mode still hashes passwords properly: **PBKDF2-SHA256, 210,000 iterations, a fresh 16-byte random salt per account**, stored as `pbkdf2$sha256$210000$<salt>$<hash>`. Raw passwords are never written anywhere. Sessions are random 32-byte tokens with a 30-day expiry, not bare user ids. Repeated failed sign-ins lock an account for 15 minutes. Accounts created by older builds (DJB2 hashes, id-keyed records) are repaired and re-hashed automatically on the next successful sign-in — see *Security & GDPR* below.

## Getting real emails working

Verification codes are sent by **Resend** ([resend.com](https://resend.com)) via a
single REST POST — no SDK, no build step. Three steps, in order:

### 1. Verify your domain in Resend

Resend will not deliver to arbitrary addresses until a domain you own is
verified — `onboarding@resend.dev` can only mail your own account address.

1. Resend → **Domains** → *Add domain* → your domain (or a subdomain, which is
   better for reputation, e.g. `mail.yourdomain.com`).
2. Add the **SPF** and **DKIM** DNS records it shows you, at your DNS provider.
3. Wait for the domain to go green in Resend. This is usually minutes, and up to
   ~48h on a brand-new domain.

### 2. Prove it works locally — no deploy needed

Add these two in **Settings → Environment** (then run the command):

```
RESEND_API_KEY=re_...                                  # resend.com/api-keys
EMAIL_FROM=MapMyCams <noreply@yourdomain.com>          # an address at the verified domain
```

```bash
bun run email:test you@yourdomain.com
```

It sends one real code and prints Resend's actual error if the domain, DNS or key
are wrong — which is the part most likely to be misconfigured. Once a code lands
in your inbox, everything else is just wiring.

### 3. Put the mailer behind the app

The `POST /auth/send-code` route in `api/index.js` emails a client-generated code
and **needs no database** — that is what lets real email work while accounts are
still stored locally. The key stays server-side.

- **Cloudflare Workers** (this repo is scaffolded for it — see `wrangler.jsonc`):
  ```bash
  bunx wrangler login
  bunx wrangler secret put RESEND_API_KEY
  bunx wrangler secret put EMAIL_FROM
  bunx wrangler deploy
  ```
  `wrangler.jsonc` runs `api/index.js` as the worker and routes `/auth/*` (plus
  the other API paths) to it before the SPA fallback serves `index.html`.
- **Cloudflare Pages** (a Pages project ignores `wrangler.jsonc`'s `main`;
  server code there must live in `functions/`): `functions/auth/send-code.js` is
  routed to `/auth/send-code` by its file path, and `public/_routes.json` keeps
  static assets off the Function so only `/auth/*` invokes it. Set the same two
  variables in **Settings → Variables and Secrets → Production**.
- **Any other host**: deploy `api/` as a fetch handler and point
  `VITE_MAILER_URL` at it (build-time env var).

Two things that cost real time when wiring production:

- **Environment changes need a new deployment.** On Pages, variables only apply
  to a build created after they were added — retry the deployment
  (Deployments → ⋯ → Retry deployment), don't just reload the site. On a Worker,
  `wrangler deploy` again.
- **The sender address must be at the verified domain, and the variable must be
  named exactly `EMAIL_FROM`.** Resend guides sometimes use
  `RESEND_EMAIL_FROM`; a name that doesn't match keeps reporting "not
  configured" and reads like a broken deploy.

Domain verification only needs the **DKIM TXT** record — Resend accepted a send
with the SPF TXT and MX absent, and the code still reached the inbox. Add them
anyway when convenient: SPF improves inbox placement at strict consumer
providers, and the MX is what lets Resend report bounces to you instead of them
vanishing silently. Neither is required to send.

The client defaults to the same origin (`/auth/send-code`), so on Cloudflare no
configuration is needed. If the mailer is unreachable the code screen falls back
to showing the code — signup never breaks because email is down.

### Where the mailer is wired right now (verified)

Both targets are live and accepting sends, confirmed against the real endpoint:

| Host | Serves | `POST /auth/send-code` |
|---|---|---|
| `mapmycams.dev` | Worker (`api/index.js`) on a Custom Domain | `{"sent":true}` |
| `mapmycams.pages.dev` | Pages project `mapmycams` + `functions/` | `{"sent":true}` |

A request with no `Origin`, or a foreign one, is `403 Origin not allowed` on
both. All three builds — Worker, Pages and a local `vite build` — produce the
same asset hash, so what is live matches `main`.

Two details of that setup that are easy to trip over:

- **Pages deploys from GitHub, not from this sandbox.**
  `.github/workflows/deploy.yml` runs the build and `wrangler pages deploy dist`
  on every push to `main`, using the `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` repository secrets. Its variables were applied via the
  Cloudflare API — to **both** production and preview, because the API rejects a
  PATCH where the two environments disagree on `fail_open` — and only took
  effect on the deployment that followed. The **Worker is deployed by hand**
  (`bunx wrangler deploy`), so a push does *not* update the domain.
- **The two variables are per-project bindings.** A Worker secret does nothing
  for Pages, which is exactly why `.pages.dev` kept reporting the key missing
  while the domain already worked. Set them on each target.

### Keeping the mailer from being abused

Once `RESEND_API_KEY` is set, `/auth/send-code` sends real mail from the
verified domain and accepts an attacker-chosen recipient *and* code. Before the
key existed that was harmless; afterwards it is a mail relay. Two guards are in
place, in both `api/index.js` and `functions/auth/send-code.js`:

- **`Origin` is required and checked** against an allowlist (`mapmycams.dev`,
  `*.pages.dev`, `localhost`). A *missing* `Origin` is rejected as well —
  browsers always send one on POST, so "absent means trusted" only ever helped
  scripted clients.
- **`workers_dev: false` and `preview_urls: false`** in `wrangler.jsonc`, so the
  `*.workers.dev` and preview URLs are no longer public second doors around the
  domain. The Custom Domain is unaffected — it is not a wrangler-managed route,
  which is why deploys report `No targets deployed` yet still serve the site.

This route exists only for browsers with **no server session** — accounts created
before the API existed, and the sandbox preview. Accounts created through the API
never use it: `/auth/signup` generates the code itself, stores only its keyed
hash, and never returns it to the client.

## Production setup

1. **Account storage** — one Cloudflare KV namespace, already bound in `wrangler.jsonc` as `MAPMYCAMS_STORE` (`bunx wrangler kv namespace create MAPMYCAMS_STORE`, then paste the id into the config). Nothing to provision by hand; `api/schema.sql` is the Postgres/Supabase alternative and is *not* used by this build.
2. **Stripe** — one command does the whole account side:
   ```bash
   bun run stripe:setup      # needs STRIPE_SECRET_KEY in Settings → Environment
   ```
   It creates both Premium prices and all four add-ons in GBP, registers the
   webhook at `/webhooks/stripe` for `checkout.session.completed`,
   `customer.subscription.deleted` and `customer.subscription.paused`, and pushes
   every resulting secret (the price IDs, the webhook signing secret and the API
   key) onto the Worker. Re-running it is safe: products are matched by metadata
   and prices by lookup key, so nothing is duplicated. The **webhook endpoint is
   recreated** on each run, because Stripe reveals a signing secret exactly once,
   when the endpoint is created — the Worker is handed the new one in the same run,
   so the two can never drift apart.
   Start with a `sk_test_…` key: everything works in test mode with card
   `4242 4242 4242 4242`, any future expiry, any CVC, and no money moves. Replace
   that key with `sk_live_…`, run it again, and the same catalogue is created in
   live mode.
   Each product is created with the **SaaS — personal use** tax code
   (`txcd_10103000`). That is not decoration: a new Stripe account has Managed
   Payments switched on, and Checkout refuses outright to sell a product with no
   tax code ("the product tax code is missing"). If you would rather run without
   Managed Payments, it can be turned off in Stripe → Settings → Managed Payments;
   the code works either way, and re-running the script repairs a product whose
   code is missing or different.
3. **Deploy the API** — `bunx wrangler deploy`; the script has already set the
   bindings it needs.
5. **Frontend** — deploy the static build (`bun run build` → `dist/`). Leave `VITE_API_URL` unset when the app and the API share an origin, which is the Cloudflare Worker case: the client then calls `/auth/*` on its own origin. Set it only when the API lives elsewhere — `.github/workflows/deploy.yml` does that for the Pages build, pointing it at `https://mapmycams.dev`.

**OAuth providers** — see [`docs/oauth-integration.md`](docs/oauth-integration.md) when you want Google/Apple/Microsoft back.

## How a purchase happens

1. **Choose** — the pricing page, the upgrade modal and the add-on rows all call
   `POST /billing/checkout`. The server maps the plan key to a Stripe price ID and
   creates a Checkout Session tagged with the account id and the item. Card details
   are only ever typed on Stripe's own page.
2. **Pay** — the browser is handed to the session's `url`. `success_url` returns to
   `/?checkout=success&session_id=…`; `cancel_url` returns to `/?checkout=cancelled`.
3. **Return** — the app posts that session id to `POST /billing/confirm`, which
   reads the session back from Stripe, checks it really belongs to the signed-in
   account and applies the purchase. This is what makes the plan right immediately,
   instead of whenever the webhook happens to arrive.
4. **Webhook** — `POST /webhooks/stripe` verifies the `Stripe-Signature` HMAC and
   applies the same grant, so a purchase still lands when the customer closes the
   tab before returning. Both paths call the same `grantPurchase()`, so a purchase
   applied twice is harmless.
5. **Manage** — cards, invoices and cancellation live in Stripe's billing portal
   (`POST /billing/portal`). "Cancel subscription" opens the portal rather than
   flipping the account to Free locally: doing that would cut off access while
   Stripe carried on charging. `customer.subscription.deleted` is what actually
   downgrades the account.

Two things that are deliberately *not* possible:

- **A redirect alone never unlocks anything.** `POST /billing/checkout` answers
  `503` for an item with no price ID on the Worker rather than granting it as a
  demo, and `grantPurchase()` only ever runs for a session Stripe reports as paid.
- **One account cannot claim another's session.** `/billing/confirm` compares the
  session's `client_reference_id` with the signed-in account before granting.

Billing history comes from `POST /billing/invoices`, which asks Stripe for the
customer's invoices — so the dashboard and the portal show the same record.

### A purchase needs an account the server knows

A Stripe session is created against an account record, so a plan can only be sold to
one that exists server-side. An account that lives only in this browser's local store
cannot be charged for — and on such an account, clicking a plan used to do nothing
visible at all. So `startCheckout()` raises its error with `needsAccount: true`, and
`CheckoutGate` — rendered wherever a purchase can start, the editor's upgrade prompt
included — collects a password, verifies the address with an emailed code, and then
resumes the exact item that was clicked. `EntitlementsContext` holds that pending
purchase (`checkoutGate`) so it survives the sign-up step, and only clears it once a
redirect has genuinely started, which is what keeps a failure on screen to explain.

### Verifying billing with no Stripe account

```bash
bun run billing:test
```

That drives the real handler with Stripe stubbed out: the demo grant, the paid
redirect (including the metadata a subscription needs), the confirm path — another
account's session refused, an unpaid session granting nothing — invoice mapping,
the cancel guard, and the webhook signature both valid and forged.

```bash
bun run checkout:test
```

That covers the browser half the same way, with `fetch` stubbed: a browser-only
account produces the flagged error rather than a silent local grant, and with a
server session the click navigates to the URL Stripe returned — token, item and kind
included — while a refusal from the server surfaces as an error.

### Environment variables

Frontend (build-time):
```
VITE_API_URL=https://mapmycams.dev   # optional; unset means "this origin"
VITE_MAILER_URL=...                  # optional; defaults to same-origin /auth/send-code
```

Backend bindings (`wrangler.jsonc`):
```
kv_namespaces: MAPMYCAMS_STORE=<namespace id>   # accounts, floorplans, flags
```

Backend (worker secrets) — `bun run stripe:setup` sets every Stripe value below:
```
AUTH_SECRET=<random 32+ chars>     # signs sessions AND keys password + code hashes
RESEND_API_KEY=re_...              # signup verification codes (https://resend.com/api-keys)
EMAIL_FROM=MapMyCams <noreply@yourdomain.com>   # required: an address at your verified Resend domain
STRIPE_SECRET_KEY=sk_live_...      # sk_test_... while trying it out
STRIPE_WEBHOOK_SECRET=whsec_...
PRICE_PREMIUM_MONTHLY=price_...
PRICE_PREMIUM_YEARLY=price_...
PRICE_AI_PACK=price_...
PRICE_PDF_REPORT=price_...
PRICE_FAMILY=price_...
PRICE_BRANDS=price_...
APP_URL=https://mapmycams.dev
ALLOWED_ORIGIN=https://mapmycams.dev
```

## Upsell triggers (implemented)

| Trigger | Behaviour |
|---|---|
| 5th camera placed on Free | Upgrade modal, camera not added |
| Watermarked PNG export | Free tier gets a watermark; premium exports clean |
| "✨ AI Place Cameras" on Free | Upgrade modal |
| Saving a 2nd floorplan | Upgrade modal, plan not saved |

All triggers emit `upsell_shown` analytics events so conversion per trigger is measurable in the admin panel.

## Sign-in methods

**Email + password only.** Google / Apple / Microsoft sign-in is intentionally
switched off for now — it needs a Supabase project *and* OAuth applications
registered in each vendor's console, and neither can be created from the code
side. The full, working implementation is parked in
[`docs/oauth-integration.md`](docs/oauth-integration.md) with step-by-step
restore instructions.

### What the sign-in form does

| Behaviour | Detail |
|---|---|
| Create account | Validates the email, enforces the password rules below, rejects duplicates, then emails a 6-digit code |
| Email verification | The account starts unverified and gets **no session** — the code screen is the only reachable route until the code is accepted |
| Sign in | Accepts the email **or** the display name (e.g. `Admin`) |
| Signing in unverified | Right password still gets no session; the code screen is shown instead |
| Failed attempts | 5 wrong tries locks that account for 15 minutes |
| Error messages | Identical for "no such account" and "wrong password" — the form never reveals whether an address is registered (unless the browser is blocking storage, in which case the failure is spelled out instead) |
| Blocked storage | Every backend is probed with a real write before use: `localStorage` → `sessionStorage` → memory. A notice is shown whenever accounts cannot be stored durably |
| Password field | Has a reveal toggle and, on sign-up, a live requirements checklist |

### Email verification

1. **Create account** stores the account with `emailVerified: false` and emails a
   6-digit code. No session is issued.
2. The app swaps to the **Verify your email** screen — the planner, dashboard and
   every other route are unreachable from there.
3. Entering the code marks the address verified, creates the session and drops
   the user into the dashboard.

| Rule | Value |
|---|---|
| Code | 6 digits, cryptographically random (rejection-sampled, so no modulo bias) |
| Storage | Only a keyed hash of the code (HMAC-SHA256 with `AUTH_SECRET`) — never the code itself |
| Lifetime | 10 minutes |
| Wrong attempts | 5, then the code is dead and a new one is required |
| Resend | One replacement per 60 seconds |
| Existing accounts | Accounts created before this feature carry no flag and are grandfathered in, so nobody is locked out |
| Admin | `Admin` / `Admin1` is verified by definition |

**Sending the email requires a provider** — see *Getting real emails working*
below. Until one is configured the flow is still complete: no message is sent and
the code screen shows the code with a notice explaining why. The notice names the
actual failure (mailer missing, domain unverified, bad key), so it never fails
silently.

### Password rules

Enforced in `api.passwordProblem()` and mirrored by the checklist in the UI:

- at least 8 characters
- contains at least one letter
- contains at least one number

### Admin account

`Admin` / `Admin1` — full access to every feature plus the admin panel. It is a
seeded row in the local store and signs in through the normal form.

## Security & GDPR

- **Passwords are never stored, and in server mode never even sent.** The
  browser stretches the password with PBKDF2-SHA256 (210,000 iterations — in
  server mode salted by the address so the same password yields the same value on
  every device) and sends only the result. The server keys that with `AUTH_SECRET`
  and stores `hmac-sha256:<digest>`, so a leaked record cannot be replayed against
  the login endpoint; comparison is constant-time. The API refuses anything not
  shaped like a client hash of at least 100,000 iterations, so it cannot be talked
  into storing something cheap. Local-mode hashes from older builds are upgraded
  on the next sign-in.
- **Session tokens are signed, not random.** A 30-day HS256 JWT carrying the
  account id and email, verified on every request; a token for a deleted or
  unverified account is rejected. (`api/_lib.js` decodes the signature to bytes
  before verifying — passing the base64 string made every token fail, which is
  why `/me` answered 401 for valid sessions until it was fixed.)
- **Sessions are random 32-byte tokens with a 30-day expiry**, not bare user ids.
  Expired or unknown sessions are rejected and cleared. A legacy bare-id session
  is migrated to a token on first read.
- **Brute-force throttling** — see the table above.
- Floorplans are stored under the owner's account id in Cloudflare KV, so one account's layouts are only reachable with that account's session token.
- Local (no-backend) mode keeps the database in the most durable storage the
  browser will actually grant. Browsers refuse storage entirely in third-party
  frames and some private modes, so the backend is chosen by probing rather than
  assumed, and the sign-in screen says so when no durable option exists. It is
  still only as private as the browser profile it lives in — connect a backend
  before storing anything sensitive. See *Production setup*.
- Passwords are hashed with WebCrypto when available and with a bundled
  SHA-256/HMAC/PBKDF2 implementation when it is not (a sandboxed or insecure
  context has no `crypto.subtle`). Both produce byte-identical hashes.
- 2FA toggle in the dashboard (wire to an email-OTP provider in production).
- Data deletion: deleting a floorplan removes it permanently; account deletion cascades all rows.
- Analytics contain no plan geometry — only event names and metadata.
