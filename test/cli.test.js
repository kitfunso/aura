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

function runMark(cwd, extraArgs, extraEnv) {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-state-"));
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: stateHome,
    XDG_STATE_HOME: stateHome,
  });
  // No terminal marker: the adapter must not spawn inside the test suite.
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  Object.assign(env, extraEnv || {});
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

test("--write prints nothing, or the same escapes when no terminal device answers", () => {
  const dir = makeRepo("main");
  try {
    const written = runMark(dir, ["--write"]);
    assert.ok(written === "" || written === runMark(dir), "fallback is the plain payload");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The delta write carries only what it names, and dropping this one costs a
// second git spawn on every prompt.
test("the remote cache survives the delta write", () => {
  const dir = makeRepo("main");
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-remotes-"));
  const env = Object.assign({}, process.env, { LOCALAPPDATA: stateHome, XDG_STATE_HOME: stateHome });
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  try {
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.com/cached.git"], { stdio: "ignore" });
    execFileSync(process.execPath, [CLI, "mark", "--cwd", dir, "--session", "remote-cache"], { env });
    const state = JSON.parse(fs.readFileSync(path.join(stateHome, "aura", "state.json"), "utf8"));
    assert.deepStrictEqual(Object.values(state.remotes || {}), ["https://example.com/cached.git"]);
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shell-init emits a runnable snippet with the CLI path filled in", () => {
  for (const shell of ["powershell", "bash", "zsh"]) {
    const out = execFileSync(process.execPath, [CLI, "shell-init", "--shell", shell]).toString();
    assert.strictEqual(out.indexOf("__AURA_CLI__"), -1, shell + ": placeholder substituted");
    assert.ok(out.includes("bin/aura.js"), shell + ": points at this CLI");
    assert.ok(out.includes("--session"), shell + ": passes a stable session id");
  }
});

test("the powershell snippet guards against wrapping its own prompt twice", () => {
  const out = execFileSync(process.execPath, [CLI, "shell-init", "--shell", "powershell"]).toString();
  assert.ok(out.includes("aura-prompt"), "the wrapper is tagged");
  assert.ok(out.includes("notmatch 'aura-prompt'"), "and the tag is what the guard tests");
});

test("the posix snippet appends to the prompt hook rather than replacing it", () => {
  const out = execFileSync(process.execPath, [CLI, "shell-init", "--shell", "bash"]).toString();
  assert.ok(out.includes("$PROMPT_COMMAND"), "keeps an existing PROMPT_COMMAND");
  assert.ok(out.includes("precmd_functions"), "keeps an existing zsh precmd");
  assert.ok(out.includes("*aura_mark_cwd*"), "and does not append itself twice");
});

test("shell-init rejects an unknown shell", () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [CLI, "shell-init", "--shell", "fish"], { stdio: "ignore" });
  } catch (err) {
    code = err.status;
  }
  assert.strictEqual(code, 1);
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

// The macOS path end to end, not just the escape builder. On Windows the same
// TERM_PROGRAM would let the adapter paint the developer's own window.
const NO_ITERM_ON_WINDOWS = process.platform === "win32"
  ? "iTerm2 is a macOS terminal, and the adapter would paint this window"
  : false;

const BEL = String.fromCharCode(7);

test("iTerm2 gets a tint, three tab-color escapes and a title", { skip: NO_ITERM_ON_WINDOWS }, () => {
  const dir = makeRepo("main");
  try {
    const out = runMark(dir, [], { TERM_PROGRAM: "iTerm.app" });
    assert.ok(out.startsWith(ESC + "]11;#"), "the tint leads");
    ["red", "green", "blue"].forEach(function (channel) {
      const set = ESC + "]6;1;bg;" + channel + ";brightness;";
      assert.ok(out.includes(set), channel + " brightness is set");
      const value = out.slice(out.indexOf(set) + set.length).split(BEL)[0];
      assert.strictEqual(String(Number(value)), value, channel + " carries a channel number");
      assert.ok(Number(value) >= 0 && Number(value) <= 255, channel + " is in range");
    });
    assert.ok(out.endsWith(ESC + "]0;" + path.basename(dir) + " · main" + BEL), "title last");
    assert.strictEqual(out.indexOf(ESC + "]4;"), -1, "no Windows Terminal palette write");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leaving the repo gives iTerm2 back its own tab color", { skip: NO_ITERM_ON_WINDOWS }, () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-state-"));
  const dir = makeRepo("main");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "aura-plain-"));
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: stateHome, XDG_STATE_HOME: stateHome, TERM_PROGRAM: "iTerm.app",
  });
  delete env.WT_SESSION;
  const run = function (cwd) {
    return execFileSync(process.execPath,
      [CLI, "mark", "--cwd", cwd, "--session", "iterm-restore"], { env }).toString();
  };
  try {
    run(dir);
    const back = run(plain);
    assert.ok(back.startsWith(ESC + "]111" + BEL + ESC + "]6;1;bg;*;default" + BEL),
      "the background and the tab color both come back");
  } finally {
    [stateHome, dir, plain].forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); });
  }
});
