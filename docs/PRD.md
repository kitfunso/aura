# aura - Product Requirements Document

## One-Line Description
aura gives every Claude Code terminal window a color identity (repo = hue, branch = shade) and puts the latest prompt in the window title, so you can tell 10+ agent sessions apart at a glance.

## Problem Statement
Working with many agent sessions at once is an unsolved UX problem. With more than ~4 Claude Code windows open, every window looks identical and the window title is useless. The user loses track of which window is which repo, which branch, and what they last asked it to do. Existing tools (Slack, Devin, Conductor, Warp) have not solved this either.

## Target Users
- Primary: Keith - runs 10+ concurrent Claude Code CLI sessions on Windows 11 + Windows Terminal, across many repos and branches. Expert user, owns his own `~/.claude` hook config.
- Secondary (post-MVP): any Claude Code power user on Windows 11. The npm package must install with one command and zero manual config.

## Core Features (MVP)
1. **Repo color identity.** Deterministic mapping: repo identity -> hue. Same repo always gets the same color, in every window, across restarts. Outside a git repo, the working folder is the identity instead, so every window still gets a color; branch shades only exist inside repos.
2. **Branch shades.** Same repo on different branches gets distinguishable shades of that repo's hue. main/master is the base shade.
3. **Background tint.** The terminal background is tinted with a dark version of the repo color (OSC 11). Works in windows AND tabs.
   **Tab color.** The tab header itself is painted with the repo color, so tabs in one window are tellable apart from the tab strip alone. Windows Terminal supports this since v1.15 via the DECAC escape (`ESC[2;<fg>;<bg>,|` plus an `OSC 4` palette redefinition for exact RGB); iTerm2 via its `OSC 6;1;bg` escapes. Emitted per prompt from the same hook, gated on terminal detection (`WT_SESSION` / `TERM_PROGRAM`). Caveat: a tab launched with `--tabColor` on its command line cannot be overridden.
4. **Real window frame color.** The OS window border + title bar are painted with the repo color, via a per-OS frame adapter. v0 ships the Windows 11 adapter (DWM API). Works when each session has its own window.
5. **Latest prompt in the title.** Window title shows `repo · branch · <first ~60 chars of the latest prompt>`, updated on every prompt. The title bar is the always-visible "what am I working on here" line.
6. **One-command install.** `npx` installer registers the hooks in `~/.claude/settings.json` (merge + backup, never overwrite).

## What This Product IS NOT
1. **NOT a fork or patch of Claude Code.** Hooks + OS APIs only. If a feature needs Claude Code internals, it is out of scope.
2. **NOT Windows-locked, and NOT blocked on other OSes either.** The core (color contract, tint, title, hook, tty) is OS-neutral by design and must never take a Windows-only dependency. Frame painting is a per-OS adapter: Windows 11 ships in v0; macOS/Linux adapters follow. v0 ships when Windows works.
3. **NOT the cross-app overlay.** Coloring Slack/Devin/browser/other-agent windows is Lane B (a separate overlay app). The MVP only defines the color contract Lane B will reuse.
4. **NOT a session manager or dashboard.** No session list, no switching UI, no task board. aura identifies windows; it does not manage them.
5. **NOT a per-tab FRAME.** The OS window frame (DWM border + title bar) is per-window by OS design; tabs in one window share it, and it shows the color of the session you most recently typed in. Per-tab identity comes from tab color + tint + title, not the frame.
6. **NOT a statusline replacement.** claude-hud stays. A statusline integration (show latest prompt at the bottom) is a possible later add-on, not MVP.
7. **NOT a telemetry product.** Local only. No network calls, no analytics, nothing leaves the machine.

## Post-MVP Candidates (recorded, not in scope for v0)
- **Rainbow frame for non-repo windows.** The DWM border is one uniform color, so "running around the frame" is not possible with it; a slow hue-CYCLE (whole frame drifts through the rainbow, repaint every ~2 s via a lightweight timer) is possible and makes "no project assigned" unmistakable. A true chasing rainbow gradient needs the Lane B overlay renderer. Phase 2 decision.
- macOS adapters (tint + title + iTerm2 tab color run from the same core already; frame overlay needs a Mac).
- Statusline integration (latest prompt at the bottom via claude-hud).
- Lane B: the cross-app overlay for Slack/Devin/browser/other-agent windows.

## Success Metrics
- With 10 windows open, the user finds the right window in under 2 seconds (today: scan-and-guess).
- Zero wrong-window incidents (typing into the wrong repo's session) over one week of real use.
- Install to working color in under 2 minutes via one npx command.
- Hook overhead under 50 ms per prompt (aura must never make a turn feel slower).
- Color stability: the same repo maps to the same hue on every launch (deterministic, testable).

## Constraints
- Solo developer, target ~1 day for MVP.
- Windows 11 build 22000+ required for frame color (DWM border/caption attributes). Tint + title degrade gracefully on anything older.
- macOS has no API to recolor another app's window frame; the macOS frame adapter is an overlay window (the Lane B technique) and needs a Mac to build and test. Until then, macOS gets tint + title + iTerm2 tab color from the same core code, unchanged.
- No compiled binary shipped in v0: the frame painter is PowerShell P/Invoke, so the package stays plain JS + ps1.
- npm name "aura" is almost certainly taken; publish (if ever) under a scoped name (e.g. `@kitfunso/aura`). Not an MVP concern.
- Pricing: none. Free/personal tool; open-sourceable later with Lane B.
