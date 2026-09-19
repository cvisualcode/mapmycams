// Renders the public home page through Vite's SSR loader, so a runtime error or a
// missing hero image is caught here rather than by a first-time visitor. Also
// covers the routing rule that decides home page vs sign-in vs code entry.
// Run: bun run landing:test
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'vite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const checks = []
function check(name, ok) {
  checks.push([name, !!ok])
}

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const { default: LandingPage } = await server.ssrLoadModule('/src/monetisation/LandingPage.jsx')
  const { visitorRoute } = await server.ssrLoadModule('/src/monetisation/routing.js')
  const { limitsFor } = await server.ssrLoadModule('/src/monetisation/plans.js')

  const html = renderToStaticMarkup(React.createElement(LandingPage, { onSignIn() {}, onSignUp() {} }))
  const signedIn = renderToStaticMarkup(React.createElement(
    LandingPage, { signedIn: true, onOpenApp() {}, onOpenPlanner() {}, onSignIn() {}, onSignUp() {} },
  ))

  // ── Content ────────────────────────────────────────────────────────────────
  check('hero headline', /Know what your cameras cover/.test(html))
  // The hero is served from public/, not bundled, so the same file backs og:image.
  check('hero image', /<img[^>]+src="\/h\.png"/.test(html))
  check('hero image exists on disk', existsSync('public/h.png'))
  check('features section', /id="features"/.test(html))
  check('how it works', /id="how"/.test(html))
  check('pricing section', /id="pricing"/.test(html))
  check('premium price', /£4\.99/.test(html))
  check('yearly price', /£49/.test(html))
  check('add-on price', /£7\.99/.test(html))
  check('sign-in CTA', /I already have one/.test(html))
  check('anchor targets exist', ['features', 'how', 'pricing'].every((id) => html.includes(`href="#${id}"`) && html.includes(`id="${id}"`)))

  // The free-tier numbers and the premium price must come from the catalogue, so a
  // price or limit change cannot leave stale prose behind on this page.
  const free = limitsFor('free')
  check('free limits read from the catalogue', html.includes(`${free.floorplans} floorplan`) && html.includes(`up to ${free.cameras} cameras`))
  check('the free/premium split is spelled out', /landing-note/.test(html) && /one-off add-on/.test(html))

  // ── Which capabilities are paid ────────────────────────────────────────────
  // Split the feature grid into one chunk per card, so a card can be checked on
  // its own rather than by finding two strings somewhere on the page.
  const featuresHtml = html.split('id="features"')[1].split('id="how"')[0]
  const cards = featuresHtml.split('</article>').slice(0, -1)
  const GATED = [
    'Blind spots, not guesswork',
    'AI placement suggestions',
    'A security score with fixes',
    'Exports you can hand over',
  ]
  const paid = cards.filter((c) => c.includes('landing-tier premium'))
  check('six feature cards render', cards.length === 6)
  check('every card is tier-labelled', cards.every((c) => c.includes('landing-tier')))
  check('exactly the four gated features are marked Premium', paid.length === 4)
  check('the gated ones are the paid tools', paid.every((c) => GATED.some((t) => c.includes(t))))
  check('free tools are not marked Premium', cards.filter((c) => !c.includes('landing-tier premium')).length === 2)

  // ── Signed-in variant ──────────────────────────────────────────────────────
  check('signed-in view never offers sign-up', /Open the planner/.test(signedIn) && !/Create a free account/.test(signedIn))
  check('signed-in view separates planner from dashboard', /Back to dashboard/.test(signedIn))

  // ── Routing rule ───────────────────────────────────────────────────────────
  check('visitor with no history sees the home page', visitorRoute({}, null) === 'home')
  check('visitor who chose sign-in sees the auth card', visitorRoute({}, 'login') === 'auth')
  check('visitor who chose sign-up sees the auth card', visitorRoute({}, 'signup') === 'auth')
  check('half-registered account goes to the code entry', visitorRoute({ pendingEmail: 'a@b.com' }, null) === 'verify')
  check('code entry outranks a chosen tab', visitorRoute({ pendingEmail: 'a@b.com' }, 'signup') === 'verify')

  // ── Share metadata (only crawlers and link previews ever read it) ──────────
  const indexHtml = readFileSync('index.html', 'utf8')
  check('page title names the product', /<title>MapMyCams/.test(indexHtml))
  check('meta description present', /name="description" content="[^"]{60,}"/.test(indexHtml))
  check('og:image points at the stable hero path', /og:image" content="https:\/\/mapmycams\.dev\/h\.png"/.test(indexHtml))
  check('canonical host set', /rel="canonical" href="https:\/\/mapmycams\.dev\//.test(indexHtml))
} catch (err) {
  console.error('✗ threw:', err)
  process.exit(1)
} finally {
  await server.close()
}

let failed = 0
for (const [name, ok] of checks) {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} — ${checks.length} checks`)
process.exit(failed === 0 ? 0 : 1)
