import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash, pbkdf2Sync } from 'node:crypto'
import { handle } from '../api/index.js'
import { saveUser, hashPassword, writeJson } from '../api/_lib.js'

const url = process.argv[2]
if (!url) throw new Error('Pass the managed preview URL')
const records = new Map()
const env = {
  AUTH_SECRET: 'browser-security-fixture-secret-0123456789', APP_URL: new URL(url).origin,
  MAPMYCAMS_STORE: {
    async get(key, type) { const value = records.get(key); return value == null ? null : type === 'json' ? JSON.parse(value) : value },
    async put(key, value) { records.set(key, value) },
    async list({ prefix = '' }) { return { keys: [...records.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true } },
  },
}
globalThis.env = env
const email = 'browser-buyer@example.test', password = 'SecurityTest1'
const salt = createHash('sha256').update(email).digest()
const credential = `pbkdf2$sha256$210000$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('base64')}`
await saveUser({ id: 'browser-buyer', email, name: 'Browser Buyer', email_verified: true, plan: 'free', addons: [], password_hash: await hashPassword(credential) })
await writeJson('owned:browser-buyer:brands', { purchase: 'cs_browser' })
await writeJson('purchase:browser-buyer:cs_browser', { id: 'cs_browser', owner: 'browser-buyer', item: 'brands', kind: 'addon', status: 'paid', date: new Date().toISOString(), amount: 6.99 })

const browser = await chromium.launch({ headless: true })
const errors = []
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname
    if (!/^\/(auth|me|floorplans|billing|analytics|admin|report-error)(\/|$)/.test(path)) return route.continue()
    const response = await handle(new Request(req.url(), { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) }), env)
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  return page
}
async function signIn(page) {
  await page.goto(url)
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await page.waitForSelector('.auth-card')
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.auth-admin').count(), 0)
  await page.locator('input[type="text"], input[type="email"]').first().fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.locator('.auth-card').getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForSelector('.dashboard')
}
async function owned(page) {
  await page.locator('.fp-row').filter({ hasText: 'Brand Integration' }).getByText('Owned', { exact: true }).waitFor()
  await page.locator('.fp-row').filter({ hasText: 'brands' }).getByText('paid', { exact: true }).waitFor()
  assert.equal(await page.getByRole('checkbox', { name: /Two-factor/ }).count(), 0)
}
try {
  const page = await newPage()
  await signIn(page); await owned(page)
  console.log('✓ actual login UI hides demo Admin and restores paid add-on and receipt')
  await page.reload(); await owned(page)
  console.log('✓ reload retains account-linked purchase without local demo ownership')
  await page.getByRole('button', { name: /Sign out|Log out/i }).click()
  await signIn(page); await owned(page)
  console.log('✓ logout and sign-in restore ownership')
  const second = await newPage()
  await signIn(second); await owned(second)
  console.log('✓ fresh browser context restores the same account purchases')
  assert.deepEqual(errors, [])
  assert.ok(await second.locator('.dashboard').isVisible())
  await second.screenshot({ path: 'node_modules/.cache/account-security.png', fullPage: true })
  console.log('✓ dashboard renders with no runtime errors; screenshot saved')
} finally { await browser.close() }
