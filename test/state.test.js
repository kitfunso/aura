"use strict";
// Many shells mark at once and each rewrites the whole file, so a delta lands
// under a lock or the last writer wins. Losing the lock race is allowed:
// mark paints BEFORE it writes, so a dropped write costs only a cache entry.
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

test("concurrent writers never clobber a session already in the file", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-race-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-race-repo-"));
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: stateHome,
    XDG_STATE_HOME: stateHome,
  });
  delete env.WT_SESSION;
  try {
    const file = path.join(stateHome, "aura", "state.json");
    // Seeded first, so survival cannot depend on winning a wall-clock race for
    // the lock. A bystander is exactly what last-writer-wins destroys.
    const bystanders = {};
    for (let i = 0; i < 6; i++) {
      bystanders["shell-bystander-" + i] = { updatedAt: new Date().toISOString(), isRepo: false };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessions: bystanders }, null, 2));

    const ids = [];
    for (let i = 0; i < WRITERS; i++) ids.push("shell-race-" + i);
    await Promise.all(ids.map(function (id) { return markAsync(dir, id, env); }));

    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const lost = Object.keys(bystanders).filter(function (id) { return !state.sessions[id]; });
    assert.deepStrictEqual(lost, [], "a writer overwrote a session that was already there");

    const landed = ids.filter(function (id) { return state.sessions[id]; });
    assert.ok(landed.length > 0, "contention blocked every single write");
    // A half-applied delta is the other shape of the same bug.
    const partial = landed.filter(function (id) { return !state.sessions[id].repoId; });
    assert.deepStrictEqual(partial, [], "a landed entry was written without its identity");
    assert.ok(!fs.existsSync(file + ".lock"), "the lock is released");
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rename the OS refuses is retried, not lost", () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-eperm-"));
  const prevLocal = process.env.LOCALAPPDATA;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.LOCALAPPDATA = stateHome;
  process.env.XDG_STATE_HOME = stateHome;
  const realRename = fs.renameSync;
  // Stands in for a reader whose handle stays open far longer than a whole
  // prompt turn, which is the case a fixed attempt count gets wrong.
  const HELD_MS = 120;
  const releaseAt = Date.now() + HELD_MS;
  let refusals = 0;
  fs.renameSync = function (from, to) {
    if (Date.now() < releaseAt) {
      refusals++;
      const err = new Error("EPERM: operation not permitted, rename '" + from + "' -> '" + to + "'");
      err.code = "EPERM";
      throw err;
    }
    return realRename(from, to);
  };
  try {
    const { writeState, stateFile } = require("../src/state.js");
    const started = Date.now();
    writeState({ sessions: { "survived-eperm": { updatedAt: new Date().toISOString() } } });
    assert.ok(JSON.parse(fs.readFileSync(stateFile(), "utf8")).sessions["survived-eperm"]);
    assert.ok(refusals > 1, "the rename really was refused, repeatedly");
    assert.ok(Date.now() - started >= HELD_MS, "it waited the reader out instead of giving up");
    const leftovers = fs.readdirSync(path.dirname(stateFile())).filter(function (name) { return name.endsWith(".tmp"); });
    assert.deepStrictEqual(leftovers, [], "no temp file was left behind");
  } finally {
    fs.renameSync = realRename;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
});

test("a state file that will not read is left alone, not emptied", () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-unread-"));
  const prevLocal = process.env.LOCALAPPDATA;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.LOCALAPPDATA = stateHome;
  process.env.XDG_STATE_HOME = stateHome;
  const realRead = fs.readFileSync;
  try {
    const { updateState, writeState, stateFile } = require("../src/state.js");
    writeState({ sessions: { "another-window": { updatedAt: new Date().toISOString() } } });
    const before = realRead(stateFile(), "utf8");

    fs.readFileSync = function (file, options) {
      if (String(file) === stateFile()) {
        const err = new Error("EBUSY: resource busy or locked, read");
        err.code = "EBUSY";
        throw err;
      }
      return realRead(file, options);
    };
    const wrote = updateState(function (state) { state.sessions["would-clobber"] = {}; });

    fs.readFileSync = realRead;
    assert.strictEqual(wrote, false, "the caller is told the delta did not land");
    assert.strictEqual(fs.readFileSync(stateFile(), "utf8"), before, "the other window survived");
  } finally {
    fs.readFileSync = realRead;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
});

test("a corrupt state file self-heals instead of wedging", () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-corrupt-"));
  const prevLocal = process.env.LOCALAPPDATA;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.LOCALAPPDATA = stateHome;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    const { updateState, stateFile } = require("../src/state.js");
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), "{ not json at all");
    const wrote = updateState(function (state) { state.sessions["after-corruption"] = { updatedAt: new Date().toISOString() }; });
    assert.strictEqual(wrote, true);
    assert.ok(JSON.parse(fs.readFileSync(stateFile(), "utf8")).sessions["after-corruption"]);
  } finally {
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
});

test("a lock held by a live writer makes us give up, not write unsynchronized", () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-busy-"));
  const prevLocal = process.env.LOCALAPPDATA;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.LOCALAPPDATA = stateHome;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    const { updateState, stateFile } = require("../src/state.js");
    const lock = stateFile() + ".lock";
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");

    const started = Date.now();
    const wrote = updateState(function (state) { state.sessions["never-lands"] = { updatedAt: new Date().toISOString() }; });
    assert.strictEqual(wrote, false, "the caller is told the delta did not land");
    assert.ok(!fs.existsSync(stateFile()), "nothing was written outside the lock");
    assert.ok(Date.now() - started < 1000, "the prompt was not stalled");
  } finally {
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(stateHome, { recursive: true, force: true });
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
