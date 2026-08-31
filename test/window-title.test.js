"use strict";
// Drives the real CLI: a tab name only earns its keep if it survives the round
// trip through state.json and colors a session that sits in no repo.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "aura.js");

function makeSandbox(seed) {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-winstate-"));
  fs.mkdirSync(path.join(stateHome, "aura"));
  fs.writeFileSync(path.join(stateHome, "aura", "state.json"), JSON.stringify(seed));
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: stateHome,
    XDG_STATE_HOME: stateHome,
  });
  // No terminal marker: the adapter must not spawn inside the test suite.
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.AURA_SESSION;
  return { stateHome, env };
}

function run(env, cwd, args) {
  return execFileSync(process.execPath, [CLI].concat(args), { env, cwd }).toString();
}

function stateOf(stateHome) {
  return JSON.parse(fs.readFileSync(path.join(stateHome, "aura", "state.json"), "utf8"));
}

function withSandbox(seed, body) {
  const { stateHome, env } = makeSandbox(seed);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aura-winhome-"));
  try {
    body({ stateHome, env, home });
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("a named tab colors a session that sits in no repo", () => {
  withSandbox({ sessions: { s1: { windowName: "intraday" } } }, ({ stateHome, env, home }) => {
    const out = run(env, home, ["mark", "--cwd", home, "--session", "s1"]);
    assert.ok(out.includes("]11;"), "the named tab gets the tint");
    assert.ok(!out.includes("]0;"), "and keeps its own name: no title escape");

    const session = stateOf(stateHome).sessions.s1;
    assert.strictEqual(session.repoId, "window:intraday");
    assert.strictEqual(session.hasColor, true);
    assert.strictEqual(session.isRepo, false, "a tab name is not a repo");
  });
});

test("two tabs with different names get different colors", () => {
  withSandbox({ sessions: { s1: { windowName: "intraday" }, s2: { windowName: "Speech" } } },
    ({ stateHome, env, home }) => {
      run(env, home, ["mark", "--cwd", home, "--session", "s1"]);
      run(env, home, ["mark", "--cwd", home, "--session", "s2"]);
      const sessions = stateOf(stateHome).sessions;
      assert.notStrictEqual(sessions.s1.frameHex, sessions.s2.frameHex);
    });
});

test("a tag outranks the tab name it was set from", () => {
  withSandbox({ sessions: { s1: { windowName: "intraday" } } }, ({ stateHome, env, home }) => {
    const tags = {};
    tags.s1 = home;
    const file = path.join(stateHome, "aura", "state.json");
    const seeded = JSON.parse(fs.readFileSync(file, "utf8"));
    seeded.tags = tags;
    fs.writeFileSync(file, JSON.stringify(seeded));

    run(env, home, ["mark", "--cwd", home, "--session", "s1"]);
    const session = stateOf(stateHome).sessions.s1;
    assert.strictEqual(session.hasColor, false, "the tagged folder is no repo, so no color");
    assert.notStrictEqual(session.repoId, "window:intraday");
  });
});

test("a name aura already looked for and missed is not looked for again", () => {
  withSandbox({ sessions: { s1: { windowName: "" } } }, ({ stateHome, env, home }) => {
    const out = run(env, home, ["mark", "--cwd", home, "--session", "s1"]);
    assert.ok(!out.includes("]11;"), "a nameless window in no repo stays uncolored");

    const session = stateOf(stateHome).sessions.s1;
    assert.strictEqual(session.hasColor, false);
    assert.strictEqual(session.windowName, "", "the miss stays cached");
  });
});
