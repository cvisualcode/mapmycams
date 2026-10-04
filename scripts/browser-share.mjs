// The share viewer in a real browser: a signed-out client with a link must see
// the whole plan read-only, with review pins and no editing controls. The Worker
// is stood in for at the network layer so this tests the actual component without
// touching production data. Run against the managed preview:
//   node scripts/browser-share.mjs <preview-url>
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'

const url = process.argv[2]
if (!url) throw new Error('Pass the managed preview URL')

const report = {
  code: 'TESTCODE', name: '14 Acacia Road', isOwner: false, canComment: false,
  created: Date.now() - 86400000, expires: Date.now() + 29 * 86400000,
  data: {
    version: 3, activeFloor: 0, calibration: { measuredMetres: 4 },
    floors: [
      {
        walls: [{ id: 1, closed: true, label: 'Kitchen', points: [{ x: 0, y: 0 }, { x: 480, y: 0 }, { x: 480, y: 400 }, { x: 0, y: 400 }] }],
        cameras: [{ id: 2, x: 80, y: 80, rotation: 45, hFov: 90, distance: 10, color: '#4ade80' }],
        objects: [{ id: 3, presetId: 'safe', x: 300, y: 200, width: 0.45, height: 0.4 }],
        wires: [],
      },
      { walls: [], cameras: [], objects: [], wires: [] },
    ],
  },
  comments: [
    { id: 'c1', authorName: 'Riley', floorIndex: 0, x: 300, y: 200, text: 'Move this camera left', created: Date.now(), canDelete: false },
  ],
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/shares/TESTCODE') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report) })
    if (path === '/shares/GONE') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'This link is not valid' }) })
    if (/^\/(auth|me|floorplans|billing|analytics|report-error)(\/|$)/.test(path)) return route.fulfill({ status: 404, contentType: 'text/html', body: 'no api' })
    return route.continue()
  })

  await page.goto(`${url}/?share=TESTCODE`)
  await page.locator('canvas').waitFor()
  assert((await page.locator('.toolbar').first().innerText()).includes('14 Acacia Road'))
  assert(!(await page.locator('body').innerText()).includes('Finish Wall'))
  assert(await page.getByRole('button', { name: 'First' }).isVisible())
  await page.getByRole('button', { name: 'First' }).click()
  await page.getByRole('button', { name: 'Ground' }).click()
  console.log('✓ a signed-out client opens every floor read-only, with no editing controls')
  const body = await page.locator('body').innerText()
  assert(body.includes('Move this camera left'))
  assert(body.includes('Sign in to comment'))
  assert(body.includes('covered') || body.includes('blind'))
  console.log('✓ review notes and the coverage summary are shown')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: 'node_modules/.cache/share-viewer.png', fullPage: true })

  // The owner's own view: publication date, expiry, open count and revocation.
  await page.route('**/shares/MYCODE', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ...report, code: 'MYCODE', isOwner: true, canComment: true, opens: 2 }),
  }))
  await page.goto(`${url}/?share=MYCODE`)
  await page.locator('canvas').waitFor()
  const ownerBody = await page.locator('body').innerText()
  assert(ownerBody.includes('Opened 2 time(s)'))
  assert(ownerBody.includes('expires'))
  assert(await page.getByRole('button', { name: 'Revoke link' }).isVisible())
  assert(ownerBody.includes('Click the plan to leave a note'))
  console.log('✓ the owner sees publication date, expiry, open count and can revoke')

  await page.goto(`${url}/?share=GONE`)
  await page.getByText('This link is not valid').waitFor()
  console.log('✓ an invalid link fails clearly instead of a blank page')
  assert.deepEqual(errors, [])
  console.log('Share viewer browser checks passed.')
} finally {
  await browser.close()
}
