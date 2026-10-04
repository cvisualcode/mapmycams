// One controller per editor session. Local writes are synchronous; cloud requests
// are serialized so the last drag position cannot be overtaken by an older save.
export function createAutosave({ writeDraft, save, onStatus, delay = 700 }) {
  let latest = null, timer = null, running = null, saved = null, disposed = false
  const status = onStatus || (() => {})
  function capture(snapshot) {
    const key = JSON.stringify(snapshot)
    if (latest?.key === key) return
    writeDraft(snapshot)
    latest = { snapshot, key }
    status('Changes saved in this browser; syncing…')
    clearTimeout(timer)
    timer = setTimeout(() => { flush().catch((error) => status(`Saved in this browser only: ${error.message}`)) }, delay)
  }
  async function flush(options = {}) {
    clearTimeout(timer)
    if (running) { await running; return flush(options) }
    if (!latest || latest.key === saved || disposed) return
    const entry = latest
    running = Promise.resolve().then(() => save(entry.snapshot, options))
    try {
      await running
      saved = entry.key
      status('Saved')
    } catch (error) {
      status(`Saved in this browser only: ${error.message}`)
      throw error
    } finally { running = null }
    if (latest?.key !== saved) return flush(options)
  }
  return { capture, flush, dispose() { clearTimeout(timer); disposed = true } }
}
