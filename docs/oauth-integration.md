# Parked: Google / Apple / Microsoft sign-in

**Status: removed from the live app on purpose.** The email + password path is the
only sign-in method right now. Everything needed to switch OAuth back on is kept
in this file so it can be restored later without re-deriving it.

Nothing in `src/` imports this file, so it never reaches the bundle.

---

## Why it was parked

Real OAuth cannot work without two things that only the project owner can create:

1. **A Supabase project** — holds the accounts and performs the code exchange.
2. **OAuth applications registered with each vendor** — Google, Microsoft and
   Apple each require *you* to register an app in their console and supply the
   resulting client ID + secret. That is how those vendors verify who owns the
   domain; it cannot be automated or done by a third party.

Until both exist, the buttons could only ever fail or pretend to work, so they
were removed rather than left broken.

---

## Part 1 — Restore the client

### 1a. Re-add the dependency

```bash
bun add @supabase/supabase-js
```

> ⚠️ Adding a package makes Vite re-run its dependency pre-bundler. On this
> sandbox that step has failed with
> `EXDEV: cross-device link not permitted` and left the whole app blank
> (every `/node_modules/.vite/deps/*` URL 404s, including React).
> If that happens: `rm -rf node_modules/.vite && touch vite.config.js` and wait a
> few seconds — Vite restarts itself and rebuilds the cache.

### 1b. Recreate `src/monetisation/supabase.js`

```js
// ─── Supabase client ─────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env?.VITE_SUPABASE_URL
const anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY

export const supabaseReady = Boolean(url && anonKey)

export const supabase = supabaseReady
  ? createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // PKCE returns ?code=... rather than a #hash, so the editor's existing
      // #plan= share links keep working.
      flowType: 'pkce',
    },
  })
  : null

/** Where the provider sends the browser back to once the user has consented. */
export function oauthRedirectTo() {
  return `${window.location.origin}${window.location.pathname}`
}
```

### 1c. Re-add the OAuth block to `src/monetisation/api.js`

Add to the imports:

```js
import { supabase, supabaseReady, oauthRedirectTo } from './supabase'
```

Add these exports alongside `login` / `signup`:

```js
export const OAUTH_PROVIDERS = [
  { id: 'google', name: 'Google', supabase: 'google' },
  { id: 'apple', name: 'Apple', supabase: 'apple' },
  { id: 'microsoft', name: 'Microsoft', supabase: 'azure' }, // Supabase calls Microsoft "azure"
]

/**
 * Start an OAuth sign-in. The browser is handed to the provider's own sign-in
 * page (accounts.google.com, login.microsoftonline.com, appleid.apple.com) —
 * the user authenticates there, never on our page. The session is picked up
 * from the redirect by getMe() / onAuthChange().
 */
export async function oauth(providerId) {
  const provider = OAUTH_PROVIDERS.find((p) => p.id === providerId)
  if (!provider) throw new Error('Unknown sign-in provider')
  if (!supabaseReady) {
    throw new Error(`${provider.name} sign-in isn't connected yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then enable the ${provider.name} provider in Supabase → Authentication → Providers.`)
  }
  track('oauth_started', { provider: providerId })
  const { error } = await supabase.auth.signInWithOAuth({
    provider: provider.supabase,
    options: { redirectTo: oauthRedirectTo() },
  })
  if (error) throw new Error(error.message)
  // The browser is navigating to the provider now — nothing more to do here.
}

/** Subscribe to sign-in / sign-out, including the session arriving from a provider redirect. */
export function onAuthChange(cb) {
  if (!supabaseReady) return () => {}
  const { data } = supabase.auth.onAuthStateChange((_event, session) => { cb(session?.user || null) })
  return () => data.subscription.unsubscribe()
}

/** Surface an error the provider handed back on the redirect, then strip it from the URL. */
export function consumeOauthRedirectError() {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const message = url.searchParams.get('error_description') || url.searchParams.get('error')
  if (!message) return null
  for (const k of ['error', 'error_code', 'error_description']) url.searchParams.delete(k)
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
  return message
}
```

Also restore the Supabase branches inside `login()`, `signup()`, `logout()`,
`getMe()` and `sessionUser()`. The pattern used previously was:

```js
if (supabaseReady) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: id, password })
  if (error) throw new Error(error.message)
  return loadSupabaseProfile(data.user)
}
```

...and a `loadSupabaseProfile(authUser)` helper that reads the `profiles` row
created by the trigger in `api/supabase_auth.sql`:

```js
async function loadSupabaseProfile(authUser) {
  const fallbackName = authUser.user_metadata?.name || authUser.user_metadata?.full_name || String(authUser.email || '').split('@')[0]
  const { data, error } = await supabase.from('profiles').select('*').eq('id', authUser.id).maybeSingle()
  currentProfile = (error || !data) ? {
    id: authUser.id, identifier: authUser.email, email: authUser.email, name: fallbackName,
    isAdmin: false, plan: 'free', addons: [], twoFA: false, createdAt: authUser.created_at,
  } : {
    id: data.id,
    identifier: data.email || authUser.email,
    email: data.email || authUser.email,
    name: data.name || fallbackName,
    isAdmin: !!data.is_admin,
    plan: data.plan || 'free',
    addons: data.addons || [],
    twoFA: !!data.two_fa,
    createdAt: data.created_at,
  }
  return currentProfile
}
```

`signup()` with Supabase returns `{ pendingConfirmation: true, email }` when the
project requires email confirmation, and the sign-in form shows a
"Confirmation link sent to …" notice instead of pretending to be signed in.

### 1d. Re-add the buttons to `src/monetisation/MonetisationUI.jsx`

Keep the `ProviderMark` SVG component (Google four-colour G, Microsoft four
squares, Apple glyph) and render:

```jsx
<div className="auth-divider"><span>or continue with</span></div>
<div className="auth-oauth">
  {api.OAUTH_PROVIDERS.map((p) => (
    <button key={p.id} className={`oauth-btn oauth-${p.id}`} onClick={() => startOauth(p)} disabled={busy}>
      <ProviderMark provider={p.id} />
      <span>{p.name}</span>
    </button>
  ))}
</div>
```

```js
/** Hand the browser to the provider's own sign-in page. */
async function startOauth(provider) {
  setError(''); setNotice(''); setBusy(true)
  try {
    api.track('oauth_click', { provider: provider.id })
    await ent.oauth(provider.id) // navigates away on success
  } catch (err) {
    setError(err.message || `Could not reach ${provider.name}`)
    setBusy(false)
  }
}
```

And in `src/monetisation/EntitlementsContext.jsx`, restore the passthrough plus
the auth-state subscription:

```js
async oauth(provider, email) {
  const u = await api.oauth(provider, email)
  if (u) setUser(u)
  return u
},
```

```js
// Pick up the session that comes back from a provider redirect.
const unsubscribe = api.onAuthChange(async (authUser) => {
  if (!authUser) return
  const u = await api.getMe().catch(() => null)
  if (!cancelled && u) setUser(u)
})
```

---

## Part 2 — Vendor setup (unavoidable manual work)

For every provider, the redirect URI to register is:

```
https://<your-project-ref>.supabase.co/auth/v1/callback
```

| Provider | Console | What to create |
|---|---|---|
| Google | console.cloud.google.com → APIs & Services → Credentials | OAuth client ID (Web application) |
| Microsoft | entra.microsoft.com → App registrations | App registration; allow personal + org accounts |
| Apple | developer.apple.com → Certificates, Identifiers & Profiles | Services ID + a Sign in with Apple key |

Then in Supabase: **Authentication → Providers** → enable each one and paste the
client ID and secret.

Also set **Authentication → URL Configuration → Site URL** and add every origin
you serve from (including `http://localhost:5173`) to the redirect allow-list.

---

## Part 3 — Database

Run `api/supabase_auth.sql` in the Supabase SQL editor. It creates the
`profiles` table, its RLS policies (a user can only read/update their own row)
and the `on_auth_user_created` trigger that gives every new identity — password
or OAuth — a profile row.

Then promote the admin account once it exists:

```sql
update profiles
   set is_admin = true,
       plan = 'premium_yearly',
       addons = '["ai_pack","pdf_report","family","brands"]'::jsonb
 where email = 'admin@mapmycams.dev';
```

---

## Part 4 — Environment

Sandbox (Settings → Environment, or `.env.local`):

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
```

Production (`freebuff-deploy env set`): the same two keys — `VITE_*` values are
baked in at **build** time, so they must be set before the deploy builds.

The anon key is safe to expose in the browser; Row Level Security is what
actually protects the data. Never put the `service_role` key in a `VITE_*` var.

---

## Verification checklist when restoring

1. Provider button sends the browser to the vendor's domain (URL bar changes to
   `accounts.google.com` / `login.microsoftonline.com` / `appleid.apple.com`).
2. Cancelling on the vendor page returns with a visible error, not a silent
   sign-in.
3. After consent, a `profiles` row exists with the right `id`.
4. Signing in again with the same provider reuses that row rather than creating
   a second account.
5. An email/password account created before OAuth was enabled still signs in and
   is linked rather than duplicated when the same address is used via a provider.
