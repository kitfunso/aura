"use strict";
// A second identity source, for a session whose working directory says nothing
// useful: an agent launched from a home folder. Design: docs/ARCHITECTURE.md.
const fs = require("fs");
const path = require("path");
const { readState, updateState } = require("./state.js");

// Every agent that runs in a terminal exports one of these, so a tag set from
// inside a session lands on the same key its own prompts will write.
function sessionKey(env, explicit) {
  return explicit || env.CLAUDE_CODE_SESSION_ID || env.AURA_SESSION || "shell-" + process.ppid;
}

// Proof that a person is sitting in a terminal. A headless run has none of
// these, and painting a foreground window there colors an unrelated app.
const SESSION_MARKERS = [
  "WT_SESSION", "TERM_PROGRAM", "CLAUDE_CODE_SESSION_ID", "AURA_SESSION",
  "WEZTERM_PANE", "ALACRITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR",
];

function inTerminalSession(env) {
  return SESSION_MARKERS.some(function (name) { return Boolean(env[name]); });
}

function readTag(sessionId) {
  const state = readState();
  return (state && state.tags && state.tags[sessionId]) || null;
}

function writeTag(sessionId, target) {
  return updateState(function (fresh) {
    const tags = fresh.tags || (fresh.tags = {});
    if (target) tags[sessionId] = target;
    else delete tags[sessionId];
    // Without an entry the prune below would drop the tag in the same write.
    const session = fresh.sessions[sessionId] || (fresh.sessions[sessionId] = {});
    session.updatedAt = new Date().toISOString();
  });
}

function resolveTarget(arg, cwd) {
  const target = path.resolve(cwd, arg);
  try {
    return fs.statSync(target).isDirectory() ? target : null;
  } catch (err) {
    return null;
  }
}

module.exports = { sessionKey, readTag, writeTag, resolveTarget, inTerminalSession };
