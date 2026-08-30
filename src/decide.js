"use strict";
// Pure decision core: identity precedence and the per-event action plan,
// computed from injected inputs only. No fs, no child processes, no Win32 -
// hook.js owns all I/O and feeds results in; Lane B lifts this unchanged
// (rule 2 applies here exactly as it does to color.js).
const path = require("path");

// Identity precedence: origin remote URL > repo root path > cwd.
// gitCombined is the raw `git rev-parse --show-toplevel --abbrev-ref HEAD`
// output (root on line 1, branch on line 2), or null outside any repo.
function identityFrom({ gitCombined, remoteUrl, cwd }) {
  if (!gitCombined) {
    const normalized = path.resolve(cwd);
    return { repoId: normalized, branch: null, name: path.basename(normalized), isRepo: false };
  }
  const lines = gitCombined.split(/\r?\n/);
  const root = lines[0];
  const branch = lines[1] || null;
  return { repoId: remoteUrl || root, branch, name: path.basename(root), isRepo: true };
}

// Proof the session lives in a terminal the user launched: each supported
// terminal injects its own marker variable into child processes, and headless
// runs (cron, Task Scheduler, service-spawned `claude -p`) carry none.
// WT_SESSION is measured on this box; the other three come from each
// terminal's docs (wezterm sets WEZTERM_PANE in spawned programs, alacritty
// lists ALACRITTY_WINDOW_ID as a default variable, ghostty injects
// GHOSTTY_RESOURCES_DIR) and are best-effort - the frame adapter's
// process-name allowlist still filters the foreground window either way.
// Plain conhost sets no marker: it never gets a first paint.
const TERMINAL_MARKERS = ["WT_SESSION", "WEZTERM_PANE", "ALACRITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR"];

function hasTerminalMarker(env) {
  return TERMINAL_MARKERS.some(function (name) { return Boolean(env[name]); });
}

// Tabs share one window, so frame ownership is a property of the WINDOW, not
// of whichever tab wrote last. Without this, a single session started outside
// any repo (a shell in the home directory) claimed the whole window as
// "rainbow" and suppressed the repo color of every sibling tab - and because
// Lane B skips rainbow-owned windows, the only ringed windows on screen were
// the palette's (measured 2026-08-30: 7 sessions, all on hwnd 853852, one
// rainbow claim, zero rings on the terminal).
function windowHasRepoSession(sessions, hwnd, exceptSessionId) {
  if (!hwnd) return false;
  const key = String(hwnd);
  return Object.keys(sessions || {}).some(function (id) {
    const session = sessions[id];
    return id !== exceptSessionId && session && session.isRepo === true &&
      String(session.hwnd) === key;
  });
}

// What the hook should do for one event.
// - SessionStart (open, resume, clear) may land the session in a brand-new
//   tab or window: the cached handle and delivery mark are dropped so the
//   session re-handshakes and re-delivers where it lives NOW.
// - vtHex only marks from prompt events. An immediate SessionStart write
//   races Claude Code's TUI init and gets wiped (measured 2026-08-30), so
//   session-start delivery goes through the delayed writer and the first
//   prompt re-delivers once as the backstop, then never again.
// - Non-repo windows route to the rainbow loop; repo paints own the frame.
function decideEvent({ eventName, platform, session, frameHex, isRepo, windowRainbowOwned }) {
  const isPrompt = eventName === "UserPromptSubmit";
  const clearHandshake = !isPrompt;
  const cachedHwnd = clearHandshake ? null : session.hwnd || null;
  const cachedVtHex = clearHandshake ? undefined : session.vtHex;
  // A repo session whose window is still rainbow-owned must repaint once to
  // take the frame back: the hue-cycle loop holds it until a repo paint lands,
  // and the DWM color on the window is being rewritten every cycle.
  const reclaimFrame = isRepo && Boolean(windowRainbowOwned);
  const needsFrame = !cachedHwnd || session.frameHex !== frameHex || reclaimFrame;
  const needsVt = platform === "win32" && cachedVtHex !== frameHex;
  return {
    isPrompt,
    clearHandshake,
    cachedHwnd,
    spawnAdapter: needsFrame || needsVt,
    vtDelayMs: isPrompt ? 0 : 2000,
    markVtHex: isPrompt && needsVt,
    wantsRainbow: platform === "win32" && !isRepo,
    // Who writes the DWM frame color: repo sessions only. A non-repo window is
    // painted by the hue-cycle loop, which repaints every tick and stands down
    // as soon as a repo session owns the window, so a direct paint here is
    // redundant when the session is alone in its window and destructive when it
    // shares one - a bare shell would overwrite its repo sibling's color, and
    // the sibling's steady state never repaints to put it back. Deciding this
    // from isRepo alone keeps it independent of the HWND, which matters because
    // the paint call IS how the HWND gets resolved in the first place.
    paintsFrame: isRepo,
  };
}

module.exports = { identityFrom, decideEvent, hasTerminalMarker, windowHasRepoSession };
