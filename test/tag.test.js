"use strict";
// Drives the real CLI: a tag has to survive the round trip through state.json
// and change what the next mark paints, or it is worth nothing.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { inTerminalSession } = require("../src/tag.js");

const CLI = path.join(__dirname, "..", "bin", "aura.js");

function makeSandbox() {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-tagstate-"));
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
  const file = path.join(stateHome, "aura", "state.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function makeRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-tagrepo-"));
  execFileSync("git", ["-C", dir, "init", "--initial-branch", branch], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-m", "x"], { stdio: "ignore" });
  return dir;
}

test("a tag outranks the working directory on the next mark", () => {
  const { stateHome, env } = makeSandbox();
  const repo = makeRepo("main");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aura-taghome-"));
  try {
    const untagged = run(env, home, ["mark", "--cwd", home, "--session", "s1"]);
    assert.ok(!untagged.includes("]11;"), "a plain folder gets no tint");

    run(env, home, ["tag", repo, "--session", "s1"]);
    const tagged = run(env, home, ["mark", "--cwd", home, "--session", "s1"]);
    assert.ok(tagged.includes("]11;"), "the tagged session gets the repo tint");
    assert.strictEqual(stateOf(stateHome).sessions.s1.isRepo, true);
    assert.strictEqual(stateOf(stateHome).sessions.s1.branch, "main");
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the tag write survives its own prune", () => {
  const { stateHome, env } = makeSandbox();
  const repo = makeRepo("main");
  try {
    // Nothing has marked yet, so the session has no entry to hang the tag on.
    run(env, repo, ["tag", repo, "--session", "fresh"]);
    assert.strictEqual(stateOf(stateHome).tags.fresh, repo);
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("clear puts the session back on its working directory", () => {
  const { stateHome, env } = makeSandbox();
  const repo = makeRepo("main");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aura-taghome2-"));
  try {
    run(env, home, ["tag", repo, "--session", "s2"]);
    run(env, home, ["tag", "--clear", "--session", "s2"]);
    assert.strictEqual(stateOf(stateHome).tags.s2, undefined);
    const out = run(env, home, ["mark", "--cwd", home, "--session", "s2"]);
    assert.ok(!out.includes("]11;"), "back to no color off repo");
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the session key comes from the agent's own environment", () => {
  const { stateHome, env } = makeSandbox();
  const repo = makeRepo("main");
  try {
    const claudeEnv = Object.assign({}, env, { CLAUDE_CODE_SESSION_ID: "abc-123" });
    run(claudeEnv, repo, ["tag", repo]);
    assert.strictEqual(stateOf(stateHome).tags["abc-123"], repo);
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a missing directory is refused, not recorded", () => {
  const { stateHome, env } = makeSandbox();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aura-taghome3-"));
  try {
    assert.throws(function () {
      execFileSync(process.execPath, [CLI, "tag", "no-such-dir", "--session", "s3"],
        { env, cwd: home, stdio: "ignore" });
    });
    const file = path.join(stateHome, "aura", "state.json");
    if (fs.existsSync(file)) assert.strictEqual(stateOf(stateHome).tags, undefined);
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a tag paints the window at once, because no prompt is coming", () => {
  const { stateHome, env } = makeSandbox();
  const repo = makeRepo("main");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aura-taghome4-"));
  try {
    // A marker no adapter can act on: it proves the gate, not the desktop.
    const seen = Object.assign({}, env, { WEZTERM_PANE: "7" });
    run(seen, home, ["tag", repo, "--session", "s4"]);
    const painted = stateOf(stateHome).sessions.s4;
    assert.strictEqual(painted.isRepo, true, "the tag was resolved and marked");
    assert.ok(painted.frameHex, "a color was computed for the window");

    run(env, home, ["tag", repo, "--session", "s5"]);
    const quiet = stateOf(stateHome).sessions.s5;
    assert.strictEqual(quiet.frameHex, undefined, "nothing to paint with no terminal");
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the paint gate takes any agent's session variable as proof", () => {
  assert.strictEqual(inTerminalSession({}), false);
  assert.strictEqual(inTerminalSession({ PATH: "/usr/bin" }), false);
  assert.strictEqual(inTerminalSession({ AURA_SESSION: "shell-1-2" }), true);
  assert.strictEqual(inTerminalSession({ CLAUDE_CODE_SESSION_ID: "abc" }), true);
  assert.strictEqual(inTerminalSession({ TERM_PROGRAM: "iTerm.app" }), true);
});
