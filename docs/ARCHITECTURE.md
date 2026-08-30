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
|    {hue, tint, frame}     |        OSC 11 = background tint (per tab)
|  - title: repo·branch·    |        OSC 4 + DECAC = tab header color (per tab, WT 1.15+)
|    latest prompt          |        OSC 0  = window/tab title
|    latest prompt          |
|  - state.json per session |
+------------+--------------+
             | spawns on first paint / color change (foreground handshake)
             v
+---------------------------+
| adapters/frame-win.ps1    |---- GetForegroundWindow -> HWND (terminal allowlist)
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
      frame-win.ps1      # Windows 11: foreground HWND (allowlisted) + DWM border/caption paint
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
      "hwnd": 123456,            // cached after foreground handshake; frame repaints use this
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
- `src/adapters/` owns ALL OS-specific window code. Every adapter implements one interface: paint({foreground | cachedHandle, frameHex}) -> handle, or 0/null when unsupported or rejected. `frame-win.ps1` (Win32/DWM) is the only v0 adapter.
- `install.js` owns settings.json editing. It must back up settings.json before writing (matches the user's pre-write-guard convention).

## Data Flow (primary case: new session starts)
1. Claude Code fires SessionStart; `hook.js` gets JSON on stdin.
2. `hook.js` resolves repo root + branch (`git -C <cwd> rev-parse`), computes colors via `color.js`.
3. It writes one escape string to the tty device: OSC 11 (tint), the tab color (Windows Terminal: `OSC 4;262;rgb:RR/GG/BB` + DECAC `ESC[2;15;262,|`, gated on `WT_SESSION`; iTerm2: `OSC 6;1;bg` triple, gated on `TERM_PROGRAM`), and the title `repo · branch`.
4. If no HWND is cached (or the frame color changed), it spawns the frame adapter. The adapter takes `GetForegroundWindow()` - the window the user just typed in - verifies the window belongs to an allowlisted terminal process (so an alt-tab race can never paint another app), paints border + caption, and prints the HWND.
5. `hook.js` caches the HWND in state.json. A rejected foreground (user was elsewhere) is retried on the next prompt.
6. On each UserPromptSubmit: recompute branch (it may have changed), re-emit tint, set title `repo · branch · <prompt snippet>`. The DWM frame color persists on the window, so NO repaint and NO PowerShell spawn happens unless the color changed - the per-prompt path stays under the 50 ms budget.

## Cross-Platform Support Matrix

The core (color.js, hook.js, tty.js, state.js) is OS-neutral. Exactly two things vary per OS: the tty device path (handled inside tty.js) and the frame adapter.

| Surface | Tint (OSC 11) | Title (OSC 0) | Tab color | Real frame |
|---|---|---|---|---|
| Windows 11 + Windows Terminal | yes | yes | DECAC + OSC 4, WT 1.15+ (PR microsoft/terminal#13058) | v0: DWM adapter |
| macOS iTerm2 | yes | yes | iTerm2 `OSC 6;1;bg` escapes | later: overlay adapter (macOS has no API to recolor another app's frame; overlay needs Accessibility permission - Lane B technique) |
| macOS stock Terminal | unverified | yes | - | same overlay adapter |
| Linux X11 (VTE terminals) | yes | yes | - | later: overlay or WM rule |
| Linux Wayland | yes | yes | - | hard (compositor-gated); tint + title carry identity |

Rules: a missing frame adapter degrades to tint + title, never errors. iTerm2 tab color is emitted only when `TERM_PROGRAM=iTerm.app`. iTerm2 escape reference: https://iterm2.com/documentation-escape-codes.html

## Known Risks (tracked, with fallbacks)
- **CONFIRMED 2026-08-30 (spikes): Claude Code overwrites the terminal title continuously** - a nonce title set by a child process never survives long enough to find the window by it (polled 1000 ms, never seen). Title text is therefore best-effort, re-asserted per prompt; frame + tint carry identity. This also killed the nonce-title handshake: HWND discovery is `GetForegroundWindow()` at prompt time, gated by a terminal-process allowlist (WindowsTerminal, OpenConsole, conhost, wezterm-gui, alacritty, ghostty).
- **CONFIRMED 2026-08-30: Windows Terminal runs all windows in one process** (four windows, one PID measured), so PID matching cannot identify a window. Foreground handshake avoids it entirely.
- **CONFIRMED 2026-08-30: CONOUT$ escape delivery works from Claude Code's process tree** - the user saw the tint land. `GetConsoleWindow()=0` under ConPTY is normal and does NOT mean the console is invisible. If a future hook context turns out detached, the measured fallback is `AttachConsole()` to an ancestor process (spike/attach-spike.ps1 proved the write path: attached to bash.exe ancestor, 13 bytes written).
- **The tty write (CONOUT$ / /dev/tty) may fail if the hook process is not attached to the terminal.** Spike step 1 proves or kills this on Windows; fallback is emitting via the statusline path instead (degraded: no tint until statusline refresh).
- **Tabs share one frame** (DWM is per-window). The frame shows the color of the last-typed session. Per-tab identity = tab color + tint + title. Tab color caveats: a tab launched with `--tabColor` cannot be overridden by the escape; the extended palette slot 262 (FRAME_BACKGROUND) addressing via OSC 4 is documented in PR #13058 but not yet verified on this box - the basic 16-color DECAC form (`ESC[2;15;1,|` = red) is confirmed working by a WT maintainer. Verify both live; if slot 262 fails, quantize to the 16-color palette or redefine a high classic slot.
