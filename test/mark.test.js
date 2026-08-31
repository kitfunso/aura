"use strict";
// The tab color is the one escape that can redefine a palette entry, so its
// slot is pinned here: a slot inside 0-255 would repaint text somebody prints.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildEscapes, mark } = require("../src/mark.js");

const ESC = "\u001b";
const BEL = "\u0007";
const COLORS = { tintHex: "#161d2d", frameHex: "#2662d9" };

function tabSlots(out) {
  return out.split(ESC + "]4;").slice(1).map(function (part) {
    return Number(part.split(";")[0]);
  });
}

test("the tab color carries the exact frame RGB on Windows Terminal", () => {
  const out = buildEscapes(COLORS, "aura", true, { WT_SESSION: "1" });
  const slots = tabSlots(out);
  assert.strictEqual(slots.length, 1, "exactly one palette slot is redefined");
  assert.ok(out.includes(ESC + "]4;" + slots[0] + ";rgb:26/62/d9" + BEL),
    "the frame hex goes into that slot");
  assert.ok(out.includes(ESC + "[2;15;" + slots[0] + ",|"),
    "DECAC selects that same slot");
});

test("the tab color never redefines an index text can be printed in", () => {
  const out = buildEscapes(COLORS, "aura", true, { WT_SESSION: "1" });
  tabSlots(out).forEach(function (slot) {
    assert.ok(slot > 255, "slot " + slot + " is inside the 256-color text palette");
  });
});

test("a terminal aura cannot color gets the title and nothing else", () => {
  assert.strictEqual(buildEscapes(COLORS, "aura", true, {}),
    ESC + "]11;#161d2d" + BEL + ESC + "]0;aura" + BEL);
  assert.strictEqual(buildEscapes(COLORS, "aura", false, { WT_SESSION: "1" }),
    ESC + "]0;aura" + BEL);
});

test("an empty title writes no title escape, so a named window keeps its name", () => {
  const out = buildEscapes(COLORS, "", true, { WT_SESSION: "1" });
  assert.ok(!out.includes(ESC + "]0;"), "no OSC 0 when there is no title to set");
  assert.ok(out.includes(ESC + "]11;#161d2d" + BEL), "the tint still lands");
  assert.strictEqual(buildEscapes(COLORS, "", false, {}), "", "no color and no title is no output");
});

test("leaving a repo gives back every color the coloring branch set", () => {
  const WT = { WT_SESSION: "1" };
  const colored = buildEscapes(COLORS, "aura", true, WT);
  const back = buildEscapes(COLORS, "", false, WT, true);
  tabSlots(colored).forEach(function (slot) {
    assert.ok(back.includes(ESC + "]104;" + slot + BEL),
      "slot " + slot + " is set but never reset");
  });
  assert.ok(colored.includes(ESC + "]11;"), "the coloring branch sets a background");
  assert.ok(back.includes(ESC + "]111" + BEL), "OSC 111 puts the background back");
});

test("the slot an older build leaked is cleared whether or not aura colors now", () => {
  const WT = { WT_SESSION: "1" };
  const legacy = ESC + "]104;200" + BEL;
  assert.ok(buildEscapes(COLORS, "aura", true, WT).includes(legacy),
    "a colored window still repairs the slot 0.1.0 owned");
  assert.ok(buildEscapes(COLORS, "", false, WT, true).includes(legacy),
    "so does one going back to no color");
});

test("a terminal aura never colored keeps the colors the user configured", () => {
  const WT = { WT_SESSION: "1" };
  assert.strictEqual(buildEscapes(COLORS, "", false, WT, false), "",
    "no restore without a color to undo");
  assert.strictEqual(buildEscapes(COLORS, "aura", false, WT, false), ESC + "]0;aura" + BEL,
    "the title still lands on its own");
});

test("the restore only touches palette slots on a terminal that has them", () => {
  const back = buildEscapes(COLORS, "", false, {}, true);
  assert.strictEqual(back, ESC + "]111" + BEL, "off Windows Terminal, the background only");
});

test("the restore reaches the terminal, because it changes the delivery signature", () => {
  const WT = { WT_SESSION: "1" };
  assert.notStrictEqual(buildEscapes(COLORS, "", true, WT),
    buildEscapes(COLORS, "", false, WT, true),
    "a cached signature would swallow a restore identical to the paint");
  assert.notStrictEqual(buildEscapes(COLORS, "", false, WT, true), "",
    "an empty restore would never be delivered at all");
});

// No terminal marker, so mark() never spawns the adapter at a real window.
function markIn(cwd, sessionId, stateHome) {
  const env = { LOCALAPPDATA: stateHome, XDG_STATE_HOME: stateHome };
  const saved = [process.env.LOCALAPPDATA, process.env.XDG_STATE_HOME];
  process.env.LOCALAPPDATA = stateHome;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    return mark({ cwd, sessionId, eventName: "prompt", env, redeliverVt: false }).escapes;
  } finally {
    process.env.LOCALAPPDATA = saved[0];
    process.env.XDG_STATE_HOME = saved[1];
  }
}

test("a session that walks out of a repo hands the terminal back exactly once", () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aura-back-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aura-repo-"));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "aura-plain-"));
  execFileSync("git", ["-C", repo, "init", "--initial-branch", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "--allow-empty", "-m", "x"], { stdio: "ignore" });
  try {
    const inRepo = markIn(repo, "walker", stateHome);
    assert.ok(inRepo.includes(ESC + "]11;"), "the repo prompt sets a background");
    assert.ok(!inRepo.includes(ESC + "]111" + BEL), "and does not undo it in the same breath");

    const leaving = markIn(plain, "walker", stateHome);
    assert.ok(leaving.includes(ESC + "]111" + BEL), "leaving puts the background back");

    assert.ok(!markIn(plain, "walker", stateHome).includes(ESC + "]111" + BEL),
      "the next prompt in the same plain folder has nothing left to give back");
    assert.ok(!markIn(plain, "newcomer", stateHome).includes(ESC + "]111" + BEL),
      "a session aura never colored is left alone");
  } finally {
    [stateHome, repo, plain].forEach(function (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});
