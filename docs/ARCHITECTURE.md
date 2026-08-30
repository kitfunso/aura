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
      "isRepo": true,            // repoId is a path either way, so it cannot carry this
      "frameHex": "#266ed9",     // last painted color; a mismatch is what triggers a repaint
      "vtHex": "#266ed9",        // last color whose escapes visibly landed; skips re-delivery
      "tty": "\\\\.\\CONOUT$",
      "lastPrompt": "fix the decay test",
      "updatedAt": "2026-08-30T12:00:00Z"
    }
  },
  "remotes": { "C:/Users/x/hippo": "git@github.com:kitfunso/hippo.git" },
  "frameOwner": { "123456": "<session_id> | rainbow" },
  "rainbowPid": { "123456": 4242 }
}
```

Constraints: file is small, rewritten atomically (write temp + rename). Stale sessions are pruned when `updatedAt` is older than 48 h. aura is the only writer; aura-overlay reads this file and never writes it.

### Window ownership (why the last two keys are keyed by HWND)

Tabs share one window frame, so the frame color is a property of the WINDOW, not of whichever tab wrote last. Two rules settle every conflict:

1. **A repo session outranks a bare shell.** A non-repo session (a shell in the home directory) claims the window for the hue-cycle loop only when no live repo session shares it, and it never writes the frame color itself: `decideEvent` returns `paintsFrame: false` and the hook passes `-NoPaint`, so the adapter resolves the HWND without touching the color. `rainbow-win.ps1` is the painter for those windows, and it stands down the moment `frameOwner[hwnd]` names a session.
2. **A repo session takes its frame back.** If its window is still rainbow-owned, the session repaints once (`reclaimFrame`) even when every cached value matches, and that paint writes `frameOwner[hwnd] = sessionId`, which the loop sees before its next write.

Measured 2026-08-30, the case that forced this: 7 sessions all on hwnd 853852, one of them started outside a repo, one `frameOwner` entry reading `rainbow`. Every repo tab lost its color, and because Lane B skips rainbow-owned windows, the terminal got no ring at all.

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
- `src/adapters/` owns ALL OS-specific window code. Every adapter implements one interface: paint({foreground | cachedHandle, frameHex}) -> handle, or 0/null when unsupported or rejected. `-NoPaint` resolves the handle without writing a color (see Window ownership). `frame-win.ps1` (Win32/DWM) and `rainbow-win.ps1` (hue loop) are the v0 adapters.
- `decide.js` owns every what-to-do rule: identity precedence, when to spawn, who paints, who owns a window. It is pure, so the rules are testable without a desktop.
- `install.js` owns settings.json editing. It must back up settings.json before writing (matches the user's pre-write-guard convention).

## Data Flow (primary case: new session starts)
1. Claude Code fires SessionStart; `hook.js` gets JSON on stdin.
2. `hook.js` resolves repo root + branch (`git -C <cwd> rev-parse`), computes colors via `color.js`.
3. It builds one escape string: OSC 11 (tint), the tab color (Windows Terminal: `OSC 4;200;rgb:RR/GG/BB` + DECAC `ESC[2;15;200,|`, gated on `WT_SESSION`; iTerm2: `OSC 6;1;bg` triple, gated on `TERM_PROGRAM`), and the title `repo · branch`. It writes it to the tty device - the visible path on POSIX. On Windows hooks run with a hidden console (see Known Risks), so visible delivery happens in step 4.
4. If no HWND is cached, the frame color changed, or the VT payload has not visibly landed for this session (`vtHex`), it spawns `frame-win.ps1` once. The adapter takes `GetForegroundWindow()` - the window the user just typed in - verifies it belongs to an allowlisted terminal process (so an alt-tab race can never paint another app), paints border + caption, prints the HWND, then resolves the topmost console ancestors. On a prompt event it attaches and writes the VT payload immediately. On SessionStart an immediate write races Claude Code's TUI init and gets wiped (measured), and a detached process cannot resolve the ancestry later (the walk only sees live processes; the hook's node parent dies first) - so the adapter hands the LIVE-resolved target PIDs to a detached hidden grandchild that sleeps ~2 s, re-checks `vtHex` in state (skip if a prompt delivered first), then attaches and writes. Colors are visible before the user types anything.
5. `hook.js` caches the HWND and `vtHex` in state.json. A rejected foreground (user was elsewhere) is retried on the next prompt. `vtHex` is only marked on prompt events, and SessionStart clears the session's cached `hwnd` + `vtHex` first (a resumed session may live in a new tab or window now), so the first prompt re-delivers once as the backstop.
6. On each further UserPromptSubmit: recompute branch (it may have changed). The DWM frame color persists on the window and `vtHex` matches, so NO PowerShell spawn happens unless a color changed - the steady-state path stays at the ~70 ms budget (the once-per-session-start resolve+paint+handover spawn costs ~2 s, measured).

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
- **MEASURED 2026-08-30 (e2e, root cause): Claude Code spawns hooks with their own HIDDEN console on Windows.** The hook's direct `CONOUT$` open + write SUCCEEDS (state recorded `tty: \\.\CONOUT$`) but lands in an invisible buffer - pixels never change. The earlier "CONOUT$ works from the process tree" spike result came from tool-spawned probes that shared the real console; hooks do not. Visible delivery on Windows is `AttachConsole()` to the TOPMOST console-attached ancestor (that ancestor owns the tab's real console; the hook's own node/cmd parents hold the hidden one; GUI ancestors like WindowsTerminal refuse attach and are skipped). This ships inside `frame-win.ps1` (`-VtB64`), riding the same once-per-color spawn as the DWM paint, so the steady-state path stays spawn-free. `session.vtHex` records delivery; it is only marked from UserPromptSubmit, so a SessionStart delivery that races Claude Code's TUI init gets one re-delivery at the first prompt. Verified live: tab + tint + border all pixel-exact (#d9266e / #2d161f) after the first prompt.
- **The direct tty write (CONOUT$ / /dev/tty) stays in the hook** - it is the visible path wherever the hook DOES share the terminal's console (expected on POSIX /dev/tty; unverified until tested on a Mac). On Windows it is harmless and the state field `tty` doubles as a diagnostic.
- **Per-prompt title updates do not work on Windows** (they would need a per-prompt attach spawn, which the budget bans). In practice Claude Code itself sets the tab title to the latest prompt text, which covers the "latest prompt floating at the top" ask natively; aura's `repo · branch` title lands at paint events and is best-effort (observed surviving on idle tabs).
- **Tabs share one frame** (DWM is per-window). Precisely: the frame keeps the color of the last session that PAINTED it - sessions repaint only on first paint or color change, so a prompt in another tab does not reclaim the frame (observed live: pink -> blue -> pink across three sessions in one window). For one-window-per-session workflows the frame is always right. Per-tab identity = tab color + tint + title. Tab color, MEASURED 2026-08-30 (screenshot-verified on WT stable): `OSC 4;200;rgb:RR/GG/BB` + DECAC `ESC[2;15;200,|` sets the tab to the exact RGB; the basic form `ESC[2;15;1,|` (16-color red) also works. The PR #13058 extended slot 262 recolors the PANE BACKGROUND on this build, not the tab (`OSC 104;262` undoes that). Caveat: a tab launched with `--tabColor` cannot be overridden by the escape.
- **MEASURED 2026-08-30: DWM caption color is INVISIBLE in stock Windows Terminal** - WT draws its own tab strip over the title bar, so only the 1 px border shows from the frame paint (and snapped/maximized edges hide most of it). In tabbed layouts the tab color + tint ARE the identity; the frame is a bonus for floating windows. Keep painting both DWM attributes: caption shows on conhost and any terminal with a standard title bar.
- **Headless guard (design fix 2026-08-30, broadened same day):** the foreground handshake only runs when a known terminal marker is in the environment (`WT_SESSION`, `WEZTERM_PANE`, `ALACRITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR` - see `TERMINAL_MARKERS` in `src/decide.js`). Cron / Task Scheduler / service-spawned `claude -p` sessions carry no marker, and grabbing the foreground window there would paint an unrelated window the wrong color. The adapter's process-name allowlist is the second layer: even with a marker present, only a terminal-process foreground window is ever painted. `WT_SESSION` is measured on this box; the other markers come from each terminal's docs and are best-effort until tested live. Plain conhost sets no marker and never gets a first paint (tint + title only). Cached-HWND repaints stay allowed.
