# Lane B: cross-app color overlay. Spike findings and go/no-go

Date: 2026-08-30. Both spikes ran live on this box (Windows 11, 1920x1200).
Code: `spike/overlay-win.ps1` (renderer), `spike/detect-win.ps1` + `spike/detect.js` (detection).
Every number below is from a screen-pixel probe or a process counter, not from reading the code.

## Question

Lane A colors Claude Code terminals. Lane B would draw the same repo colors
around ANY window (browser docs, Slack, a second agent tool) so one glance
groups every window belonging to a project. Two things had to be true:

1. A borderless overlay can track another app's window without stealing
   focus, eating clicks, lagging, or burning CPU.
2. Windows can be mapped to identities deterministically through the
   existing `src/color.js` contract, unchanged.

## Renderer verdict: PASSES

The spike overlay is a raw Win32 layered window whose region is a 3 px ring
around the target's visual rect (`DWMWA_EXTENDED_FRAME_BOUNDS`), polled at
30 ms. Measured against a scratch Notepad window:

| Check | Result |
|---|---|
| Focus theft | None. Foreground hwnd identical before and after attach, and through 8.7 s of continuous motion. |
| Click-through | `WindowFromPoint` on ring pixels returns the window BEHIND the ring, never the overlay (WS_EX_TRANSPARENT is honored by hit testing). |
| Color fidelity | All four ring sides probe exact R38 G187 B217 for #26bbd9. Center pixel untouched. |
| Tracking lag | Mid-motion screenshots: single crisp 3 px ring at the window position sampled at capture time. Worst case is one poll = 30 ms (about 8 px at the test's motion speed). No ghosting, no trails. |
| CPU | 0.72% of one core during continuous motion (gate was 3%). Idle it only wakes to compare a rect. |
| Lifecycle | Resize refits the ring, minimize hides it, restore re-shows it, closing the target makes the overlay exit on its own. |

**The one real finding:** a WinForms Form activates itself on first show even
with WS_EX_NOACTIVATE retrofitted via `SetWindowLong`, which steals focus
(measured; that was the first spike attempt). The ex-styles must be present
at `CreateWindowEx` time. So the production renderer must be raw Win32 (or
any stack that controls window creation), never WinForms/WPF defaults.

Not yet tested: DPI mix across monitors (this box is one monitor at one
scale), full-screen apps, and more than ~5 overlays at once (expected fine:
each is one timer and one window, but unmeasured).

## Detection verdict: WORKS, with an honest boundary

`detect-win.ps1` enumerates visible, titled, non-tool, non-cloaked top-level
windows (14 found on a busy desktop). `detect.js` maps each to an identity
and runs it through `src/color.js` unchanged (`git diff src/color.js` empty):

- **Terminal windows aura knows** (hwnd present in Lane A's `state.json`):
  identity = the newest session's repoId/branch, the same last-writer-wins
  rule the live paint uses. The handshook WT window resolved to `#26a3d9`,
  byte-identical to the frameHex the live hook had stored for that hwnd.
- **Everything else**: process name as repoId. Deterministic and stable:
  two runs 2 s apart were byte-identical; 2 Chrome windows shared one hex,
  4 explorer windows shared one hex.

The boundary: 3 other WT windows had no state entry (no live Claude session
in them) and fell back to the generic WT color. Without an agent hook or a
manual tag there is nothing repo-shaped to detect on an arbitrary window.
So coverage is: terminals with live Claude sessions get exact repo colors
for free via Lane A state; other apps need the PRD's detection ladder
(window-title heuristics, then manual hotkey tagging) to reach repo-level
identity. Process-level identity is already deterministic today.

## Recommendation: GO, as a separate repo

Ship Lane B as its own repo (working name: `aura-overlay`) that depends on
nothing from Lane A except the copied-in `color.js` and read-only access to
`state.json`. Reasons over an `overlay/` dir here:

- Lane A is a hook that must stay under ~70 ms and npx-installable with zero
  runtime deps. Lane B is a resident tray process with a message loop. The
  runtime shapes, packaging, and failure modes share nothing.
- The only real coupling IS the contract: `color.js` (pure, versioned) and
  the `state.json` shape. Both are cheap to consume across repos, and rule 2
  exists precisely so this stays true.
- Keeping this repo shippable as-is preserves the publish decision for
  `@kitfunso/aura` independent of Lane B's timeline.

## MVP cut

1. One resident process, tray icon, "quit" menu item.
2. Renderer: the spike's raw Win32 ring, one window class, N overlays.
3. Detection tier 1 only: aura `state.json` terminals (exact repo colors)
   plus a small built-in process-name palette for browsers/Slack.
4. Manual hotkey tag (assign the focused window to a repo) as tier 2.
5. No title heuristics in MVP; they are the fiddly 20% and tier 1+2 already
   cover the "which windows are this project" glance.

## Cost estimate

- Renderer hardening (DPI mix, monitor hotplug, sleep/resume, N overlays):
  about a day of the same measure-first loop as the spikes.
- Tray shell + config + tagging: 1 to 2 days.
- Detection tier 1 + palette: half a day (the spike is 80% of it).
- Total to a usable MVP: roughly 3 to 4 focused days, all local, no new
  dependencies or services.

## Next-plan outline (if GO)

1. Repo scaffold, copy `color.js` + contract note, pin the `state.json`
   read-only interface.
2. Port the spike renderer to a long-lived process managing N rings.
3. Tier-1 detection loop (poll state.json + window list, reconcile).
4. Tray shell + quit + start-with-Windows.
5. Hotkey tagging with a persisted tag store.
6. Soak test on the real 10-window desktop; measure CPU with 10 rings.

---

**Keith picks one:** execute the Lane B plan above, publish
`@kitfunso/aura` to npm (say the word and `private: true` comes off), or
park here. Lane A is complete, installed, and unaffected either way.
