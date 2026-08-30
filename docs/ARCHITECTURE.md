# aura - Architecture

## System Overview

```
Claude Code session (per window)
  |
  |  SessionStart / UserPromptSubmit hook events (JSON on stdin)
  v
+---------------------------+
| src/hook.js  (Node)       |---- reads repo root + branch (git)
|  - color.js: identity ->  |---- writes escapes to the console (CONOUT$)
|    {hue, tint, frame}     |        OSC 11 = background tint
|  - title: repo·branch·    |        OSC 0  = window title
|    latest prompt          |
|  - state.json per session |
+------------+--------------+
             | spawns once per session (nonce-title handshake)
             v
+---------------------------+
| adapters/frame-win.ps1    |---- FindWindow by nonce title -> HWND
|  P/Invoke DwmSetWindow-   |---- DWMWA_BORDER_COLOR (34)
|  Attribute on the HWND    |---- DWMWA_CAPTION_COLOR (35)
+---------------------------+
```

## Tech Stack
| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Hook runtime | Node.js (plain JS, no deps) | Claude Code hooks are child processes; Node is already installed; zero-dependency keeps install trivial |
| Frame painter | PowerShell 5.1 + Add-Type P/Invoke | Ships as text, no compiled exe, native on every Windows 11 box |
| Terminal control | VT escape sequences (OSC 0, OSC 11) | Supported by Windows Terminal; no terminal API needed |
| Window frame | dwmapi.dll DwmSetWindowAttribute | Only supported way to color another top-level window's border/caption on Win11 22000+ |
| Install | npx bin script editing ~/.claude/settings.json | One command; merge + backup, never overwrite |
| State | %LOCALAPPDATA%/aura/state.json | HWND cache + latest prompt per session id |

## Repository Structure
```
aura/
  CLAUDE.md              # AI session rules for this repo
  package.json           # name, bin entries, no runtime deps
  README.md              # install + what it does (written last)
  docs/
    PRD.md               # scope guard
    ARCHITECTURE.md      # this file
    plans/               # dated phase plans
  src/
    color.js             # THE COLOR CONTRACT (see below) - pure, no I/O
    hook.js              # hook entry: reads stdin JSON, emits escapes, updates state
    tty.js               # opens the live terminal device: CONOUT$ (win32), /dev/tty (POSIX)
    state.js             # read/write local state (per-OS app-data dir)
    adapters/
      frame-win.ps1      # Windows 11: HWND by nonce title + DWM border/caption paint
                         # (frame-macos, frame-linux-x11 later; same interface)
  bin/
    install.js           # npx installer: registers hooks in ~/.claude/settings.json
  test/
    color.test.js        # determinism + distinctness tests (node --test)
```

## Data Model

No database. One JSON state file: `%LOCALAPPDATA%/aura/state.json`.

```json
{
  "sessions": {
    "<claude session_id>": {
      "hwnd": 123456,            // cached after nonce handshake; frame repaints use this
      "repoId": "github.com/kitfunso/hippo",
      "branch": "main",
      "lastPrompt": "fix the decay test",
      "updatedAt": "2026-08-30T12:00:00Z"
    }
  }
}
```

Constraints: file is small, rewritten atomically (write temp + rename). Stale sessions are pruned when `updatedAt` is older than 48 h.

## The Color Contract (Lane B inherits this - do not break casually)

`src/color.js` exports one pure function:

```js
colorsFor({ repoId, branch }) -> { hue, tintHex, frameHex, shadeIndex }
```

- `repoId`: origin remote URL if the repo has one (so two clones share a color), else the normalized absolute repo root path. Outside any git repo, the normalized cwd is the identity: every window still gets a color, `branch` is null, `shadeIndex` is 0.
- `hue = fnv1a(repoId) % 360`.
- `shadeIndex`: main/master = 0; other branches map to one of 4 discrete shade steps by branch-name hash. Discrete steps keep shades tellable-apart; a continuous scale would not be.
- `tintHex`: dark background tint, HSL(hue, ~35%, ~13%). Must keep default terminal text readable.
- `frameHex`: vivid frame color, HSL(hue, ~70%, 50% adjusted by shadeIndex).

This function is the shared contract: Lane B (the cross-app overlay) must import or port it unchanged so a repo has ONE color across every surface. Changing the mapping is a breaking change and needs a note in the PRD.

## API Design

No network API. The "API" is two OS/CLI surfaces:

- **Hook contract (input):** Claude Code hook JSON on stdin. Used fields: `session_id`, `cwd`, `hook_event_name`, `prompt` (UserPromptSubmit only). Auth model: none needed - hooks run as the user, everything is local.
- **Escape output:** written directly to the terminal device via `src/tty.js` (`\\.\CONOUT$` on Windows, `/dev/tty` on POSIX), NOT stdout. Claude Code captures hook stdout for context injection; the tty device is the only path to the live terminal. Load-bearing; verified by Spike step 1 of the plan.

## Service Boundaries
- `color.js` owns all color math. Nothing else computes colors.
- `hook.js` owns Claude Code integration (stdin parsing, event routing, state, escapes). It never contains Win32 knowledge.
- `src/adapters/` owns ALL OS-specific window code. Every adapter implements one interface: paint({nonceTitle | cachedHandle, frameHex}) -> handle, or null when unsupported. `frame-win.ps1` (Win32/DWM) is the only v0 adapter.
- `install.js` owns settings.json editing. It must back up settings.json before writing (matches the user's pre-write-guard convention).

## Data Flow (primary case: new session starts)
1. Claude Code fires SessionStart; `hook.js` gets JSON on stdin.
2. `hook.js` resolves repo root + branch (`git -C <cwd> rev-parse`), computes colors via `color.js`.
3. It writes OSC 11 (tint) and a one-shot nonce title (`aura:<random>`) to CONOUT$.
4. It spawns `frame.ps1`, which finds the HWND by the nonce title, paints border + caption, returns the HWND.
5. `hook.js` caches the HWND in state.json, then sets the real title `repo · branch`.
6. On each UserPromptSubmit: recompute branch (it may have changed), re-emit tint, set title `repo · branch · <prompt snippet>`, repaint frame via cached HWND (cheap, idempotent).

## Cross-Platform Support Matrix

The core (color.js, hook.js, tty.js, state.js) is OS-neutral. Exactly two things vary per OS: the tty device path (handled inside tty.js) and the frame adapter.

| Surface | Tint (OSC 11) | Title (OSC 0) | Extra | Real frame |
|---|---|---|---|---|
| Windows 11 + Windows Terminal | yes | yes | - | v0: DWM adapter |
| macOS iTerm2 | yes | yes | tab color via iTerm2 `OSC 6;1;bg` escapes | later: overlay adapter (macOS has no API to recolor another app's frame; overlay needs Accessibility permission - Lane B technique) |
| macOS stock Terminal | unverified | yes | - | same overlay adapter |
| Linux X11 (VTE terminals) | yes | yes | - | later: overlay or WM rule |
| Linux Wayland | yes | yes | - | hard (compositor-gated); tint + title carry identity |

Rules: a missing frame adapter degrades to tint + title, never errors. iTerm2 tab color is emitted only when `TERM_PROGRAM=iTerm.app`. iTerm2 escape reference: https://iterm2.com/documentation-escape-codes.html

## Known Risks (tracked, with fallbacks)
- **Claude Code may overwrite the terminal title between hooks.** Mitigation: re-assert on every prompt; the frame color sticks to the HWND regardless. If title churn is bad, title text becomes best-effort and the frame/tint carry identity. Measured in Spike step 1.
- **Windows Terminal is often single-process for many windows**, so PID-ancestry cannot identify the right window. That is exactly why HWND discovery uses the nonce-title handshake, not process walking.
- **The tty write (CONOUT$ / /dev/tty) may fail if the hook process is not attached to the terminal.** Spike step 1 proves or kills this on Windows; fallback is emitting via the statusline path instead (degraded: no tint until statusline refresh).
- **Tabs share one frame.** Accepted per PRD; tint + title still work per tab.
