// ─── The bar on a phone ──────────────────────────────────────────────────────
// The toolbar in src/App.jsx carries four floors, the current tool's own actions, the AI
// placement, the blind-spot report, five export buttons and a notice. On a laptop that is
// a strip of controls nobody minds. On a phone it wraps into five rows of chrome over a
// plan the size of a postcard.
//
// The bar is built in a file that has grown past the size an edit can reach, so the one
// thing a phone needs and the bar cannot provide — a button that gets the rest of it out
// of the way — is rendered here, beside the editor, and it steers the bar through a class
// on this wrapper. The bar's own controls are untouched: the same buttons, the same
// handlers, laid out by CSS for the screen they are on. `menu-open` is all the CSS in
// App.css reads; nothing in the editor needs to know this exists.
//
// On a laptop the button is not shown and none of this applies — and because the layout
// is CSS rather than conditional rendering, nothing below is hidden from a screen reader
// or a keyboard at any width.

import { useEffect, useState } from 'react'

export default function EditorMobileMenu({ children }) {
  const [open, setOpen] = useState(false)

  // A press anywhere but the menu itself puts the menu away, which is what makes it read
  // as a menu rather than a panel you have to find the right button to close.
  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      const target = event.target
      if (target && typeof target.closest === 'function' && target.closest('.mobile-more, .toolbar .controls')) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [open])

  return (
    <div className={`editor-shell${open ? ' menu-open' : ''}`}>
      <button
        type="button"
        className="mobile-more"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        title="Floors, AI placement, blind spots, export and the rest"
      >
        ⋯ More
      </button>
      {children}
    </div>
  )
}
