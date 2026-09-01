# aura - Architecture

## System Overview

```
  shell prompt            Claude Code hook          any script
  aura mark --write       SessionStart / prompt     aura mark --cwd <dir>
        |                        |                        |
        +------------------------+------------------------+
                                 |
                                 v
              +---------------------------------+
              | src/mark.js  (the core)         |-- git: repo root + branch
              |  color.js  identity -> colors   |-- escapes: OSC 11 tint, OSC 4 +
              |  decide.js what to do about it  |   DECAC tab color, OSC 0 title
              |  state.js  per-session record   |-- sink: the caller's console, or
              +----------------+----------------+   the tty device (CONOUT$, /dev/tty)
                               | spawns on first paint or color change
                               v
              +---------------------------------+
              | adapters/frame-win.ps1          |-- GetForegroundWindow -> HWND
              |  P/Invoke DwmSetWindowAttribute |   (terminal-process allowlist)
              |  on that one HWND               |-- BORDER_COLOR 34, CAPTION_COLOR 35
              +---------------------------------+
```

## Who calls the core

Every caller answers one question: which directory is this window in now? The
core does the rest, and none of it knows what is running in the window.

| Caller | Fires on | Why it exists |
|---|---|---|
| Shell prompt (`aura mark --write`) | every prompt where `$PWD` changed | one integration covers every agent and a bare git shell |
| Claude Code hook (`src/hook.js`) | SessionStart, UserPromptSubmit | colors a session at startup, before its first prompt |
| Any script (`aura mark --cwd <dir>`) | whenever the caller says so | escape hatch for tools with their own events |

The consequence, accepted 2026-08-31 (PRD "IS NOT" item 9): a color means the
window is in that repo, not that an agent is working in it.

All three callers answer with a directory, and a directory can be the wrong
answer: agents are launched from home folders, which name no project. So a
session may carry a tag, and `mark()` prefers it over the cwd every caller
reports. `aura tag <dir>` writes it, keyed by the session id the agent already
exports. See Data Model.

Two differences follow from who owns the console:

- **Escapes.** A shell prompt owns a visible console, so the CLI writes them
  itself (`--write`, falling back to stdout) and no PowerShell hop is needed.
  A Claude Code hook does not (see Known Risks), so its escapes ride the
  adapter spawn. That is the `redeliverVt` flag on `mark()`: the hook sets it,
  the CLI does not.
- **Stdout.** The hook may never print (rule 3: Claude Code captures hook
  stdout as model context). The CLI may, because its caller is a shell that
  will render it.

## Tech Stack
| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Core runtime | Node.js (plain JS, no deps) | hooks and shell prompts both spawn child processes; Node is already installed; zero-dependency keeps install trivial |
| Shell integration | prompt-function snippets (PowerShell, bash, zsh) | the shell already knows its own directory; wrapping the existing prompt leaves posh-git / oh-my-posh / Starship working |
| Frame painter | PowerShell 5.1 + Add-Type P/Invoke | Ships as text, no compiled exe, native on every Windows 11 box |
| Terminal control | VT escape sequences (OSC 0, OSC 11) | Supported by Windows Terminal; no terminal API needed |
| Window frame | dwmapi.dll DwmSetWindowAttribute | Only supported way to color another top-level window's border/caption on Win11 22000+ |
| Install | npx bin script editing a shell profile and/or ~/.claude/settings.json | One command per target; merge + backup, never overwrite |
| State | %LOCALAPPDATA%/aura/state.json | HWND cache + latest prompt per session id; concurrent shells write deltas under a lock file |

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
    mark.js              # THE CORE every caller goes through: identity -> escapes -> paint -> state
    hook.js              # caller: Claude Code hook, reads stdin JSON
    decide.js            # pure decision core: identity precedence + event routing
    git.js               # the git probe: repo root, branch, cached origin remote
    tty.js               # opens the live terminal device: CONOUT$ (win32), /dev/tty (POSIX)
    state.js             # read/write local state (per-OS app-data dir), locked delta writes
    tag.js               # the second identity source: pin a session to a repo, outranks cwd
    install.js           # installer: shell profile block, or ~/.claude/settings.json merge
    shell/
      init.js            # puts the CLI path into a snippet
      powershell.ps1     # prompt wrapper, sourced from $PROFILE
      posix.sh           # the same for bash (PROMPT_COMMAND) and zsh (precmd_functions)
    adapters/
      frame-win.ps1      # Windows 11: foreground HWND (allowlisted) + DWM border/caption paint
                         # (frame-macos, frame-linux-x11 later; same interface)
  bin/
    aura.js              # the only binary: mark | tag | install | uninstall | shell-init
  test/
    color.test.js        # determinism + distinctness tests (node --test)
```

## Data Model

No database. One JSON state file: `%LOCALAPPDATA%/aura/state.json`.

Session ids come from whoever called: Claude Code's own `session_id`, or
`shell-<pid>-<start second>` from a shell snippet. The start second is there
because Windows recycles pids well inside the 48 h prune window, and a
recycled pid inheriting a stale entry would inherit its cached HWND with it.

```json
{
  "sessions": {
    "<claude session_id> | shell-<pid>-<second>": {
      "hwnd": 123456,            // cached after foreground handshake; frame repaints use this
      "repoId": "github.com/kitfunso/hippo",
      "branch": "main",
      "isRepo": true,            // a git repo, literally; repoId is a path either way
      "hasColor": true,          // aura owns a color here: a repo, a tag, or a named tab
      "windowName": "intraday",  // the tab name, settled once per session; "" means asked and refused
      "windowProbe": "intraday", // the first read, held until a second prompt confirms it
      "frameHex": "#266ed9",     // last painted color; a mismatch is what triggers a repaint
      "vtSent": "1kf3n",         // digest of the escapes that visibly landed; skips re-delivery
      "frameCleared": true,      // off-repo only: the frame was reset to default already
      "tty": "\\\\.\\CONOUT$",
      "lastPrompt": "fix the decay test",
      "updatedAt": "2026-08-30T12:00:00Z"
    }
  },
  "tags": { "<session id>": "C:/Users/x/hippo" },
  "remotes": { "C:/Users/x/hippo": "git@github.com:kitfunso/hippo.git" },
  "frameOwner": { "123456": "<session_id> | cleared" }
}
```

Constraints: file is small, rewritten atomically (write temp + rename). Stale sessions are pruned when `updatedAt` is older than 48 h. aura is the only writer; aura-overlay reads this file and never writes it.

`tags` is the second identity source, and the only one a person sets by hand.
`mark()` reads it before it looks at the cwd, so an agent launched from a home
folder can still name its project. Its key is the session key, so the tag and
the prompts that repaint the window agree on one entry: `CLAUDE_CODE_SESSION_ID`
inside a Claude Code session, `AURA_SESSION` inside any other agent the shell
snippet started, `shell-<ppid>` otherwise. A tag is pruned when its session is,
which is why `writeTag` touches the session entry in the same delta: without
one, the prune in that very write would drop the tag it just set.

`windowName` is the third identity source and the only automatic one that works
outside a repo. A Windows Terminal window title is the ACTIVE TAB's name, and a
tab the user renamed keeps that name for the life of the window, so it names a
project that no path names. It is read through `frame-win.ps1 -QueryTitle`,
which costs a PowerShell spawn, so it is read on prompt events only, at most
TWICE per session, and the answer is cached for the session's life (rule 5 keeps
spawns off the steady path). The read passes the cached HWND, so a foreground
window that is not this session's cannot answer for it. Tabs share one HWND, so
the handle cannot pick a tab: what makes the answer this tab's is the timing.
The read rides a prompt, and at a prompt the user has just typed here.

The hard part is that a title is not a name unless a person set it. Four guards
separate the two. A title over 40 characters is prompt text. A title holding
aura's own `·` separator is aura's. A title holding `/` or `:` is a path a shell
wrote in, and a title that is a shell's own default (`Windows PowerShell`,
`cmd.exe`, and the rest of `DEFAULT_TITLES`) names a shell, not a project. What
survives all four still has to hold still: `settleWindowName` keeps the first
read as a probe and adopts it only when a second prompt reads the same string,
because an agent's title follows the prompt while a name does not. Anything else
caches `""` and is never looked up again. A session that takes its identity from
the title writes NO `OSC 0`, because renaming the tab would move the color it
just read. A rename lands on the next session.

`remotes` is a cache, but it is not optional. `resolveIdentity` fills it from a
second git spawn, and rule 5 allows only one on the prompt path. So the delta
write has to carry it, or every prompt pays that spawn again.

### Writes are deltas under a lock (not whole-file overwrites)

Every open shell is now a writer, and a single `mark()` call can spend seconds
between reading state and writing it (the adapter spawn is a `execFileSync`
with a 5000 ms timeout). Writing back the snapshot it read would delete every
entry other shells wrote in that gap, which is exactly the "zero wrong-window
incidents" metric failing.

So the commit phase writes a delta: only this session's entry, plus one
`frameOwner` key, applied to a **fresh** read taken under a lock, after the
slow work. The lock is `state.json.lock`, created with `fs.openSync(path,
"wx")` because exclusive-create is the atomic primitive every filesystem
agrees on. Two escape valves keep rule 6 (never stall a prompt): a lock older
than 5000 ms belonged to a process that died holding it and is taken, and a
waiter gives up after 200 ms and writes nothing. A lost update costs one
repaint; a stalled prompt costs the user.

The lock alone was not enough, and a 24-writer race lost an entry about once
in 40 rounds. Three separate holes, all measured on 2026-08-31 and all fixed:

1. **Windows refuses the rename while a reader holds the destination open.**
   `renameSync` fails with EPERM, and succeeds the moment that reader closes.
   With one shared file and one reader per prompt, that lands often enough to
   see. The temp name is now per process, and the rename waits the reader out
   to a 250 ms deadline. Note the real sleep granularity here is about 15 ms,
   not the 5 ms asked for, so budgets are deadlines and never attempt counts.
2. **An unreadable file read as an empty one.** `readState` caught every error
   and returned `{sessions:{}}`, which the next write then persisted, deleting
   every other window. It now returns `null` for any IO error that is not
   ENOENT, and `updateState` leaves the file alone and reports `false`.
   Unparseable JSON still starts fresh, so a corrupt file cannot wedge aura.
3. **Giving up on the lock still wrote.** The timeout path returned a no-op
   release and carried on unsynchronized, which is the loss the lock exists to
   prevent. It now writes nothing.

Contention itself was never the problem: the locked section measures ~1 ms,
and 24 forked writers see a median 2 ms wait with no give-ups at all.

### Window ownership (why the last two keys are keyed by HWND)

Tabs share one window frame, so the frame color is a property of the WINDOW, not of whichever tab wrote last. Two rules settle every conflict:

1. **No identity, no color.** A session with no repo, no tag and no tab name writes nothing colored: no background tint, no tab color, no frame. `decideEvent` returns `usesColor: false`, so the hook builds a title-only escape string (or nothing, when it has no title to set either), and `resetFrame: true`, so the adapter writes `DWMWA_COLOR_DEFAULT` (`-Reset`) once and the window goes back to the terminal's own frame. The reset is marked `frameCleared` on the session, so later prompts stay spawn-free.
2. **A repo session outranks a bare shell.** The reset must never strip a color a repo tab in the same window owns. The hook passes the live repo sessions' HWNDs as `-SkipHwnds` and the adapter re-checks the list AFTER resolving the window, because the handle may not be cached yet. A skipped reset leaves the frame alone.
3. **A repo session takes its frame back.** If `frameOwner[hwnd]` reads `cleared`, the repo session repaints once (`reclaimFrame`) even when every cached value matches, and that paint writes `frameOwner[hwnd] = sessionId`.

Measured 2026-08-30, the case that forced rule 2: 7 sessions all on hwnd 853852, one of them started outside a repo. Every repo tab lost its color.

An earlier version colored non-repo windows with a detached hue-cycle loop (`rainbow-win.ps1`). It was removed on 2026-08-30: off-repo now means the default window, so the loop, its `rainbowPid` state key, and the `rainbow` owner value are gone.

The start-time window is a guess. `GetForegroundWindow()` at SessionStart can land on any window the user happened to be looking at, so the first prompt after a session start re-resolves the handle (`reresolveWindow` in `decide.js`); that event already spawns the adapter for VT delivery, so the correction is free. Measured 2026-08-30: 5 visible Windows Terminal windows, every session in state cached the same hwnd, and only one window wore a color.

## The Color Contract (Lane B inherits this - do not break casually)

`src/color.js` exports one pure function:

```js
colorsFor({ repoId, branch }) -> { hue, tintHex, frameHex, shadeIndex }
```

- `repoId`: origin remote URL if the repo has one (so two clones share a color), else the normalized absolute repo root path. Outside any git repo it is `window:<tab name>` when the tab has a usable name, else the normalized cwd; either way `branch` is null and `shadeIndex` is 0. The `window:` prefix is what stops a tab called `aura` landing on the aura repo's hue.
- `hue = fnv1a(repoId) % 360`.
- `shadeIndex`: main/master = 0; other branches map to one of 4 discrete shade steps by branch-name hash. Discrete steps keep shades tellable-apart; a continuous scale would not be.
- `tintHex`: dark background tint, HSL(hue, ~35%, ~13%). Must keep default terminal text readable.
- `frameHex`: vivid frame color, HSL(hue, ~70%, 50% adjusted by shadeIndex).

This function is the shared contract: Lane B (the cross-app overlay) must import or port it unchanged so a repo has ONE color across every surface. Changing the mapping is a breaking change and needs a note in the PRD.

### Giving the terminal back (every set has an undo)

The escapes aura writes are not scoped to a process. `OSC 11` (default
background) and `OSC 4;<slot>` (palette entry) mutate the terminal itself and
persist for the life of the tab, so a window aura colored stayed colored after
the shell left the repo, after the agent exited, and after aura was uninstalled.
Closing the tab was the only way back. That is what `buildEscapes` returning
"just the title" off-repo actually meant.

`buildEscapes` is now symmetric. It takes `wasColored` (the previous run's
`session.hasColor`) and returns the undo when a session that HAD color no longer
does:

- `OSC 111` resets the default background, the counterpart to `OSC 11`.
- `OSC 104;264` resets the tab slot, the counterpart to `OSC 4;264`. DECAC still
  points at 264, which now holds the terminal's own default, so it needs no undo.
- `OSC 104;200` repairs the slot aura owned until 0.1.1 and never released. It
  rides BOTH branches, because a window that never leaves its repo would
  otherwise keep a wrong text color forever. Slot 200 is inside the 256-color
  text palette, so anything printed in color 200 came out as the repo color.
  It repairs terminals, not aura, so it can be deleted once no tab opened under
  0.1.0 or 0.1.1 is still alive. A tab lives as long as its window, so treat
  that as "when 0.1.1 is far enough back to be gone", not a dated release.

Support: OSC 104/110/111/112/117 landed in microsoft/terminal PR #18767, merged
2025-04-10 and serviced into 1.22 and 1.23. This box runs 1.24.11911.0. The
Microsoft conhost VT reference does not list them, or OSC 10/11 either, and is
not the authority on Windows Terminal.

`wasColored` is what keeps this honest: aura restores only what aura set, so a
terminal it never touched keeps whatever colors the user configured. Delivery is
once, not per prompt, because the restore changes the `vtSignature` digest and
the next identical prompt matches the cached one.

One place outside the prompt path needs the same undo: `aura uninstall` writes it
to the terminal it runs in before removing the code that could. Inside the prompt
path, a session whose color clears gets it from the same builder.

Known gap, 0.1.2: `wasColored` reads `session.hasColor`, so the undo is keyed to
the SESSION, and the thing being undone is the TAB. End a session in a colored
repo tab, start a fresh one in that same tab, and stay off-repo: the new session
never set a color, so it sends no restore and the tab stays colored. Closing this
needs a per-tab identity aura does not have. The frame's HWND ownership cannot
stand in, because WT tabs share one HWND and the restore would wipe every sibling
tab. The two real routes are querying the live background with `OSC 11;?` and
reading the reply off the tty, or dropping the "restore only what aura set"
guarantee on SessionStart. Both are design calls, not patches.

On iTerm2 the tab color is given back with `OSC 6;1;bg;*;default`, the one reset
iTerm2 documents for the three setters aura writes. Nobody on this box runs
iTerm2, so it is covered by a unit test on the bytes and not by pixels.

A unit test on bytes only proves the bytes match what we wrote. So on 2026-09-01
the path was checked against iTerm2's own parser, `sources/VT100/VT100Terminal.m`
in gnachman/iTerm2, which is the code that will actually read these bytes:

| Part | aura sends | iTerm2's parser |
|---|---|---|
| gate | `TERM_PROGRAM === "iTerm.app"` | the standard way a shell detects iTerm2 |
| set | `OSC 6;1;bg;red\|green\|blue;brightness;N` | `class` must be `bg`, `attribute` must be `brightness` |
| value | decimal 0-255, from `parseInt(hex, 16)` | "legal values: decimal integers in 0-255", read as `MIN(1, [value intValue] / 255.0)` |
| reset | `OSC 6;1;bg;*;default` | the only 4-argument form it accepts |
| terminator | `BEL` (0x07) | "`ST` means either `BEL` (hex code 0x07) or `ESC \`" |

**`bg` here does not mean the window background. Do not "fix" it to OSC 11.**
The name is inherited from Eterm, but every branch in that parser dispatches to
a tab-colour method: the three setters call
`terminalSetTabColor{Red,Green,Blue}ComponentTo:` and the reset calls
`terminalSetCurrentTabColor:nil`. So on iTerm2 the two colours split the same
way they do on Windows Terminal, with OSC 11 tinting the background and OSC 6
colouring the tab chrome.

Parser: https://github.com/gnachman/iTerm2/blob/master/sources/VT100/VT100Terminal.m
Escape shapes and the `ST` definition: https://iterm2.com/documentation-escape-codes.html
The `TERM_PROGRAM` value: https://groups.google.com/g/iterm2-discuss/c/MpOWDIn6QTs

One thing stays unproven, and desk work cannot close it: whether a real iTerm2
tab repaints. That needs a Mac.

### Silence is not an answer

The restore made a slow `git` expensive. `runGit` returned `null` both when git
said "not a repo" (exit 128) and when the 1500 ms deadline killed it, so a git
that missed its deadline under load read as "this window left its repo" and the
restore fired: a colored window flashed back to the terminal default, then
colored again on the next prompt. Measured discriminator: a real answer always
carries a numeric `status`; a killed spawn carries `status: null`,
`signal: SIGTERM`, `code: ETIMEDOUT` and empty stdout.

`runGit` now returns a `NO_ANSWER` sentinel for a killed spawn only. A missing
git still returns `null`, because "there is no git here" IS an answer and a box
without git must still color by tab name. `resolveIdentity` turns `NO_ANSWER`
into `{ unresolved: true }` (including from the remote-URL probe, where caching a
timeout as "no origin" would move the color to the path hue), and `mark()` then
returns early: no escapes, no adapter spawn, no state write. The window keeps
exactly what it has until git answers.

## API Design

No network API. The "API" is three OS/CLI surfaces:

- **Hook contract (input):** Claude Code hook JSON on stdin. Used fields: `session_id`, `cwd`, `hook_event_name`, `prompt` (UserPromptSubmit only). Auth model: none needed - hooks run as the user, everything is local.
- **CLI contract:** `aura mark [--write] [--cwd <dir>] [--session <id>] [--title <text>]`. Defaults: the process cwd, `shell-<ppid>`, no title. `--write` sends the escapes to the tty device and prints nothing; without it, or when that device is unreachable, they go to stdout for the caller to render. It always exits 0 and prints nothing on failure, because it runs on a prompt path. `aura tag [<dir>] [--clear] [--session <id>]` pins this session to a directory, prints the current pin with no argument, and exits 1 on a directory that does not exist. It writes state and then paints the window itself, on the adapter path a hook uses, because a full-screen agent has no prompt coming to do it. The paint is gated on a terminal-session marker in the environment, so a headless run never grabs a foreground window. `aura shell-init --shell <name>` prints the snippet a profile sources; `aura install` / `aura uninstall` wire and unwire it.
- **Escape output:** written directly to the terminal device via `src/tty.js` (`\\.\CONOUT$` on Windows, `/dev/tty` on POSIX), NOT stdout, whenever the caller is a hook. Claude Code captures hook stdout for context injection; the tty device is the only path to the live terminal. Load-bearing; verified by Spike step 1 of the plan. The CLI is not a hook, so stdout is a legitimate sink for it.

## Service Boundaries
- `color.js` owns all color math. Nothing else computes colors.
- `mark.js` owns the whole act of marking a window: identity, colors, escapes, the paint, the state delta. It takes its sink and its environment as arguments, so a caller decides where bytes go without `mark.js` knowing who the caller is. It never contains Win32 knowledge.
- `hook.js` owns Claude Code integration only: parse stdin JSON, call `mark`, exit 0. It is 29 lines and should stay that size; anything it grows belongs in the core.
- `bin/aura.js` owns argument parsing for every other caller. Adding a command here must never add a branch inside `mark.js`.
- `src/shell/` owns the prompt snippets. They are dumb on purpose: detect a changed directory, call the CLI, print what comes back, never crash the prompt.
- `src/adapters/` owns ALL OS-specific window code. Every adapter implements one interface: paint({foreground | cachedHandle, frameHex}) -> handle, or 0/null when unsupported or rejected. `-NoPaint` resolves the handle without writing a color, `-Reset` returns the frame to the system default (see Window ownership), and `-QueryTitle` prints the title of the cached handle, or of the resolved window when there is none, and writes nothing at all. `frame-win.ps1` (Win32/DWM) is the v0 adapter.
- `decide.js` owns every what-to-do rule: identity precedence, when to spawn, who paints, who owns a window. It is pure, so the rules are testable without a desktop.
- `git.js` owns the only git spawns. It reads git's OUTPUT, never its exit code: `git rev-parse --show-toplevel --abbrev-ref HEAD` exits 128 on a repo with no commits yet (unborn HEAD) while still printing a valid toplevel on stdout. Gating on the exit code made every commitless repo look like a bare folder, which after the no-repo-no-color rule meant no color at all (measured 2026-08-30 on `C:/Users/skf_s/bitfall`). A branch line of literally `HEAD` means unborn or detached: a repo, with no branch. `test/git.test.js` drives real repos created with `git init`.
- `tag.js` owns the session tag: the session key an agent's environment implies, and the read/write of `state.tags`. It also owns `inTerminalSession`, the gate that wants proof of a live terminal before `bin/aura.js` paints anything.
- `install.js` owns every file aura writes into someone else's config: `~/.claude/settings.json` and shell profiles. It must back the file up before writing (matches the user's pre-write-guard convention).

## Data Flow (shell case: a terminal cds into a repo)
1. The prompt function compares `$PWD` to the last path it marked. Same path, it returns immediately and nothing runs.
2. Changed path: it runs `aura mark --write --cwd <dir> --session shell-<pid>-<second>` and captures stdout.
3. `mark.js` resolves repo + branch, computes colors, builds the escape string, and writes it to the tty device. That device IS the visible console here, so the tint, tab color and title land now.
4. The snippet prints whatever came back on stdout, which is the fallback for a terminal where the device is not reachable. On the normal path that is empty.
5. The frame paint follows the same rules as the hook case below: spawn only when no HWND is cached or the color changed. Steady state within one repo is a directory comparison in the shell and nothing else.

## Data Flow (Claude Code case: new session starts)
1. Claude Code fires SessionStart; `hook.js` gets JSON on stdin.
2. `hook.js` resolves repo root + branch (`git -C <cwd> rev-parse`), computes colors via `color.js`.
3. It builds one escape string: OSC 11 (tint), the tab color (Windows Terminal: `OSC 4;264;rgb:RR/GG/BB` + DECAC `ESC[2;15;264,|`, gated on `WT_SESSION`; iTerm2: `OSC 6;1;bg` triple, gated on `TERM_PROGRAM`), and the title `repo · branch`. It writes it to the tty device - the visible path on POSIX. On Windows hooks run with a hidden console (see Known Risks), so visible delivery happens in step 4.
4. If no HWND is cached, the frame color changed, or the VT payload has not visibly landed for this session (`vtSent`), it spawns `frame-win.ps1` once. The adapter takes `GetForegroundWindow()` - the window the user just typed in - verifies it belongs to an allowlisted terminal process (so an alt-tab race can never paint another app), paints border + caption, prints the HWND, then resolves the topmost console ancestors. On a prompt event it attaches and writes the VT payload immediately. On SessionStart an immediate write races Claude Code's TUI init and gets wiped (measured), and a detached process cannot resolve the ancestry later (the walk only sees live processes; the hook's node parent dies first) - so the adapter hands the LIVE-resolved target PIDs to a detached hidden grandchild that sleeps ~2 s, re-checks `vtSent` in state (skip if a prompt delivered first), then attaches and writes. Colors are visible before the user types anything.
5. `hook.js` caches the HWND and `vtSent` in state.json. A rejected foreground (user was elsewhere) is retried on the next prompt. `vtSent` is only marked on prompt events, and SessionStart clears the session's cached `hwnd` + `vtSent` first (a resumed session may live in a new tab or window now), so the first prompt re-delivers once as the backstop.
6. On each further UserPromptSubmit: recompute branch (it may have changed). The DWM frame color persists on the window and `vtSent` matches, so NO PowerShell spawn happens unless a color changed - the steady-state path stays at the ~70 ms budget (the once-per-session-start resolve+paint+handover spawn costs ~2 s, measured).

## Cross-Platform Support Matrix

The core (color.js, mark.js, decide.js, tty.js, state.js) is OS-neutral, and so are both callers. Exactly three things vary per OS: the tty device path (handled inside tty.js), the frame adapter, and which shell snippet a profile sources.

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
- **MEASURED 2026-08-30 (e2e, root cause): Claude Code spawns hooks with their own HIDDEN console on Windows.** The hook's direct `CONOUT$` open + write SUCCEEDS (state recorded `tty: \\.\CONOUT$`) but lands in an invisible buffer - pixels never change. The earlier "CONOUT$ works from the process tree" spike result came from tool-spawned probes that shared the real console; hooks do not. Visible delivery on Windows is `AttachConsole()` to the TOPMOST console-attached ancestor (that ancestor owns the tab's real console; the hook's own node/cmd parents hold the hidden one; GUI ancestors like WindowsTerminal refuse attach and are skipped). This ships inside `frame-win.ps1` (`-VtB64`), riding the same once-per-color spawn as the DWM paint, so the steady-state path stays spawn-free. `session.vtSent` records delivery; it is only marked from UserPromptSubmit, so a SessionStart delivery that races Claude Code's TUI init gets one re-delivery at the first prompt. Verified live: tab + tint + border all pixel-exact (#d9266e / #2d161f) after the first prompt.
- **The direct tty write (CONOUT$ / /dev/tty) stays in the hook** - it is the visible path wherever the hook DOES share the terminal's console (expected on POSIX /dev/tty; unverified until tested on a Mac). On Windows it is harmless and the state field `tty` doubles as a diagnostic.
- **Per-prompt title updates do not work on Windows** (they would need a per-prompt attach spawn, which the budget bans). In practice Claude Code itself sets the tab title to the latest prompt text, which covers the "latest prompt floating at the top" ask natively; aura's `repo · branch` title lands at paint events and is best-effort (observed surviving on idle tabs).
- **Tabs share one frame** (DWM is per-window). Precisely: the frame keeps the color of the last session that PAINTED it - sessions repaint only on first paint or color change, so a prompt in another tab does not reclaim the frame (observed live: pink -> blue -> pink across three sessions in one window). For one-window-per-session workflows the frame is always right. Per-tab identity = tab color + tint + title. Tab color, MEASURED 2026-08-31 (screenshot-verified on WT 1.24.11911.0): `OSC 4;264;rgb:RR/GG/BB` + DECAC `ESC[2;15;264,|` sets the tab to the exact RGB. Slot choice is the whole point: DECAC needs a real palette index, and any index in 0-255 is one text can be printed in, so aura writing it would recolor somebody's output. Slot 264 is the tab-background virtual index, above that range, so text stays native. Measured on the way there: slot 200 works but is bright magenta text; slot 262 recolors the PANE BACKGROUND, not the tab (`OSC 104;262` undoes that); WT reads the slot LIVE, so set-then-restore is impossible. The basic form `ESC[2;15;1,|` (16-color red) also works. Caveat: a tab launched with `--tabColor` cannot be overridden by the escape.
- **MEASURED 2026-08-30: DWM caption color is INVISIBLE in stock Windows Terminal** - WT draws its own tab strip over the title bar, so only the 1 px border shows from the frame paint (and snapped/maximized edges hide most of it). In tabbed layouts the tab color + tint ARE the identity; the frame is a bonus for floating windows. Keep painting both DWM attributes: caption shows on conhost and any terminal with a standard title bar.
- **MEASURED 2026-08-30: the start-time foreground window is a guess.** With five terminal windows open, every session had cached the SAME HWND, because each session started while the user was still looking at another window. A session start cannot prove where it lives; the first prompt can, and it already spawns for the VT backstop. So the first prompt after a start re-resolves the handle (`reresolveWindow` in `decide.js`) and later prompts trust the cache, keeping the steady-state path spawn-free.
- **Concurrent state writers (design fix 2026-08-31).** One Claude Code session per window wrote state rarely; every open shell writing on every cd does not. Whole-file writes from a stale snapshot would silently drop other windows' entries, and a dropped entry means a lost HWND cache, which means a repaint on the wrong window. Fixed structurally: locked delta writes (see Data Model). The lock alone did not hold, though. A 24-writer race still lost an entry about once in 40 rounds until the rename, the read and the give-up path were each fixed (see Data Model for all three). After that: 200 rounds clean under a concurrent suite load. Regression tests in `test/state.test.js` run 12 concurrent `aura mark` processes, and drive each failure path directly with a fake `renameSync` and `readFileSync`.
- **A loaded box can read as "not a repo" (observed 2026-08-31).** `runGit` gives git 1500 ms, and under heavy parallel load git exceeded it. The probe then returns null, the identity falls back to the plain cwd, and that prompt gets no color. It self-corrects on the next prompt. The budget stays as it is: a longer one would stall a prompt to fix a case only a saturated machine produces.
- **MEASURED 2026-08-31: a delivery cache keyed on the color cannot see a change to the escapes.** The tab-color slot moved from 200 to 264 (see the Color Contract). The color that slot carries did not change, so `vtHex` still matched in every open session and not one of them re-sent the new escape string: state.json showed `frameHex` and `vtHex` equal for all live sessions and the adapter never spawned. The key is now `vtSent`, an FNV-1a digest of the escapes actually delivered, with the title excluded because the title moves every prompt and hashing it would spawn PowerShell on the steady-state path (rule 5). Any future change to the escape shape self-invalidates, and the old key never matches the new one, so every open session re-delivers exactly once.

- **MEASURED 2026-08-31: a tag nobody types is not an identity either.** `state.tags` fixed the home-folder case in principle and not in practice: it needs one manual `aura tag <dir>` per session, so after a day of use the live state held exactly ONE tag, set by an agent, and eight tabs still showed two colors. `GetWindowText` on the three live Windows Terminal HWNDs returned `intraday`, `aura` and `fifty` - short, stable names the user had set by renaming the tabs, not prompt text. So the tab name became the third identity source. What it costs: aura stops writing `OSC 0` for those sessions, because the title IS the identity and overwriting it would move the color; and renaming a tab changes its color, which is the honest behaviour for a name-keyed hue. What it does not cost: repos are unaffected, since git still outranks the title.

- **MEASURED 2026-08-31: an un-renamed tab reports the AGENT's title, not a name.** The three readings above came from tabs the user had renamed. `GetWindowText` on a Windows Terminal window whose active tab was NOT renamed returned `✳ Speech cron paused` - Claude Code's own title, built from the session's latest prompt. It is 20 characters, holds no `·`, no path separator, and matches no shell default, so every static guard passed it and it would have become the identity `window:✳ Speech cron paused`. That is the same feedback loop the `·` guard was written for, one writer along. The fix is the only property a name has and a status line does not: it holds still. `settleWindowName` adopts a title only when two different prompts read the same string, which costs a second spawn once per session and nothing after.
- **That settle rule alone was not enough (found 2026-08-31, after 0.1.0 shipped).** It assumes the prompt text always changes, and a user who sends the same short message twice breaks the assumption: `✳ continue` is 10 characters, holds no `·`, no path and no shell default, so two consecutive reads agree and the status line becomes the permanent identity `window:✳ continue`. Reachable only where the feature applies, in a session with no repo and no tag, which is exactly the home-folder case it was built for. Root cause: every guard tested the string's SHAPE and none tested the one character that positively marks it as an agent's output. `STATUS_MARKERS` now rejects that marker, aura's own `·` folded into the same list. The two guards are independent on purpose: the marker catches a repeated prompt, the settle catches an agent that prints no marker.

- **MEASURED 2026-08-31: the working directory is not an identity.** Six Windows Terminal tabs, six different projects, no color on any of them: every agent had been launched from `C:/Users/skf_s`, which is not a repo, so the no-repo-no-color rule painted nothing and was right to. Coloring the home folder instead would have given six identical tabs, since all six shared that one path. The fix is a second identity source (`state.tags`), not a change to the color rule. A tag also paints as it is written, measured the same day: `aura tag C:/Users/skf_s/bitfall` run from inside a Claude Code tool call turned the tab pixel to `#26D947` and the pane to `#162D1A`, both exactly what `colorsFor` computes for that repo, and tagging back restored `#2662D9` / `#161D2D`. Without that, only Claude Code could ever consume a tag, since no other agent has a prompt hook.
- **A shell prompt is a hotter path than a hook.** A hook runs once per turn; a prompt function runs on every Enter. The snippet therefore compares `$PWD` to the last marked path FIRST and spawns nothing when it matches, so the node start (~70 ms) is paid on a cd, not on every command. A cd into a different repo also spawns the adapter, which is a PowerShell start; that is the honest worst case and it is once per repo change.
- **Prompt wrapping is other people's territory.** posh-git, oh-my-posh and Starship all own `prompt`. The snippet captures the existing function and calls it, marks its own wrapper with an `aura-prompt` comment, and re-wraps only when something else has since taken the prompt. A profile re-source is therefore a no-op rather than a second wrap. `test/shell.test.js` drives a real PowerShell session with an existing prompt, sources the snippet twice, and asserts one wrap and the original prompt text.
- **Headless guard (design fix 2026-08-30, broadened same day):** the foreground handshake only runs when a known terminal marker is in the environment (`WT_SESSION`, `WEZTERM_PANE`, `ALACRITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR` - see `TERMINAL_MARKERS` in `src/decide.js`). Cron / Task Scheduler / service-spawned `claude -p` sessions carry no marker, and grabbing the foreground window there would paint an unrelated window the wrong color. The adapter's process-name allowlist is the second layer: even with a marker present, only a terminal-process foreground window is ever painted. `WT_SESSION` is measured on this box; the other markers come from each terminal's docs and are best-effort until tested live. Plain conhost sets no marker and never gets a first paint (tint + title only). Cached-HWND repaints stay allowed.
