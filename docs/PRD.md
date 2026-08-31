# aura - Product Requirements Document

## One-Line Description
aura gives every terminal window sitting in a git repo a color identity (repo = hue, branch = shade) and puts the latest prompt in the window title, so you can tell 10+ windows apart at a glance, whatever is running inside them.

## Problem Statement
Working with many agent sessions at once is an unsolved UX problem. With more than ~4 terminal windows open, every window looks identical and the window title is useless. The user loses track of which window is which repo, which branch, and what they last asked it to do. The problem is not specific to one agent: a desk runs Claude Code, Codex, Aider, opencode and plain git shells side by side, and a per-agent fix leaves most windows gray. Existing tools (Slack, Devin, Conductor, Warp) have not solved this either.

## Target Users
- Primary: Keith - runs 10+ concurrent Claude Code CLI sessions on Windows 11 + Windows Terminal, across many repos and branches. Expert user, owns his own `~/.claude` hook config.
- Secondary (post-MVP): any Claude Code power user on Windows 11. The npm package must install with one command and zero manual config.

## Core Features (MVP)
1. **Repo color identity.** Deterministic mapping: repo identity -> hue. Same repo always gets the same color, in every window, across restarts. Outside a git repo, the working folder is the identity instead, so every window still gets a color; branch shades only exist inside repos.
2. **Branch shades.** Same repo on different branches gets distinguishable shades of that repo's hue. main/master is the base shade.
3. **Background tint.** The terminal background is tinted with a dark version of the repo color (OSC 11). Works in windows AND tabs.
   **Tab color.** The tab header itself is painted with the repo color, so tabs in one window are tellable apart from the tab strip alone. Verified live 2026-08-30 on Windows Terminal (DECAC + `OSC 4` slot 200 for exact RGB; screenshot evidence); iTerm2 uses its `OSC 6;1;bg` escapes. Emitted per prompt from the same hook, gated on terminal detection (`WT_SESSION` / `TERM_PROGRAM`). Caveat: a tab launched with `--tabColor` on its command line cannot be overridden. In tabbed windows this is the PRIMARY identity surface: WT covers the title bar with its own tab strip, so the DWM caption color never shows there.
4. **Real window frame color.** The OS window border + title bar are painted with the repo color, via a per-OS frame adapter. v0 ships the Windows 11 adapter (DWM API). Works when each session has its own window.
5. **Latest prompt in the title.** Window title shows `repo · branch · <first ~60 chars of the latest prompt>`. On Windows this is best-effort at paint events only (hooks cannot reach the visible console per prompt without a spawn), and Claude Code itself already sets the tab title to the latest prompt text, which delivers the "latest prompt floating at the top" outcome natively; aura adds the `repo · branch` identity part. Per-prompt title updates from aura are a POSIX-path feature.
6. **One-command install.** `npx @kitfunso/aura install --shell <name>` writes the prompt snippet into the shell profile; `npx @kitfunso/aura install` registers the Claude Code hooks in `~/.claude/settings.json`. Both merge + back up and never overwrite, and `uninstall` takes back out exactly what was put in.
7. **Any terminal in a repo, not just an agent's.** The shell reports its own directory on every prompt (`aura mark`), so a window gets its color whatever runs inside it: Claude Code, Codex, Aider, opencode, or a bare git shell. One core (`src/mark.js`), three callers: the shell prompt, the Claude Code hook (kept because it can color a session at startup, before the first prompt), and any script that knows a window's directory changed.
8. **A second identity source, for a session the folder cannot name.** `aura tag <dir>` pins one session to a repo, and the pin outranks the working directory on every later mark. The key comes from the agent's own environment (`CLAUDE_CODE_SESSION_ID`, or `AURA_SESSION`, which the shell snippets export to every process the window starts), so an agent can name its own project from inside itself. Tags are pruned with their session. Added 2026-08-31 after six tabs on six projects all came up gray: every agent had been launched from a home folder, which carries no project at all.

## What This Product IS NOT
1. **NOT a fork or patch of Claude Code.** Hooks + OS APIs only. If a feature needs Claude Code internals, it is out of scope.
2. **NOT Windows-locked, and NOT blocked on other OSes either.** The core (color contract, tint, title, hook, tty) is OS-neutral by design and must never take a Windows-only dependency. Frame painting is a per-OS adapter: Windows 11 ships in v0; macOS/Linux adapters follow. v0 ships when Windows works.
3. **NOT the cross-app overlay.** Coloring Slack/Devin/browser/other-agent windows is Lane B (a separate overlay app). The MVP only defines the color contract Lane B will reuse.
4. **NOT a session manager or dashboard.** No session list, no switching UI, no task board. aura identifies windows; it does not manage them.
5. **NOT a per-tab FRAME.** The OS window frame (DWM border + title bar) is per-window by OS design; tabs in one window share it, and it shows the color of the session you most recently typed in. Per-tab identity comes from tab color + tint + title, not the frame.
6. **NOT a statusline replacement.** claude-hud stays. A statusline integration (show latest prompt at the bottom) is a possible later add-on, not MVP.
7. **NOT a telemetry product.** Local only. No network calls, no analytics, nothing leaves the machine.
8. **NOT an identity for windows with no project.** A session outside a git repo gets no color at all: no tint, no tab color, no frame. The window keeps the terminal's own default, which is what "no project" should look like. A hue-cycling frame shipped for this case on 2026-08-30 and was removed the same day: color means a repo, so coloring "no repo" made every window look assigned.
9. **NOT an agent detector.** Color means "this window is in this repo", never "an agent is working here". A plain shell in a repo is colored like any other window there. Decided 2026-08-31: detecting which agent owns a window needs a per-agent integration each, and the directory is the thing every one of them already agrees on.

## Post-MVP Candidates (recorded, not in scope for v0)
- macOS adapters (tint + title + iTerm2 tab color run from the same core already; frame overlay needs a Mac).
- Statusline integration (latest prompt at the bottom via claude-hud).
- Lane B: the cross-app overlay for Slack/Devin/browser/other-agent windows.

## Success Metrics
- With 10 windows open, the user finds the right window in under 2 seconds (today: scan-and-guess).
- Zero wrong-window incidents (typing into the wrong repo's session) over one week of real use.
- Install to working color in under 2 minutes via one npx command.
- Steady-state overhead ~70 ms per prompt, hook or shell (node startup dominates, so the original 50 ms bar is not reachable with a node entry point). aura must never make a turn or a prompt feel slower.
- Color stability: the same repo maps to the same hue on every launch (deterministic, testable).

## Constraints
- Solo developer, target ~1 day for MVP.
- Windows 11 build 22000+ required for frame color (DWM border/caption attributes). Tint + title degrade gracefully on anything older.
- macOS has no API to recolor another app's window frame; the macOS frame adapter is an overlay window (the Lane B technique) and needs a Mac to build and test. Until then, macOS gets tint + title + iTerm2 tab color from the same core code, unchanged.
- No compiled binary shipped in v0: the frame painter is PowerShell P/Invoke, so the package stays plain JS + ps1.
- npm name "aura" is almost certainly taken; publish (if ever) under a scoped name (e.g. `@kitfunso/aura`). Not an MVP concern.
- Pricing: none. Free/personal tool; open-sourceable later with Lane B.
