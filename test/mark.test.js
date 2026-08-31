"use strict";
// The tab color is the one escape that can redefine a palette entry, so its
// slot is pinned here: a slot inside 0-255 would repaint text somebody prints.
const test = require("node:test");
const assert = require("node:assert");
const { buildEscapes } = require("../src/mark.js");

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
