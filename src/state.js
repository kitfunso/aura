"use strict";
// Local session state: HWND cache + latest prompt, keyed by Claude session id.
// One small JSON file, rewritten atomically (temp + rename).
const fs = require("fs");
const os = require("os");
const path = require("path");

const STALE_MS = 48 * 60 * 60 * 1000;

function stateDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "aura");
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "aura");
}

function stateFile() {
  return path.join(stateDir(), "state.json");
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.sessions) return parsed;
  } catch (err) {
    // missing or corrupt file: start fresh
  }
  return { sessions: {} };
}

function writeState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, file);
}

// Signal 0 = existence probe, no signal delivered. EPERM means the process
// exists but is not ours - still alive.
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function pruneStale(state, now = Date.now()) {
  for (const [id, session] of Object.entries(state.sessions)) {
    const updated = Date.parse(session.updatedAt || "");
    if (!Number.isFinite(updated) || now - updated > STALE_MS) {
      delete state.sessions[id];
    }
  }
  // Rainbow loops that died (window closed, 12 h cap) leave their pid behind;
  // drop those, then drop frame owners for windows no live session or loop
  // still tracks. Order matters: a loop's hwnd counts as tracked only while
  // its pid is alive.
  const trackedHwnds = new Set();
  for (const session of Object.values(state.sessions)) {
    if (session.hwnd) trackedHwnds.add(String(session.hwnd));
  }
  for (const [hwnd, pid] of Object.entries(state.rainbowPid || {})) {
    if (isProcessAlive(pid)) {
      trackedHwnds.add(hwnd);
    } else {
      delete state.rainbowPid[hwnd];
    }
  }
  for (const hwnd of Object.keys(state.frameOwner || {})) {
    if (!trackedHwnds.has(hwnd)) delete state.frameOwner[hwnd];
  }
  return state;
}

module.exports = { readState, writeState, pruneStale, stateDir, stateFile, isProcessAlive };
