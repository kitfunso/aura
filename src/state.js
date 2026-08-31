"use strict";
// Local session state: HWND cache + latest prompt, keyed by Claude session id.
// One small JSON file, rewritten atomically (temp + rename).
const fs = require("fs");
const os = require("os");
const path = require("path");

const STALE_MS = 48 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 200;
const LOCK_SLICE_MS = 5;

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
  const trackedHwnds = new Set();
  for (const session of Object.values(state.sessions)) {
    if (session.hwnd) trackedHwnds.add(String(session.hwnd));
  }
  for (const hwnd of Object.keys(state.frameOwner || {})) {
    if (!trackedHwnds.has(hwnd)) delete state.frameOwner[hwnd];
  }
  return state;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Exclusive create is the atomic primitive. A lock older than the adapter
// timeout belongs to a process that died holding it, so it is taken.
function acquireLock() {
  const lock = stateFile() + ".lock";
  const deadline = Date.now() + LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      return function () { try { fs.unlinkSync(lock); } catch (err) { /* already gone */ } };
    } catch (err) {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch (staleErr) { /* another waiter took it first */ }
      // Rule 6: stalling a prompt is worse than a rare lost update.
      if (Date.now() >= deadline) return function () { };
      sleep(LOCK_SLICE_MS);
    }
  }
}

// The caller's snapshot can be seconds old, because the adapter spawn happens
// between the read and here, and every shell prompt is a competing writer.
function updateState(mutate) {
  const release = acquireLock();
  try {
    const state = readState();
    mutate(state);
    pruneStale(state);
    writeState(state);
  } finally {
    release();
  }
}

module.exports = { readState, writeState, updateState, pruneStale, stateDir, stateFile };
