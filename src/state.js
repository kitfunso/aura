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
const RENAME_WAIT_MS = 250;
const RENAME_SLICE_MS = 5;

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

// null means "there is state here but it would not read", which is not the same
// as no state: writing an empty file back would delete every other window.
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.sessions) return parsed;
  } catch (err) {
    if (err.code && err.code !== "ENOENT") return null;
  }
  return { sessions: {} };
}

function writeState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Per-process temp name, so two writers can never share one.
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  // Windows refuses the rename while a reader holds the destination open, and
  // allows it the moment that reader closes (measured), so wait the reader out.
  const deadline = Date.now() + RENAME_WAIT_MS;
  for (;;) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        try { fs.unlinkSync(temp); } catch (cleanupErr) { /* nothing left to do */ }
        throw err;
      }
      sleep(RENAME_SLICE_MS);
    }
  }
}

function pruneStale(state, now = Date.now()) {
  for (const [id, session] of Object.entries(state.sessions)) {
    const updated = Date.parse(session.updatedAt || "");
    if (!Number.isFinite(updated) || now - updated > STALE_MS) {
      delete state.sessions[id];
    }
  }
  // A tag outlives nothing: its session is the only thing that gives it meaning.
  for (const id of Object.keys(state.tags || {})) {
    if (!state.sessions[id]) delete state.tags[id];
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
      // Rule 6: never stall a prompt. Giving up writes NOTHING, because an
      // unsynchronized write is the loss the lock exists to prevent.
      if (Date.now() >= deadline) return null;
      sleep(LOCK_SLICE_MS);
    }
  }
}

// The caller's snapshot can be seconds old, because the adapter spawn happens
// between the read and here, and every shell prompt is a competing writer.
function updateState(mutate) {
  const release = acquireLock();
  if (!release) return false;
  try {
    const state = readState();
    if (!state) return false;
    mutate(state);
    pruneStale(state);
    writeState(state);
    return true;
  } finally {
    release();
  }
}

module.exports = { readState, writeState, updateState, pruneStale, stateDir, stateFile };
