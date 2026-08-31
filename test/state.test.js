"use strict";
// The whole point of the lock: many shells mark at once, and each one rewrites
// the entire file. Without a locked delta the last writer wins and the rest of
// the sessions vanish, taking their cached HWNDs with them.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "aura.js");
const WRITERS = 12;

function markAsync(cwd, sessionId, env) {
  return new Promise(function (resolve) {
    execFile(process.execPath, [CLI, "mark", "--cwd", cwd, "--session", sessionId],
      { env }, function () { resolve(); });
  });
}

test("concurrent writers all survive", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-race-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-race-repo-"));
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: stateHome,
    XDG_STATE_HOME: stateHome,
  });
  delete env.WT_SESSION;
  try {
    const ids = [];
    for (let i = 0; i < WRITERS; i++) ids.push("shell-race-" + i);
    await Promise.all(ids.map(function (id) { return markAsync(dir, id, env); }));

    const file = path.join(stateHome, "aura", "state.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const missing = ids.filter(function (id) { return !state.sessions[id]; });
    assert.deepStrictEqual(missing, [], "no session entry was overwritten away");
    assert.ok(!fs.existsSync(file + ".lock"), "the lock is released");
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock left by a dead process is taken, not waited on forever", () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-lock-"));
  const prevLocal = process.env.LOCALAPPDATA;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.LOCALAPPDATA = stateHome;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    const { updateState, stateFile } = require("../src/state.js");
    const lock = stateFile() + ".lock";
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const old = Date.now() - 60000;
    fs.utimesSync(lock, new Date(old), new Date(old));

    const started = Date.now();
    updateState(function (state) { state.sessions["after-a-dead-lock"] = { updatedAt: new Date().toISOString() }; });
    assert.ok(Date.now() - started < 1000, "the stale lock did not cost a full wait");
    assert.ok(JSON.parse(fs.readFileSync(stateFile(), "utf8")).sessions["after-a-dead-lock"]);
  } finally {
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
});
