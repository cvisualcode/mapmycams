# MapMyCams

A security-camera floorplanner. Draw a house, place cameras, and the tool tells you
what each one actually sees — coverage, blind spots, and a security score you can
print or hand to a customer.

Live: **[mapmycams.dev](https://mapmycams.dev)**

## Stack

| | |
|---|---|
| App | React + Vite, plain CSS (`src/App.jsx` is the editor) |
| API | Cloudflare Worker (`api/index.js`), KV for accounts and floorplans, Workers AI for placement |
| Payments | Stripe Checkout (subscriptions + one-off add-ons) |
| Email | Resend (sign-in codes and password resets) |
| Editor maths | `src/editor/` — geometry, coverage, history. No React, so it is all testable |

## Running it

```bash
bun install
bun run dev
```

With no API behind it — the sandbox preview, or any static host — the app runs in
**demo mode**: accounts, sessions and floorplans live in the browser. Sign in as
`Admin` / `Admin1` for full access. Deployed on Cloudflare the same accounts live on
the server instead, which is what makes one account work on every device.

```bash
bun run test        # every suite, one summary — see Tests below
bun run lint
bun run build
```

Deploy the Worker with `bunx wrangler deploy`; the static build goes to Cloudflare
Pages on push (see `.github/workflows/deploy.yml`).

## Using the planner

| Tool | What it does |
|---|---|
| **Select** | Move, rotate, copy and delete anything already on the plan |
| **Wall** | Click point by point, then **Finish Wall** — the last line is kept |
| **Rectangle** | Drag out a room in one go |
| **Wire** | Run power from an outlet to a camera |

Selecting works from the outside in: a camera, then a door's handle, then a door, then
a window, then a free-standing object, then **the wall of a room** — a room is picked by
its wall, never by its floor, so what is standing inside it stays clickable.

### Mouse, keyboard and touch

| | |
|---|---|
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z`, or the toolbar buttons. One drag is one step |
| Delete | `Delete` or `Backspace` removes whatever is selected |
| Escape | Cancels a wall or wire in progress, then clears the selection |
| Nudge | Arrow keys move the selection by 10 cm (`Shift` for 50 cm) |
| Copy | `Ctrl+D` duplicates the selected camera or item |
| Tools | `V` select · `W` wall · `R` rectangle · `L` wire · `C` camera · `O` object |
| Touch | Tap to select and place, drag to draw, **two fingers to zoom and pan** |
| Pen | Works like a mouse, including the rotation handles |

A room can be named by selecting its wall and typing in the **Room** box; the blind-spot
list, the security score and the PDF report all print that name instead of "Room 2".

## Tests

```bash
bun run test
```

Thirteen suites, ~430 checks, a couple of seconds, no network and no accounts. Each
one is a plain node script, so anything can be run on its own:

| Suite | Covers |
|---|---|
| `rooms:test` | Room naming: no two rooms called "Room 3", names the user typed are never rewritten |
| `history:test` | Undo/redo, including the no-op recording that makes observation-based history safe |
| `gestures:test` | What a finger means: tap, drag, pinch — and the zoom staying anchored between the fingers |
| `duplicate:test` | Where a copy lands, including a wall with no room left on it |
| `plan:test` | Wall occlusion, blind spots, the security score, clicking a room by its wall |
| `coverage:test` | The placement solver: coverage per camera, doors and windows prioritised |
| `ai:test` | The AI placement endpoint, both providers stubbed |
| `billing:test` / `checkout:test` | Purchases, webhooks, and the client half of checkout |
| `reset:test` | Password reset end to end: browser module → real Worker handler → memory KV → caught email |
| `visibility:test` | Funnel counting, error grouping and throttling, the admin gate |
| `landing:test` | The public home page: copy, prices, routing, metadata |
| `smoke:test` | Renders the real editor component, so a wiring mistake cannot ship silently |

## Accounts

Sign-up sends a 6-digit code and no session exists until it is entered. A forgotten
password can be reset from the sign-in screen: the code arrives by email, the new
password is set with it, and every session issued before the reset stops working.
See [`MONETISATION.md`](MONETISATION.md) for the whole account, plan and payment
design, including what each route stores and why.
