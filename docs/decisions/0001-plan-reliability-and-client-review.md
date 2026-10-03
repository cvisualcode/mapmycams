# ADR 0001: Reliable plans, meaningful coverage and client review

Status: Accepted

Approved by the project owner on 2026-10-03.

## Context

The owner requested suggestion items 1, 3, 4, 5, 6, 8, 9, 10 and 11, plus fixes for saving on exit, narrow windows and automatic wall closure. Items 2 (bill of materials/camera sales) and 7 (day/night analysis) are excluded.

The actual repository is a JavaScript React 19 / Vite 8 application with a Cloudflare Worker API, KV storage, existing account/entitlement wrappers and Resend email delivery. There is no Convex backend or mobile/ application in this checkout. The instructed docs/project-definition.md and existing decisions directory are absent; this proposal does not invent an accepted policy or decision in their place.

Observed implementation concerns:

- listFloorplans() always prefers a remote row over its browser counterpart, regardless of freshness.
- Save/delete errors are swallowed, and exitEditor() navigates away without waiting for save confirmation.
- New saves receive an ID without updating the editor's loaded-plan identity.
- pagehide alone cannot guarantee delivery of a remote save when a browser terminates.
- Floor snapshots and undo currently preserve four collections but no calibration metadata.
- Wall-tool finish, mode change and floor change explicitly set closed: true; live paths omit closed, which also means closed to drawWall().
- drawWall() handles windows and doors in separate sorted lists then concatenates them, and cuts only the owning wall rather than coincident copies of a shared wall. Narrow-window failures need reproduction through the actual editor before repair.
- Share links embed a full snapshot in a fragment and currently open an editable copy behind sign-in.
- The dashboard already supports Open and Delete; item 10 extends this existing list rather than adding another one.
- Resolution thresholds exist, but placed cameras do not consistently carry a numeric resolution. Heights and room types are not currently modelled.
- The PDF report is browser print output, not a PDF byte buffer. Report emailing must not claim an attachment was generated when it was not.

## Decision

Reuse the existing React editor, shell, dashboard, styles, Worker, KV and Resend REST delivery. No new backend, notification platform, authentication system or sales integration. Extract focused editor functionality only where necessary to keep changes maintainable; do not duplicate the app shell. Preserve account ownership and paid-feature checks on the server as well as the UI.

Implement in the following gated stages. A stage does not advance until its targeted tests and actual affected user flow pass. Unexpected conflicts with this decision require a separate proposal, not a silent deviation.

### 1. Reliable save/reopen and existing plans list (item 10)

- Each editor session has one stable plan ID. A new plan does not acquire a different ID on every save.
- Persist all floors, active floor, committed edits and usable in-progress wall/wire paths. Never add the closing segment to an in-progress wall while saving.
- Write a synchronous, account-scoped browser draft after each committed change; debounce and serialize cloud writes. A drag finishes with the final geometry persisted.
- On Dashboard exit, save the latest snapshot before unmounting and report errors. On document hiding/pagehide, preserve the draft and make a bounded keepalive save attempt. This is a best effort for remote delivery, not a guarantee after process termination.
- Mark local-only changes as pending sync and retry on reopening/online. A stale remote row must not replace a pending local draft. Do not claim cloud success for a local-only save.
- Reopening the same plan restores every collection and floor. Deliberately emptying an existing plan must persist; a genuinely empty new session need not consume a plan slot.
- Scope drafts to the authenticated account, including server sessions; signing out or changing accounts must not expose another owner's layout.
- Keep existing Open/Delete. Add Rename and Duplicate to the same list, with loading/error states and delete confirmation. Duplicate copies the complete data under a new ID and respects the actual free-tier limit.
- Enforce the free-tier limit server-side for a genuinely new ID, not merely when an ID is omitted. A client-supplied ID must not bypass the limit.
- Failed server deletes must not appear successful or remove the only recoverable browser copy.

### 2. Wall and opening correctness, drawing constraints (item 9)

- The Wall tool creates an open polyline, including preview, Finish Wall, tool changes, floor changes and saved drafts. Three points form two segments (an L), not a triangle.
- The Rectangle tool still creates a closed room. Offer explicit Close Room for a wall path with at least three distinct non-collinear points; no implicit closure. Open paths are selectable at their segments but do not acquire a triangular fill or room area.
- Keep existing saved closed rooms closed; do not reinterpret legacy geometry globally.
- Derive valid opening spans once. Subtract the union of intersecting door/window openings from each visible wall segment, including coincident shared-room walls. Sort and merge spans regardless of object type, placement order, overlap or reversed endpoints.
- Small windows retain their actual span; no arbitrary minimum width turns them into a solid wall. Drawing and line-of-sight use the same spans. Wall stroke caps must not visually bridge short openings.
- Hold Shift while drawing to constrain the next segment to 45-degree increments, with the same endpoint in preview and on commit. Provide a touch-accessible angle-lock toggle without adding persistent toolbar clutter. Preserve existing Shift keyboard shortcuts and floor-below snapping when angle lock is off.

### 3. Calibration (item 5)

- Select an existing straight wall segment and enter its measured length in metres. Reject zero, negative, non-finite and degenerate lengths.
- Use a single physical scale for the whole plan: rescale coordinates on all floors by measuredLength/currentLength, using a fixed plan origin. Rescale walls, cameras, free objects, wire points and other coordinate-bearing records consistently.
- Opening t1/t2 fractions, physical object widths/heights, lens FOV, camera range and mounting heights are physical values and are not multiplied with drawing coordinates.
- Recompute attached opening positions from their wall spans after calibration. Clear stale selection/drag/analysis state and fit the view without changing the plan itself.
- Calibration is one undoable action and survives save/reopen/share. Add a simple point-to-point tape measure with metres displayed; touch and mouse use the same calculation.
- Retain backwards compatibility with flat plans and version-2 all-floor documents. New documents use version: 3 with optional calibration metadata; timeline serialization, normalization and share/report paths preserve it.

### 4. Resolution-aware analysis and height-aware obstruction (items 1 and 6)

- Persist numeric horizontal resolutionPixels per camera, with an explicit editable default for legacy cameras. Do not silently assign brand/model specifications that the catalogue does not actually provide.
- Within range/FOV and after occlusion, density is resolutionPixels / (2 * distanceMetres * tan(horizontalFov/2)). Use the existing 25/100/250 px-per-metre thresholds for Detect/Recognize/Identify. The best visible camera determines a sampled cell's quality.
- Provide a concise coverage goal control and legend. For the selected goal show met/not met/blind shading, with quality details on inspection. Keep truly blind area separate from visible-but-insufficient-resolution area; never turn an amber quality deficit into a claim that no camera sees it.
- Use one visibility calculation for the overlay, score, placement evaluation and report. Keep analysis optional and keep sampling bounded, measuring representative houses and large plans before claiming acceptable timing.
- Add mountingHeightM to cameras, physical obstructionHeightM to applicable objects and a target-height setting for analysis. Use the interpolated sight-line height at an obstruction crossing instead of treating every solid low object as a full-height wall.
- Add wardrobe and sofa presets with clearly labelled editable height defaults. Model rotated object footprints correctly. Preserve solid walls and door leaves; a low object must not block a ray passing above it. Legacy solid objects retain conservative behaviour until they have an explicit height.
- Explain that quality/height coverage is an estimate, not guaranteed face identification or an optical simulation. Mirror reflection, glass glare, lighting and vertical camera tilt are not simulated in this batch.

### 5. Room types and risk weighting (item 8)

- Closed rooms gain an editable roomType: general, entrance, hallway, living, bedroom, kitchen, garage or storage. Store it on the wall record so existing serialization paths preserve it.
- Use documented modest multipliers for entrance/garage/storage versus general rooms, together with existing door/window/stair/safe priorities; cap combined weights so one target cannot force unnecessary cameras.
- Keep measured floor coverage separate from risk-weighted coverage. Apply the same weights to recommendations and score explanations; do not mislabel risk percentages as area percentages.
- Do not recommend surveillance inside bedrooms by default. Room type is not a security guarantee.

### 6. Short, revocable share links and read-only client review (items 3 and 4)

- A share publishes an immutable version-3 snapshot in KV under a cryptographically random capability code with at least 128 bits of entropy. Example frontend route: /?share=<code>.
- POST /shares requires an authenticated, entitled owner and returns the share code/URL. GET /shares/:code returns only the published plan, display name and review metadata. It does not expose owner email, account records, session tokens or the draft that was edited later.
- Links expire after 30 days by default. DELETE /shares/:code revokes an owner's link; other owners are forbidden. The owner can see publication time, expiry and an approximate open count. KV analytics are best-effort, not transactionally exact.
- Serve the viewer before sign-in gating, with floor navigation, pan/zoom, coverage and printable report available but no editing, mutation handlers or accidental autosave back into the owner's account.
- Continue accepting existing #plan= links. Offer an explicitly labelled editable copy only to a signed-in account; it receives a new plan ID and follows account limits.
- Pins carry id, floorIndex, world x/y, bounded plain-text comment and creation time, stored separately from the immutable snapshot. POST /shares/:code/comments requires a signed-in reviewer who also has the capability link. Reviewers can delete their own pins; owners can moderate every pin. Anonymous visitors may view but cannot post.
- Validate floor/coordinate bounds, reject malformed/oversized content, rate-limit writes and enforce expiry/revocation on every endpoint. Escape comments and titles in HTML. Share possession grants access to the published house layout, so warn the owner before publishing it.
- Reports and comments never execute markup from plans. View errors (expired/revoked/missing) are visible and do not fall back to a blank editor.

### 7. Email report delivery (item 11)

- Reuse existing Resend REST delivery and server-only RESEND_API_KEY / EMAIL_FROM. Do not install Knock or create another account. Verify key names through approved tooling without reading secrets.
- Add authenticated POST /shares/:code/email. Only the share owner may send; verify recipient syntax, bound payloads and rate-limit delivery. Never permit arbitrary client-supplied HTML, sender or attachment URLs.
- Email contains a plan title, coverage summary and the application's trusted short link to a printable read-only report. The recipient can print/save it as PDF in the browser. The first version does not promise a PDF attachment: browser print output is not a generated file. Actual PDF attachment generation requires a separate implementation decision if wanted.
- Show success only when the provider accepts the message; surface missing configuration and provider errors without exposing credentials. A mocked delivery test is not a claim that live email arrived.
- If existing credentials or sender verification are missing, all non-email stages can complete; request the required keys via the project's Environment UI and report email delivery as blocked until verified.

## Interfaces and compatibility

- Frontend remains JavaScript React with the existing AppShell/providers and styles.
- Plans remain account-owned records { id, owner, name, data, updated }. Pending sync metadata belongs to the browser record, not public share data.
- data is { version: 3, activeFloor, floors: [{ walls, cameras, objects, wires }], calibration? }. Existing flat and version-2 documents remain readable.
- Public share data and comment records are separate KV namespaces, not additions to someone else's editable plan.
- Existing premium entitlements are retained for sharing, AI and PDF/report access; account limits apply to new and copied plans.
- No production data inspection/deletion, deployment, push or unrelated change is authorized by this proposal. Verification uses isolated test storage/accounts.

## Acceptance and verification

Use existing node test scripts / bun commands, adding focused regressions rather than weakening assertions. Extend the real Worker request tests with isolated KV and mock mail transport. Browser interaction checks must use the managed preview; a server-render smoke test alone does not establish autosave, gestures or read-only enforcement. There is no existing TypeScript project, so do not invent a passing tsc check; run lint, relevant suites and frontend runtime/bundling checks as appropriate without modifying Vite server settings.

Required checks, in stage order:

1. Create/edit four floors, drag/rotate/resize objects, add a wire, switch away from the populated floor, exit and reopen: IDs and contents are unchanged. Repeat via reload/hide, offline/reconnect, cloud error and stale remote row. An emptying edit persists; a new empty tab does not overwrite an old plan. Two different accounts cannot see each other's drafts. Rename/duplicate/delete retain data and enforce ownership and limits.
2. Mouse and touch three-point wall remains an L during preview, finish, mode switch, floor switch and reopen. Rectangle/explicit-close still gives a room. Windows narrower than 0.5 m cut a gap on either shared-wall copy. Reversed, overlapping and mixed door/window spans agree with visibility. Shift/angle-lock preview equals the committed endpoint.
3. Calibrate a known segment to a specified length: other-floor coordinates, attachments, cable length, reported area and coverage range remain physically consistent. Undo restores the entire original plan. Save and share round trips preserve calibration.
4. Representative threshold fixtures below/at/above 25, 100 and 250 px/m. Camera rotation, range, unknown resolution, solid walls and narrow openings. Low sofa below a high sight line does not block; tall wardrobe does; rotated obstruction behaves correctly. Overlay, score and report agree. Measure analysis time and sample counts for a typical house and a large plan.
5. Setting room type survives undo/save/share and changes documented risk weights without altering measured area. Bedrooms are not new default camera targets. Model proposals cannot bypass the coverage solver.
6. A signed-out recipient opens all published floors without editable controls. Expiry/revoke/invalid codes fail clearly. Owner-only share operations, comment auth/moderation, rate limits and malformed payload rejection are exercised through Worker requests. Reviewer pins retain their floor/coordinates after reload. Legacy fragment links still open safely.
7. Mocked email checks verify owner/entitlement enforcement, escaped content, trusted URLs, recipient validation, quotas and provider failures. One live send is tested only with available verified credentials and an approved test recipient; no live sending to unrelated people.

After each stage rerun its affected checks after the last edit. At completion run the full existing suite and lint, review the final diff, and accurately report any unavailable browser, external-email or deployment verification.

## Approval gate

The project owner explicitly approved this plan and requested a commit of this decision record on 2026-10-03. Commit this accepted record before starting implementation. Implement the gated stages and acceptance checks above in order. Approval does not authorize pushing or production deployment.
