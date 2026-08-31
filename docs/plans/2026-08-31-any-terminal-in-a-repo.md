# Any terminal in a repo gets a color

**Goal:** colour is driven by the shell, not by one agent, so Claude Code, Codex, Pi, Aider, opencode and a plain git shell all get it from one implementation.
**Prerequisites:** aura master @ baf8659, tests 33/33 green.
**Estimated scope:** 6 steps.

## Framing

Problem: only Claude Code windows get a colour.

Root cause: aura's entry point *is* the Claude Code hook. Identity resolution, colour maths and escape delivery are welded to one agent's event format (`src/hook.js:92-164` reads a hook JSON off stdin and does everything inline).

Fix: make the entry point agent-neutral. One `aura mark` command does the work. Whoever knows the working directory changed calls it. The shell knows that on every prompt, for every agent, so no agent needs its own integration.

At root or downstream: **root**. The hook becomes one caller among several instead of the only path.

Accepted consequence (user's call): a plain shell tab sitting in a repo is coloured too. Colour means "this window is in this repo", not "an agent is working here".

## What a coloured window means, before and after

| | before | after |
|---|---|---|
| Claude Code in a repo | coloured | coloured |
| Codex / Pi / Aider / opencode in a repo | no colour | coloured |
| plain shell in a repo | no colour | coloured |
| anything outside a repo | no colour | no colour |

## Design

### One core, three sinks

`src/mark.js` holds the operation. Three callers, differing only in where the escapes go:

| caller | escape sink | why |
|---|---|---|
| `src/hook.js` (Claude Code) | tty device via `src/tty.js`, then the adapter re-delivers | rule 3: hook stdout is captured as model context |
| `bin/aura.js mark` (shell) | stdout, the shell writes it | the shell's console is visible, so no adapter hop is needed |
| adapter `-VtB64` | the tab's real console | unchanged |

### Event mapping

The shell always sends prompt semantics. `decide.js` is the locked pure core and does **not** change.

A shell prompt has no TUI init race, so the 2000 ms delayed write that `SessionStart` needs would be pure latency. `isPrompt = true` gives `vtDelayMs: 0`, `cachedHwnd` reuse and `markVtHex`, which is exactly right for a shell.

### Session identity

`shell-<pid>`. Stable for the life of that shell, dies with it, pruned by the existing 48 h sweep.

### Cost on the prompt path

The snippet compares `$PWD` against the last value it marked and returns immediately when they match. So:

| action | cost |
|---|---|
| any prompt in the same directory | one string compare, no spawn |
| `cd` inside the same repo | node start + one git spawn, no PowerShell |
| `cd` to a different repo | the above plus one adapter spawn |

## Steps

### Step 1: extract the core
**Files:** `src/mark.js` (new), `src/hook.js`
**What:** move `buildEscapes`, `sanitizeForTitle`, `paintFrame` and the body of `main()` into `mark({ cwd, sessionId, eventName, promptText, env })`. It returns `{ identity, colors, escapes, hwnd }` and never writes to stdout. `hook.js` becomes a stdin parser that calls it and sends the escapes to the tty.
**Verify:** `npm test` still 33/33; no behaviour change for Claude Code.
**Commit:** `refactor: one mark core, hook.js becomes a caller`

### Step 2: the CLI
**Files:** `bin/aura.js` (new), `package.json`
**What:** `aura mark [--cwd] [--session] [--title]` prints the escapes on stdout. Register `bin.aura`.
**Verify:** new `test/cli.test.js`: mark in a real repo prints an OSC 11 with the right tint; mark outside a repo prints a title only.
**Commit:** `feat: aura mark, the agent neutral entry point`

*Amended during execution:* `shell-init` moved to step 3. It serves a file that step 3 creates, so shipping it here would mean one commit with a subcommand that cannot work.

### Step 3: the shell snippets
**Files:** `src/shell/powershell.ps1`, `src/shell/posix.sh`, `bin/aura.js`
**What:** wrap the existing prompt, skip when `$PWD` is unchanged, write what `aura mark` printed. Never break the user's prompt if aura fails. `aura shell-init [--shell powershell|bash|zsh]` prints the matching snippet.
**Verify:** live in a real terminal, `cd` between two repos and watch the colour change.
**Commit:** `feat: shell prompt integration for powershell, bash and zsh`

### Step 4: installer support
**Files:** `bin/install.js`
**What:** `--shell` appends a marked block to the profile, `--uninstall` removes exactly that block. Back up first, same contract as the settings.json path.
**Verify:** extend `test/install.test.js`: append is idempotent, uninstall leaves the rest of the profile byte-identical.
**Commit:** `feat: installer wires the shell prompt`

### Step 5: docs
**Files:** `README.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`
**What:** the product is no longer Claude-Code-only. Record the one-core-three-sinks boundary and why the shell path skips the adapter for escapes.
**Commit:** `docs: colour follows the shell, not the agent`

### Step 6: live check
**What:** plain PowerShell in a repo, then Claude Code in the same window, then a non-repo folder. Confirm colour appears, survives, and clears.

## Risks

1. **Two writers per window.** A shell tab and a Claude Code tab in the same window both mark. They agree on colour for the same repo, so only the frame (a window-level property) can disagree. The existing `frameOwner` HWND map already arbitrates this.
2. **Prompt-function collisions.** posh-git, oh-my-posh and Starship all replace `prompt`. Capturing the previous function and calling it is the only safe shape; Starship overwrites on every init, so document that aura's line must come after it.
3. **Latency.** ~70 ms on a directory change. Only paid on `cd`.
4. **A shell that never prints a prompt** (a script, a CI job) never marks. That is correct, not a gap.
