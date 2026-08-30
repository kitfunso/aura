"use strict";
// aura Lane B spike: map every visible window to a color identity through
// src/color.js UNCHANGED. Two identity sources, in order:
//   1. state: the window is a terminal aura has handshook (hwnd appears in
//      state.json); the newest session on that hwnd wins, exactly like the
//      live last-writer-wins paint. Identity = that session's repoId/branch.
//   2. process: any other window falls back to its process name as repoId
//      (branch null), so Chrome is always Chrome-colored on every machine.
// Run: node spike/detect.js  (prints a JSON report to stdout)
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { colorsFor } = require("../src/color.js");

const TERMINAL_PROCESSES = new Set([
  "WindowsTerminal", "OpenConsole", "conhost", "wezterm-gui", "alacritty", "ghostty",
]);

function scanWindows() {
  const script = path.join(__dirname, "detect-win.ps1");
  const out = execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
  ], { timeout: 30000, windowsHide: true }).toString();
  return JSON.parse(out);
}

function loadState() {
  const file = path.join(process.env.LOCALAPPDATA || "", "aura", "state.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { sessions: {} };
  }
}

function newestSessionForHwnd(state, hwnd) {
  let best = null;
  for (const id of Object.keys(state.sessions || {})) {
    const s = state.sessions[id];
    if (s.hwnd !== hwnd) continue;
    if (!best || String(s.updatedAt) > String(best.updatedAt)) best = s;
  }
  return best;
}

function identify(win, state) {
  if (TERMINAL_PROCESSES.has(win.process)) {
    const session = newestSessionForHwnd(state, win.hwnd);
    if (session) {
      return { source: "state", repoId: session.repoId, branch: session.branch };
    }
  }
  return { source: "process", repoId: win.process.toLowerCase(), branch: null };
}

function main() {
  const state = loadState();
  const report = scanWindows().map(function (win) {
    const identity = identify(win, state);
    const colors = colorsFor(identity);
    return {
      hwnd: win.hwnd,
      process: win.process,
      source: identity.source,
      repoId: identity.repoId,
      branch: identity.branch,
      frameHex: colors.frameHex,
      rainbowOwned: !!(state.frameOwner && state.frameOwner[String(win.hwnd)] === "rainbow"),
    };
  });
  console.log(JSON.stringify(report, null, 2));
}

main();
