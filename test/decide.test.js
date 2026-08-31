"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const {
  identityFrom, usableWindowTitle, settleWindowName, decideEvent, hasTerminalMarker,
  windowHasColoredSession, coloredSessionHwnds,
} = require("../src/decide.js");

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
// The delivery cache keys on the escapes sent, not on their color, so a change
// to the escape shape re-delivers on its own.
const SIG = "1kf3n";
const OTHER_SIG = "9zq2b";
const cachedSession = { hwnd: 853852, frameHex: HEX, vtSent: SIG };

test("steady state: cached hwnd + matching colors spawn nothing", () => {
  const plan = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cachedSession, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(plan.spawnAdapter, false);
  assert.strictEqual(plan.clearHandshake, false);
  assert.strictEqual(plan.cachedHwnd, 853852);
});

test("color change re-fires paint and re-marks delivery", () => {
  const plan = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cachedSession, frameHex: "#d9266e", vtSignature: OTHER_SIG, hasColor: true,
  });
  assert.strictEqual(plan.spawnAdapter, true);
  assert.strictEqual(plan.markVtSent, true);
  assert.strictEqual(plan.vtDelayMs, 0);
});

// -- Measured traps (ARCHITECTURE.md Known Risks). Trap 1: a SessionStart VT
// write races Claude Code's TUI init, so it delays and never marks delivery. --

test("regression: SessionStart delays delivery and never marks delivery", () => {
  const plan = decideEvent({
    eventName: "SessionStart", platform: "win32",
    session: {}, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(plan.spawnAdapter, true);
  assert.strictEqual(plan.vtDelayMs, 2000);
  assert.strictEqual(plan.markVtSent, false);
});

// -- Trap 2: a resumed session can land in a brand-new tab or window, so
// SessionStart drops the cached hwnd + delivery mark even when they still match. --

test("regression: SessionStart re-handshakes despite a fully-matching cache", () => {
  const plan = decideEvent({
    eventName: "SessionStart", platform: "win32",
    session: cachedSession, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(plan.clearHandshake, true);
  assert.strictEqual(plan.cachedHwnd, null);
  assert.strictEqual(plan.spawnAdapter, true);
});

test("prompt marks delivery only when delivery is still owed", () => {
  const owed = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: { hwnd: 1, frameHex: HEX }, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(owed.markVtSent, true);
  const settled = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cachedSession, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(settled.markVtSent, false);
});

// -- Trap 3: the cache used to key on the color, so changing the escapes
// without changing the color left every open session silently stale. --

test("regression: new escapes re-deliver even when the color did not move", () => {
  const plan = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cachedSession, frameHex: HEX, vtSignature: OTHER_SIG, hasColor: true,
  });
  assert.strictEqual(plan.spawnAdapter, true);
  assert.strictEqual(plan.markVtSent, true);
});

// -- Trap 4: the start-time foreground window is a guess (five windows once
// shared one cached HWND), so the first prompt re-resolves the handle. --

test("regression: the first prompt re-resolves the window, later prompts trust the cache", () => {
  const owed = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: { hwnd: 853852, frameHex: HEX }, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(owed.cachedHwnd, null);      // adapter takes the foreground window
  assert.strictEqual(owed.spawnAdapter, true);    // the spawn it rides was happening anyway
  const settled = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cachedSession, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(settled.cachedHwnd, 853852); // steady state stays spawn-free
  assert.strictEqual(settled.spawnAdapter, false);
});

test("VT delivery is win32-only; POSIX never owes VT", () => {
  const plan = decideEvent({
    eventName: "UserPromptSubmit", platform: "linux",
    session: { hwnd: 1, frameHex: HEX }, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(plan.spawnAdapter, false);
  assert.strictEqual(plan.markVtSent, false);
});

// -- Terminal markers: the first-paint gate (broadened from WT_SESSION-only
// 2026-08-30 so wezterm/alacritty/ghostty sessions get their first paint) --

test("terminal markers: every supported terminal opens the gate, headless does not", () => {
  assert.strictEqual(hasTerminalMarker({}), false);                   // cron / Task Scheduler
  assert.strictEqual(hasTerminalMarker({ PATH: "C:/x" }), false);     // unrelated env only
  assert.strictEqual(hasTerminalMarker({ WT_SESSION: "" }), false);   // empty = unset
  for (const name of ["WT_SESSION", "WEZTERM_PANE", "ALACRITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR"]) {
    assert.strictEqual(hasTerminalMarker({ [name]: "x" }), true, name);
  }
});

// -- No repo, no color --

test("off-repo sessions use no color at all and reset the frame once", () => {
  const shell = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: {}, frameHex: HEX, vtSignature: SIG, hasColor: false,
  });
  assert.strictEqual(shell.usesColor, false);
  assert.strictEqual(shell.paintsFrame, false);
  assert.strictEqual(shell.resetFrame, true);
  assert.strictEqual(shell.spawnAdapter, true);   // the reset needs one spawn
  const repo = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: {}, frameHex: HEX, vtSignature: SIG, hasColor: true,
  });
  assert.strictEqual(repo.usesColor, true);
  assert.strictEqual(repo.resetFrame, false);
});

test("the off-repo reset happens once, then the prompt path is spawn-free", () => {
  const cleared = { hwnd: 853852, frameHex: HEX, vtSent: SIG, frameCleared: true };
  const settled = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session: cleared, frameHex: HEX, vtSignature: SIG, hasColor: false,
  });
  assert.strictEqual(settled.spawnAdapter, false);
  // a session start re-handshakes, so the reset runs again on the new window
  const restarted = decideEvent({
    eventName: "SessionStart", platform: "win32",
    session: cleared, frameHex: HEX, vtSignature: SIG, hasColor: false,
  });
  assert.strictEqual(restarted.spawnAdapter, true);
});

// -- Window-scoped ownership: tabs share one frame --

test("windowHasColoredSession: only a live repo sibling on the SAME window counts", () => {
  const sessions = {
    repo: { hasColor: true, hwnd: 853852 },
    shell: { hasColor: false, hwnd: 853852 },
    other: { hasColor: true, hwnd: 999 },
    noHwnd: { hasColor: true },
  };
  assert.strictEqual(windowHasColoredSession(sessions, 853852, "shell"), true);
  assert.strictEqual(windowHasColoredSession(sessions, 853852, "repo"), false);   // itself does not count
  assert.strictEqual(windowHasColoredSession(sessions, 999, "shell"), true);
  assert.strictEqual(windowHasColoredSession(sessions, 12345, "shell"), false);   // window with no sibling
  assert.strictEqual(windowHasColoredSession(sessions, null, "shell"), false);
  assert.strictEqual(windowHasColoredSession({}, 853852, "shell"), false);
  // hwnd may be a number here and a string there: compare as strings
  assert.strictEqual(windowHasColoredSession({ r: { hasColor: true, hwnd: "853852" } }, 853852, "x"), true);
});

test("coloredSessionHwnds: live repo siblings only, deduped, as strings", () => {
  const sessions = {
    repo: { hasColor: true, hwnd: 853852 },
    twin: { hasColor: true, hwnd: "853852" },
    shell: { hasColor: false, hwnd: 111 },
    other: { hasColor: true, hwnd: 999 },
    noHwnd: { hasColor: true },
  };
  assert.deepStrictEqual(coloredSessionHwnds(sessions, "shell"), ["853852", "999"]);
  assert.deepStrictEqual(coloredSessionHwnds(sessions, "repo"), ["853852", "999"]);
  assert.deepStrictEqual(coloredSessionHwnds({}, "x"), []);
});

test("only repo sessions write the frame color", () => {
  const args = { eventName: "SessionStart", platform: "win32", session: {}, frameHex: HEX, vtSignature: SIG };
  assert.strictEqual(decideEvent(Object.assign({}, args, { hasColor: true })).paintsFrame, true);
  assert.strictEqual(decideEvent(Object.assign({}, args, { hasColor: false })).paintsFrame, false);
});

test("reclaim: a repo session repaints a window a bare shell cleared", () => {
  const session = { hwnd: 853852, frameHex: HEX, vtSent: SIG };
  const held = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session, frameHex: HEX, vtSignature: SIG, hasColor: true, windowFrameCleared: true,
  });
  assert.strictEqual(held.spawnAdapter, true);   // takes its color back
  const settled = decideEvent({
    eventName: "UserPromptSubmit", platform: "win32",
    session, frameHex: HEX, vtSignature: SIG, hasColor: true, windowFrameCleared: false,
  });
  assert.strictEqual(settled.spawnAdapter, false);   // steady prompt path stays spawn-free
});

// -- A tab the user named is the third identity source, below git and a tag. --
test("usableWindowTitle: takes a real tab name, refuses everything else", () => {
  assert.strictEqual(usableWindowTitle("intraday"), "intraday");
  assert.strictEqual(usableWindowTitle("  Speech  "), "Speech");
  assert.strictEqual(usableWindowTitle("two\u0007words"), "two words");
  assert.strictEqual(usableWindowTitle(""), null);
  assert.strictEqual(usableWindowTitle("   "), null);
  assert.strictEqual(usableWindowTitle(null), null);
  assert.strictEqual(usableWindowTitle(undefined), null);
  assert.strictEqual(usableWindowTitle("x".repeat(41)), null, "prompt text is not a name");
  assert.strictEqual(usableWindowTitle("aura · master"), null, "aura's own title never feeds back");
  assert.strictEqual(usableWindowTitle("✳ fix the thing"), null, "an agent status line is not a name");
  assert.strictEqual(usableWindowTitle("✳ continue"), null, "a short repeated prompt would otherwise settle");
  assert.strictEqual(usableWindowTitle("C:" + String.fromCharCode(92) + "Users"), null, "a path is not a name");
  assert.strictEqual(usableWindowTitle("~/hippo"), null, "a path is not a name");
  assert.strictEqual(usableWindowTitle("Windows PowerShell"), null, "a shell default names no project");
  assert.strictEqual(usableWindowTitle("cmd.exe"), null);
});

test("settleWindowName: a title is a name only after two prompts read it the same", () => {
  const first = settleWindowName(undefined, "intraday");
  assert.deepStrictEqual(first, { probe: "intraday", name: null }, "one read decides nothing");
  assert.deepStrictEqual(settleWindowName("intraday", "intraday"), { probe: null, name: "intraday" });
  // Claude Code rewrites its title every prompt, so the second read moves.
  assert.deepStrictEqual(settleWindowName("Speech cron paused", "fix the ring"), { probe: null, name: "" });
  assert.deepStrictEqual(settleWindowName("intraday", null), { probe: null, name: "" });
  assert.deepStrictEqual(settleWindowName(undefined, null), { probe: null, name: "" }, "no title, no second look");
});

test("no repo: a named window carries the color, a plain folder still does not", () => {
  const named = identityFrom({ gitCombined: null, cwd: "C:/Users/skf_s", windowTitle: "intraday" });
  assert.strictEqual(named.repoId, "window:intraday");
  assert.strictEqual(named.name, "intraday");
  assert.strictEqual(named.isRepo, false, "a window title is not a repo");
  assert.strictEqual(named.hasColor, true);
  assert.strictEqual(named.fromWindowTitle, true);

  const bare = identityFrom({ gitCombined: null, cwd: "C:/Users/skf_s", windowTitle: "" });
  assert.strictEqual(bare.hasColor, false);
  assert.strictEqual(bare.fromWindowTitle, false);
});

test("a tab named after a repo does not steal that repo's color", () => {
  const tab = identityFrom({ gitCombined: null, cwd: "C:/tmp", windowTitle: "aura" });
  const repo = identityFrom({ gitCombined: "C:/Users/skf_s/aura\nmaster", remoteUrl: null, cwd: "C:/Users/skf_s/aura" });
  assert.notStrictEqual(tab.repoId, repo.repoId);
});

test("git outranks the window title, and both outrank cwd", () => {
  const id = identityFrom({
    gitCombined: "C:/Users/skf_s/aura\nmaster", remoteUrl: null,
    cwd: "C:/Users/skf_s", windowTitle: "intraday",
  });
  assert.strictEqual(id.name, "aura");
  assert.strictEqual(id.isRepo, true);
  assert.strictEqual(id.fromWindowTitle, false);
});
