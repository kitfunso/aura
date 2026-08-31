"use strict";
// Pure decision core. No fs, no child processes, no Win32: hook.js owns all I/O.
// Rules and the measurements behind them: docs/ARCHITECTURE.md.
const path = require("path");

// A tab the user named is an identity; a title an agent or a shell wrote is not,
// and reading one of those back would feed the color its own output.
const MAX_WINDOW_NAME = 40;
// Every terminal ships these, so they name a shell, never a project.
const DEFAULT_TITLES = [
  "windows powershell", "powershell", "pwsh", "command prompt", "cmd", "cmd.exe",
  "windows terminal", "git bash", "bash", "sh", "zsh", "node", "ubuntu", "wsl",
];

function usableWindowTitle(raw) {
  const name = String(raw == null ? "" : raw).replace(/[\u0000-\u001f]+/g, " ").trim();
  if (!name || name.length > MAX_WINDOW_NAME || name.indexOf("\u00b7") !== -1) return null;
  // A separator or a drive colon means a shell wrote the path in; a name has neither.
  if (name.indexOf("/") !== -1 || name.indexOf(":") !== -1) return null;
  return DEFAULT_TITLES.indexOf(name.toLowerCase()) === -1 ? name : null;
}

// Identity precedence: origin remote URL > repo root path > window title > cwd.
// isRepo stays literal; hasColor is the question every caller actually asks.
function identityFrom({ gitCombined, remoteUrl, cwd, windowTitle }) {
  if (!gitCombined) {
    const named = usableWindowTitle(windowTitle);
    // Namespaced so a tab called "aura" cannot land on the aura repo's color.
    if (named) {
      return { repoId: "window:" + named, branch: null, name: named, isRepo: false, hasColor: true, fromWindowTitle: true, root: null };
    }
    const normalized = path.resolve(cwd);
    return { repoId: normalized, branch: null, name: path.basename(normalized), isRepo: false, hasColor: false, fromWindowTitle: false, root: null };
  }
  const lines = gitCombined.split(/\r?\n/);
  const root = lines[0];
  // "HEAD" means unborn (no commits yet) or detached: a repo, with no branch.
  const branch = lines[1] && lines[1] !== "HEAD" ? lines[1] : null;
  return { repoId: remoteUrl || root, branch, name: path.basename(root), isRepo: true, hasColor: true, fromWindowTitle: false, root };
}

// A name holds still; an agent's title follows the prompt. So a title becomes an
// identity only once two prompts have read it the same.
function settleWindowName(probe, found) {
  if (found && probe === undefined) return { probe: found, name: null };
  return { probe: null, name: found && found === probe ? found : "" };
}

// "prompt" is the shell caller's name for the same thing: the window is already
// up, so there is no TUI init race to wait out.
function isPromptEvent(eventName) {
  return eventName === "UserPromptSubmit" || eventName === "prompt";
}

// Proof the session runs in a terminal the user launched; headless runs set none.
const TERMINAL_MARKERS = ["WT_SESSION", "WEZTERM_PANE", "ALACRITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR"];

function hasTerminalMarker(env) {
  return TERMINAL_MARKERS.some(function (name) { return Boolean(env[name]); });
}

// Tabs share one window frame, so ownership is a property of the window.
function coloredSessionHwnds(sessions, exceptSessionId) {
  const hwnds = [];
  Object.keys(sessions || {}).forEach(function (id) {
    const session = sessions[id];
    if (id !== exceptSessionId && session && session.hasColor === true && session.hwnd) {
      const key = String(session.hwnd);
      if (hwnds.indexOf(key) === -1) hwnds.push(key);
    }
  });
  return hwnds;
}

function windowHasColoredSession(sessions, hwnd, exceptSessionId) {
  if (!hwnd) return false;
  return coloredSessionHwnds(sessions, exceptSessionId).indexOf(String(hwnd)) !== -1;
}

function decideEvent({ eventName, platform, session, frameHex, vtSignature, hasColor, windowFrameCleared }) {
  const isPrompt = isPromptEvent(eventName);
  // A session start may land in a new tab or window, so it re-handshakes.
  const clearHandshake = !isPrompt;
  const cachedVtSent = clearHandshake ? undefined : session.vtSent;
  const needsVtDelivery = platform === "win32" && cachedVtSent !== vtSignature;
  // The start-time window is a guess (the user may be looking elsewhere); the
  // first prompt proves which window is theirs, and already spawns for VT.
  const reresolveWindow = isPrompt && needsVtDelivery;
  const cachedHwnd = (clearHandshake || reresolveWindow) ? null : session.hwnd || null;
  // A bare shell in the window may have cleared the color this session owns.
  const reclaimFrame = hasColor && Boolean(windowFrameCleared);
  // With no identity the frame resets once, so a window aura colored earlier goes back.
  const needsReset = !hasColor && !(clearHandshake ? false : session.frameCleared);
  const needsFrame = !cachedHwnd || session.frameHex !== frameHex || reclaimFrame || needsReset;
  return {
    isPrompt,
    clearHandshake,
    cachedHwnd,
    spawnAdapter: needsFrame || needsVtDelivery,
    // An immediate start-time write races Claude Code's TUI init and is wiped.
    vtDelayMs: isPrompt ? 0 : 2000,
    markVtSent: isPrompt && needsVtDelivery,
    // No repo and no tab name: the window keeps the terminal's own default.
    paintsFrame: hasColor,
    resetFrame: !hasColor,
    usesColor: hasColor,
  };
}

module.exports = {
  identityFrom, usableWindowTitle, settleWindowName, isPromptEvent, decideEvent,
  hasTerminalMarker, windowHasColoredSession, coloredSessionHwnds,
};
