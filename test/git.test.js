"use strict";
// Drives the real git binary against real repos: the bug these cover was a
// probe that trusted git's exit code instead of its output.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { resolveIdentity } = require("../src/git.js");

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aura-git-"));
}

function git(cwd, args) {
  execFileSync("git", ["-C", cwd].concat(args), { stdio: "ignore" });
}

test("a repo with no commits is still a repo", () => {
  const dir = makeDir();
  try {
    git(dir, ["init"]);
    const id = resolveIdentity(dir, {}, false);
    assert.strictEqual(id.isRepo, true);
    assert.strictEqual(id.branch, null);
    assert.strictEqual(path.basename(id.repoId), path.basename(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a repo with a commit reports its branch", () => {
  const dir = makeDir();
  try {
    git(dir, ["init", "--initial-branch", "trunk"]);
    git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x"]);
    const id = resolveIdentity(dir, {}, false);
    assert.strictEqual(id.isRepo, true);
    assert.strictEqual(id.branch, "trunk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a plain folder is not a repo", () => {
  const dir = makeDir();
  try {
    const id = resolveIdentity(dir, {}, false);
    assert.strictEqual(id.isRepo, false);
    assert.strictEqual(id.branch, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Changing origin on disk is what proves the cache: a second spawn would see
// the new URL, a cache hit keeps the old one.
test("a cached remote is reused, and rechecked only at session start", () => {
  const dir = makeDir();
  try {
    git(dir, ["init"]);
    git(dir, ["remote", "add", "origin", "https://example.com/first.git"]);
    const state = {};
    const first = resolveIdentity(dir, state, false);
    assert.strictEqual(first.repoId, "https://example.com/first.git");
    assert.strictEqual(state.remotes[first.root], "https://example.com/first.git");
    assert.strictEqual(first.remoteUrl, "https://example.com/first.git");

    git(dir, ["remote", "set-url", "origin", "https://example.com/second.git"]);
    assert.strictEqual(resolveIdentity(dir, state, false).repoId, "https://example.com/first.git");
    assert.strictEqual(resolveIdentity(dir, state, true).repoId, "https://example.com/first.git");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a repo that gains an origin picks it up at session start", () => {
  const dir = makeDir();
  try {
    git(dir, ["init"]);
    const state = {};
    const before = resolveIdentity(dir, state, false);
    assert.strictEqual(before.remoteUrl, null);
    assert.strictEqual(state.remotes[before.root], null);

    git(dir, ["remote", "add", "origin", "https://example.com/late.git"]);
    assert.strictEqual(resolveIdentity(dir, state, false).repoId, before.root);
    assert.strictEqual(resolveIdentity(dir, state, true).repoId, "https://example.com/late.git");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a detached HEAD is a repo with no branch", () => {
  const dir = makeDir();
  try {
    git(dir, ["init"]);
    git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x"]);
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
    git(dir, ["checkout", "--detach", head]);
    const id = resolveIdentity(dir, {}, false);
    assert.strictEqual(id.isRepo, true);
    assert.strictEqual(id.branch, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
