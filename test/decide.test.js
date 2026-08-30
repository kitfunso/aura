"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { identityFrom, decideEvent } = require("../src/decide.js");

// -- identityFrom: origin remote URL > repo root path > cwd --

test("identity: origin remote URL wins over repo root", () => {
  const id = identityFrom({
    gitCombined: "C:/Users/x/aura\nmaster",
    remoteUrl: "git@github.com:kitfunso/aura.git",
    cwd: "C:/Users/x/aura/src",
  });
  assert.strictEqual(id.repoId, "git@github.com:kitfunso/aura.git");
  assert.strictEqual(id.branch, "master");
  assert.strictEqual(id.name, "aura");
  assert.strictEqual(id.isRepo, true);
});

test("identity: repo root when no remote; missing branch line is null", () => {
  const id = identityFrom({ gitCombined: "C:/Users/x/aura", remoteUrl: null, cwd: "C:/Users/x/aura" });
  assert.strictEqual(id.repoId, "C:/Users/x/aura");
  assert.strictEqual(id.branch, null);
  assert.strictEqual(id.isRepo, true);
});

test("identity: cwd fallback outside any repo", () => {
  const id = identityFrom({ gitCombined: null, remoteUrl: null, cwd: "C:/Users/x/notes" });
  assert.strictEqual(id.repoId, path.resolve("C:/Users/x/notes"));
  assert.strictEqual(id.branch, null);
  assert.strictEqual(id.name, "notes");
  assert.strictEqual(id.isRepo, false);
});

// -- decideEvent: the steady-state ~70 ms path --

const HEX = "#266ed9";
const cachedSession = { hwnd: 853852, frameHex: HEX, vtHex: HEX };

test("steady state: cached hwnd + matching colors spawn nothing", () => {
  const plan = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cachedSession, frameHex: HEX, isRepo: true,
  });
  assert.strictEqual(plan.spawnAdapter, false);
  assert.strictEqual(plan.clearHandshake, false);
  assert.strictEqual(plan.cachedHwnd, 853852);
});

test("color change re-fires paint and re-marks delivery", () => {
  const plan = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cachedSession, frameHex: "#d9266e", isRepo: true,
  });
  assert.strictEqual(plan.spawnAdapter, true);
  assert.strictEqual(plan.markVtHex, true);
  assert.strictEqual(plan.vtDelayMs, 0);
});

// -- Measured trap 1 (2026-08-30): an immediate SessionStart VT write races
// Claude Code's TUI init and gets wiped. SessionStart must route delivery
// through the delayed writer and must NEVER mark vtHex itself - the first
// prompt is the re-delivery backstop. --

test("regression: SessionStart delays delivery and never marks vtHex", () => {
  const plan = decideEvent({
    eventName: "SessionStart", platform: "win32",
    session: {}, frameHex: HEX, isRepo: true,
  });
  assert.strictEqual(plan.spawnAdapter, true);
  assert.strictEqual(plan.vtDelayMs, 2000);
  assert.strictEqual(plan.markVtHex, false);
});

// -- Measured trap 2 (2026-08-30): a resumed session can land in a brand-new
// tab or window while state still carries the old handshake. SessionStart
// must drop the cached hwnd + vtHex so the session re-handshakes where it
// lives NOW, even when every cached value still matches. --

test("regression: SessionStart re-handshakes despite a fully-matching cache", () => {
  const plan = decideEvent({
    eventName: "SessionStart", platform: "win32",
    session: cachedSession, frameHex: HEX, isRepo: true,
  });
  assert.strictEqual(plan.clearHandshake, true);
  assert.strictEqual(plan.cachedHwnd, null);
  assert.strictEqual(plan.spawnAdapter, true);
});

test("prompt marks vtHex only when delivery is still owed", () => {
  const owed = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: { hwnd: 1, frameHex: HEX }, frameHex: HEX, isRepo: true,
  });
  assert.strictEqual(owed.markVtHex, true);
  const settled = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cachedSession, frameHex: HEX, isRepo: true,
  });
  assert.strictEqual(settled.markVtHex, false);
});

test("VT delivery is win32-only; POSIX never owes VT", () => {
  const plan = decideEvent({
    eventName: "UserPromptSubmit", platform: "linux",
    session: { hwnd: 1, frameHex: HEX }, frameHex: HEX, isRepo: true,
  });
  assert.strictEqual(plan.spawnAdapter, false);
  assert.strictEqual(plan.markVtHex, false);
});

// -- Rainbow-vs-frame routing (step 2) --

test("rainbow: non-repo on win32 wants the loop, repo and POSIX do not", () => {
  const folder = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: {}, frameHex: HEX, isRepo: false,
  });
  assert.strictEqual(folder.wantsRainbow, true);
  const repo = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: {}, frameHex: HEX, isRepo: true,
  });
  assert.strictEqual(repo.wantsRainbow, false);
  const posix = decideEvent({
    eventName: "SessionStart", platform: "darwin",
    session: {}, frameHex: HEX, isRepo: false,
  });
  assert.strictEqual(posix.wantsRainbow, false);
});
