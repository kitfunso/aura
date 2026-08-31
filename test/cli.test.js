"use strict";
// Runs the real CLI as a child process against real directories: the contract
// is what lands on stdout, because the shell writes exactly that.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "aura.js");
const ESC = "\u001b";

function runMark(cwd, extraArgs) {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-state-"));
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: stateHome,
    XDG_STATE_HOME: stateHome,
  });
  // No terminal marker: the adapter must not spawn inside the test suite.
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  try {
    const args = [CLI, "mark", "--cwd", cwd, "--session", "test-session"];
    return execFileSync(process.execPath, args.concat(extraArgs || []), { env }).toString();
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
}

// A commit is required: an unborn HEAD reports no branch, so the shade
// would not move when the branch does.
function makeRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-cli-"));
  execFileSync("git", ["-C", dir, "init", "--initial-branch", branch], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-m", "x"], { stdio: "ignore" });
  return dir;
}

test("mark in a repo prints a background tint and the repo name", () => {
  const dir = makeRepo("main");
  try {
    const out = runMark(dir);
    assert.match(out, new RegExp("^" + ESC + "\\]11;#[0-9a-f]{6}\u0007"));
    assert.ok(out.includes(path.basename(dir)), "title carries the repo name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mark outside a repo prints a title and no color", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-plain-"));
  try {
    const out = runMark(dir);
    assert.strictEqual(out.indexOf(ESC + "]11;"), -1, "no tint off repo");
    assert.strictEqual(out, ESC + "]0;" + path.basename(dir) + "\u0007");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the same repo path always prints the same tint", () => {
  const dir = makeRepo("main");
  try {
    assert.strictEqual(runMark(dir), runMark(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a branch reaches the title, and changes the shade", () => {
  const dir = makeRepo("main");
  try {
    const onMain = runMark(dir);
    execFileSync("git", ["-C", dir, "checkout", "-b", "feature"], { stdio: "ignore" });
    const onFeature = runMark(dir);
    assert.ok(onFeature.includes("feature"), "branch reaches the title");
    assert.notStrictEqual(onMain, onFeature);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--title appends a snippet, sanitized of control bytes", () => {
  const dir = makeRepo("main");
  try {
    const out = runMark(dir, ["--title", "npm\u0007 test"]);
    assert.ok(out.includes("npm test"), "control bytes cannot terminate the sequence");
    assert.strictEqual(out.split("\u0007").length - 1, 2, "one tint terminator, one title terminator");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown command exits non-zero and prints nothing on stdout", () => {
  let code = 0;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [CLI, "nonsense"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch (err) {
    code = err.status;
    stdout = err.stdout.toString();
  }
  assert.strictEqual(code, 1);
  assert.strictEqual(stdout, "");
});
