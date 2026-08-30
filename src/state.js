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

function pruneStale(state, now = Date.now()) {
  for (const [id, session] of Object.entries(state.sessions)) {
    const updated = Date.parse(session.updatedAt || "");
    if (!Number.isFinite(updated) || now - updated > STALE_MS) {
      delete state.sessions[id];
    }
  }
  return state;
}

module.exports = { readState, writeState, pruneStale, stateDir, stateFile };
