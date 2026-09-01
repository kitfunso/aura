"use strict";
// Drives the emitted snippets through the real shells. Everything here is a
// risk the plan named: a stolen prompt, a double wrap, a mark that never fires.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "aura.js");
const HARNESS = path.join(__dirname, "fixtures", "drive-powershell.ps1");

function snippetFor(shell, dir) {
  const file = path.join(dir, shell === "powershell" ? "aura.ps1" : "aura.sh");
  fs.writeFileSync(file, execFileSync(process.execPath, [CLI, "shell-init", "--shell", shell]).toString());
  return file;
}

// The harness spawns the real CLI, so without this it paints the developer's
// own window and its delayed adapter races the state this test reads.
function noTerminal() {
  const env = Object.assign({}, process.env);
  ["WT_SESSION", "WEZTERM_PANE", "ALACRITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR",
    "TERM_PROGRAM"].forEach(function (name) { delete env[name]; });
  return env;
}

// A CI runner hands out TEMP as an 8.3 short path, PowerShell reports the long
// form back, and only realpath reconciles the two into one directory.
function realDir(p) {
  try {
    return fs.realpathSync.native(String(p));
  } catch (err) {
    return path.resolve(String(p));
  }
}

function sameDir(a, b) {
  return realDir(a).toLowerCase() === realDir(b).toLowerCase();
}

// A failure here lands on a machine I do not own, so it carries both paths.
function dirsWere(a, b) {
  return String(a) + " vs " + String(b);
}

function makeRepo(dir, name) {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-m", "x"], { stdio: "ignore" });
  return repo;
}

test("the powershell snippet parses with no errors", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-parse-"));
  try {
    const snippet = snippetFor("powershell", dir).replace(/\\/g, "/");
    const command = "$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile(" +
      "'" + snippet + "', [ref]$null, [ref]$e); $e.Count";
    const errors = execFileSync("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]).toString().trim();
    assert.strictEqual(errors, "0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the powershell prompt wrapper marks, keeps the old prompt, and wraps once",
  { skip: process.platform !== "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-drive-"));
    try {
      const snippet = snippetFor("powershell", dir);
      const repoA = makeRepo(dir, "alpha");
      const repoB = makeRepo(dir, "beta");
      const stateHome = path.join(dir, "state");
      const out = path.join(dir, "result.json");
      execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HARNESS,
        "-Snippet", snippet, "-RepoA", repoA, "-RepoB", repoB,
        "-StateHome", stateHome, "-OutFile", out],
        { stdio: ["ignore", "ignore", "pipe"], env: noTerminal() });

      // PowerShell 5.1 puts a BOM on everything it writes.
      const result = JSON.parse(fs.readFileSync(out, "utf8").replace(/^﻿/, ""));
      assert.strictEqual(result.promptText, "ORIGINAL> ", "the shell's own prompt still runs");
      assert.strictEqual(sameDir(result.lastPath, repoB), true,
        "the wrapper tracked the last cd: " + dirsWere(result.lastPath, repoB));
      assert.strictEqual(result.wrapCount, 1, "re-sourcing the profile did not wrap twice");

      const state = JSON.parse(fs.readFileSync(path.join(stateHome, "aura", "state.json"), "utf8"));
      const sessions = Object.keys(state.sessions);
      assert.strictEqual(sessions.length, 1, "one shell, one session entry");
      assert.match(sessions[0], /^shell-\d+-\d+$/, "the session id carries pid and start second");
      assert.strictEqual(sameDir(state.sessions[sessions[0]].repoId, repoB), true,
        "state carries the last repo: " + dirsWere(state.sessions[sessions[0]].repoId, repoB));
      assert.strictEqual(state.sessions[sessions[0]].isRepo, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test("the posix snippet parses under bash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-sh-"));
  try {
    execFileSync("bash", ["-n", snippetFor("bash", dir)], { stdio: "ignore" });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The tag verb keys off this variable, so a shell that does not export it
// leaves every non-Claude agent tagging a pid nobody else writes to.
test("the powershell snippet exports its session key to child processes",
  { skip: process.platform !== "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-env-"));
    try {
      const snippet = snippetFor("powershell", dir).split(path.sep).join("/");
      const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass",
        "-Command", ". '" + snippet + "'; $env:AURA_SESSION"]).toString().trim();
      assert.match(out, /^shell-\d+-\d+$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test("the posix snippet exports its session key to child processes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-env-sh-"));
  try {
    const script = '. "$1"; "$2" -e "process.stdout.write(String(process.env.AURA_SESSION||0))"';
    const out = execFileSync("bash", ["-c", script, "bash", snippetFor("bash", dir), process.execPath])
      .toString().trim();
    assert.match(out, /^shell-\d+-\d+$/);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
