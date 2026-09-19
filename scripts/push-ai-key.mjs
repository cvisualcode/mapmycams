// ─── Push a Google AI key to the Worker (optional) ───────────────────────────
// AI placement runs on the keyless Workers AI binding by default, so this is only
// needed if you would rather use Gemini — for instance because you already have a
// key. It takes the value from the workspace environment (Settings → Environment →
// GOOGLE_API_KEY) and puts it on the Worker as an encrypted secret without ever
// printing it, since wrangler reads the value from stdin.
//
//   bun run ai:key
//
// Re-run it whenever the key changes. Nothing is written to the repository.

import { execSync } from 'node:child_process'

const SECRET_NAME = 'GOOGLE_API_KEY'
const key = String(process.env[SECRET_NAME] || '').trim()

if (!key) {
  console.error(`✗ ${SECRET_NAME} is not set here.`)
  console.error('  Add it in Settings → Environment (type: secret), then run this again.')
  console.error('  Get one at https://aistudio.google.com/ — the free tier is enough.')
  process.exit(1)
}

// A shape check only: never echo the value, not even its length.
if (key.length < 20) {
  console.error(`✗ ${SECRET_NAME} looks too short to be a Google AI Studio key — nothing was pushed.`)
  process.exit(1)
}

try {
  execSync(`bunx wrangler secret put ${SECRET_NAME}`, { input: key, stdio: ['pipe', 'inherit', 'inherit'] })
  console.log(`✓ ${SECRET_NAME} pushed to the Worker (value not shown).`)
  console.log('  AI placement is live: Premium or the AI pack now gets model-suggested cameras.')
} catch {
  console.error(`✗ Could not push ${SECRET_NAME}. Check that wrangler is logged in, then re-run.`)
  process.exit(1)
}
