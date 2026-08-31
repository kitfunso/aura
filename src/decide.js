"use strict";
// Pure decision core. No fs, no child processes, no Win32: hook.js owns all I/O.
// Rules and the measurements behind them: docs/ARCHITECTURE.md.
const path = require("path");

// Identity precedence: origin remote URL > repo root path > cwd.
function identityFrom({ gitCombined, remoteUrl, cwd }) {
  if (!gitCombined) {
    const normalized = path.resolve(cwd);
    return { repoId: normalized, branch: null, name: path.basename(normalized), isRepo: false, root: null };
  }
  const lines = gitCombined.split(/\r?\n/);
  const root = lines[0];
  // "HEAD" means unborn (no commits yet) or detached: a repo, with no branch.
  const branch = lines[1] && lines[1] !== "HEAD" ? lines[1] : null;
  return { repoId: remoteUrl || root, branch, name: path.basename(root), isRepo: true, root };
}

// Proof the session runs in a terminal the user launched; headless runs set none.
const TERMINAL_MARKERS = ["WT_SESSION", "WEZTERM_PANE", "ALACRITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR"];

function hasTerminalMarker(env) {
  return TERMINAL_MARKERS.some(function (name) { return Boolean(env[name]); });
}

// Tabs share one window frame, so ownership is a property of the window.
function repoSessionHwnds(sessions, exceptSessionId) {
  const hwnds = [];
  Object.keys(sessions || {}).forEach(function (id) {
    const session = sessions[id];
    if (id !== exceptSessionId && session && session.isRepo === true && session.hwnd) {
      const key = String(session.hwnd);
      if (hwnds.indexOf(key) === -1) hwnds.push(key);
    }
  });
  return hwnds;
}

function windowHasRepoSession(sessions, hwnd, exceptSessionId) {
  if (!hwnd) return false;
  return repoSessionHwnds(sessions, exceptSessionId).indexOf(String(hwnd)) !== -1;
}

function decideEvent({ eventName, platform, session, frameHex, vtSignature, isRepo, windowFrameCleared }) {
  // "prompt" is the shell caller's name for the same thing: the window is
  // already up, so there is no TUI init race to wait out.
  const isPrompt = eventName === "UserPromptSubmit" || eventName === "prompt";
  // A session start may land in a new tab or window, so it re-handshakes.
  const clearHandshake = !isPrompt;
  const cachedVtSent = clearHandshake ? undefined : session.vtSent;
  const needsVtDelivery = platform === "win32" && cachedVtSent !== vtSignature;
  // The start-time window is a guess (the user may be looking elsewhere); the
  // first prompt proves which window is theirs, and already spawns for VT.
  const reresolveWindow = isPrompt && needsVtDelivery;
  const cachedHwnd = (clearHandshake || reresolveWindow) ? null : session.hwnd || null;
  // A bare shell in the window may have cleared the color this session owns.
  const reclaimFrame = isRepo && Boolean(windowFrameCleared);
  // Off-repo the frame is reset once, so a window aura colored earlier goes back.
  const needsReset = !isRepo && !(clearHandshake ? false : session.frameCleared);
  const needsFrame = !cachedHwnd || session.frameHex !== frameHex || reclaimFrame || needsReset;
  return {
    isPrompt,
    clearHandshake,
    cachedHwnd,
    spawnAdapter: needsFrame || needsVtDelivery,
    // An immediate start-time write races Claude Code's TUI init and is wiped.
    vtDelayMs: isPrompt ? 0 : 2000,
    markVtSent: isPrompt && needsVtDelivery,
    // No repo, no color: the window keeps the terminal's own default.
    paintsFrame: isRepo,
    resetFrame: !isRepo,
    usesColor: isRepo,
  };
}

module.exports = {
  identityFrom, decideEvent, hasTerminalMarker, windowHasRepoSession, repoSessionHwnds,
};
