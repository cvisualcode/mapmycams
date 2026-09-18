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
  _lib.js                   ← JWT, PBKDF2, Supabase REST, Stripe REST helpers
  index.js                  ← all API endpoints
  schema.sql                ← Postgres schema + RLS + admin seed
  supabase_auth.sql         ← profiles table + RLS + new-user trigger (run first)
```

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

With no backend configured the app runs in **demo mode**: accounts, subscriptions, floorplan storage and analytics are persisted to `localStorage`. Everything is clickable and testable — checkout instantly grants the entitlement.

Demo mode still hashes passwords properly: **PBKDF2-SHA256, 210,000 iterations, a fresh 16-byte random salt per account**, stored as `pbkdf2$sha256$210000$<salt>$<hash>`. Raw passwords are never written anywhere. Sessions are random 32-byte tokens with a 30-day expiry, not bare user ids. Repeated failed sign-ins lock an account for 15 minutes. Accounts created by older builds (DJB2 hashes, id-keyed records) are repaired and re-hashed automatically on the next successful sign-in — see *Security & GDPR* below.

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

Neither guard replaces generating the code **server-side**, which is the real
fix: with no database there is nothing server-side for a code to belong to, so
the route stays a (now narrow) way to send a fixed 6-digit message.

Once Supabase is connected, `/auth/signup` generates and sends the code itself
and never returns it to the client; the mailer route is then unused.

## Production setup

1. **Database** — create a Supabase project, paste `api/schema.sql` into the SQL editor. It includes the `alter table` migration for existing databases, and grandfathers accounts created before email verification.
2. **Stripe** — create products/prices (Premium Monthly, Premium Yearly, and the four one-time add-ons). Copy the price IDs.
3. **Webhook** — add a Stripe webhook endpoint at `<your-domain>/webhooks/stripe` for `checkout.session.completed`, `customer.subscription.deleted`. Copy the signing secret.
4. **Deploy the API** — the `api/` folder is a Cloudflare Worker module (`wrangler deploy`) or can be adapted to any Node serverless platform.
5. **Frontend** — deploy the static build (`bun run build` → `dist/`) and set `VITE_API_URL` to your API base URL.

**OAuth providers** — see [`docs/oauth-integration.md`](docs/oauth-integration.md) when you want Google/Apple/Microsoft back.

### Environment variables

Frontend (build-time):
```
VITE_API_URL=https://api.mapmycams.dev
VITE_MAILER_URL=https://api.mapmycams.dev/auth/send-code   # optional; defaults to same-origin /auth/send-code
```

Backend (worker secrets):
```
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
AUTH_SECRET=<random 32+ chars>
RESEND_API_KEY=re_...              # signup verification codes (https://resend.com/api-keys)
EMAIL_FROM=MapMyCams <noreply@yourdomain.com>   # required: an address at your verified Resend domain
STRIPE_SECRET_KEY=sk_live_...
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
| Storage | Only a PBKDF2-SHA256 hash of the code — never the code itself |
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

- **Passwords are never stored.** Each one is stretched with PBKDF2-SHA256
  (210,000 iterations) against a fresh 16-byte random salt, stored as
  `pbkdf2$sha256$210000$<salt>$<hash>`. Comparison is constant-time. Hashes
  written by older builds are upgraded transparently on the next sign-in.
- **Sessions are random 32-byte tokens with a 30-day expiry**, not bare user ids.
  Expired or unknown sessions are rejected and cleared. A legacy bare-id session
  is migrated to a token on first read.
- **Brute-force throttling** — see the table above.
- Floorplans stored as encrypted-at-rest JSON in Supabase (disk encryption); RLS isolates each user's rows.
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
