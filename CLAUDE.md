# CLAUDE.md - aura

## Project Overview
aura color-codes Claude Code terminal windows on Windows 11: repo = hue, branch = shade, latest prompt in the window title. It is hooks + OS APIs only. Docs: `docs/PRD.md` (scope), `docs/ARCHITECTURE.md` (design).

## Architecture
Four parts with hard boundaries: `src/color.js` (pure color math - THE contract Lane B inherits), `src/hook.js` (Claude Code hook integration), `src/tty.js` (terminal device access, per-OS paths), `src/adapters/` (ALL OS-specific window code; `frame-win.ps1` in v0). See ARCHITECTURE.md before touching any of them.

## Non-Negotiable Rules
1. **Never fork, patch, or wrap the Claude Code binary.** Hooks and OS APIs only. Why: survives every Claude Code update.
2. **`color.js` stays pure and dependency-free.** No I/O, no Win32, no requires beyond node builtins. Why: Lane B (cross-app overlay) must be able to lift it unchanged.
3. **Hook escapes go to the tty device via `src/tty.js` (`CONOUT$` on Windows, `/dev/tty` on POSIX), never stdout.** Why: Claude Code captures hook stdout as model context; escapes on stdout would pollute the session instead of reaching the terminal.
4. **The installer merges `~/.claude/settings.json` and backs it up first. It never overwrites.** Why: that file carries the user's whole hook/permission config; destroying it is the worst failure this tool can have.
5. **Hook runtime budget: keep the steady-state path at ~70 ms (measured median on this box; node startup ~60 ms dominates, so 50 ms is not reachable with a node hook).** Concretely: no network calls, no npm runtime dependencies, at most ONE git spawn, and no PowerShell spawn on the steady path (the DWM color persists; repaint only on color change or missing HWND - the one-time first paint costs ~500 ms). Why: aura must never make a Claude Code turn feel slower.
6. **Fail silent, degrade gracefully.** A hook that throws must still `exit 0`. Why: a broken aura must never block a prompt or break a session.
7. **Color mapping changes are breaking changes.** Update PRD + ARCHITECTURE first, and keep determinism tests green. Why: stable colors ARE the product.
8. **OS-specific code lives ONLY in `src/adapters/` and inside `src/tty.js`.** The core must run unchanged on macOS and Linux. A missing adapter degrades to tint + title, it never errors. Why: cross-platform is a core requirement, not a port.

## Coding Conventions
- Plain Node.js, zero runtime dependencies, `node --test` for tests.
- Small files, verb_noun function names, no abbreviations.
- PowerShell 5.1-compatible syntax in `frame.ps1` (no `&&`, no ternary).
- No em dashes in UI strings or commit messages.

## Critical Files
- `src/color.js` - read the Color Contract section of ARCHITECTURE.md before editing.
- `bin/install.js` - read Non-Negotiable rule 4 before editing.
- `~/.claude/settings.json` (user machine) - never edited by hand in this repo; only via the installer.

## Safety Rules
- Everything is local. No network I/O anywhere in this codebase.
- Never log prompt text anywhere except the local state file (`%LOCALAPPDATA%/aura/state.json`); prompts can contain sensitive content.
- Win32 calls are read-only except `DwmSetWindowAttribute` on the one HWND we handshook. Never enumerate-and-modify other windows.

## Common Mistakes to Avoid
- Writing escapes to stdout in a hook (see rule 3) - it silently does nothing visible and injects garbage context.
- Identifying the window by PID ancestry (WT runs many windows in ONE process - measured) or by nonce title (Claude Code re-asserts the title faster than the window can be found - measured 2026-08-30). Use GetForegroundWindow at prompt time with the terminal-process allowlist.
- Assuming the title we set persists - Claude Code rewrites the terminal title continuously (confirmed); title is re-asserted per prompt and is best-effort.
- Spawning PowerShell on the per-prompt path - the DWM frame color persists on the window; repaint only when the color changed or no HWND is cached.
