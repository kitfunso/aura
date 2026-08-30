"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { colorsFor } = require("../src/color.js");

const HIPPO = "https://github.com/kitfunso/hippo.git";
const AURA = "https://github.com/kitfunso/aura.git";

function channels(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

test("deterministic: same input, same output, every call", () => {
  const a = colorsFor({ repoId: HIPPO, branch: "main" });
  const b = colorsFor({ repoId: HIPPO, branch: "main" });
  assert.deepEqual(a, b);
});

test("different repos get different hues", () => {
  const hues = new Set(
    [HIPPO, AURA, "C:/Users/skf_s/quantamental", "C:/Users/skf_s/btlab"].map(
      (repoId) => colorsFor({ repoId, branch: "main" }).hue
    )
  );
  assert.equal(hues.size, 4);
});

test("same repo, different branch: same hue, different shade and frame", () => {
  const main = colorsFor({ repoId: HIPPO, branch: "main" });
  const feature = colorsFor({ repoId: HIPPO, branch: "feat/scope-isolation" });
  assert.equal(main.hue, feature.hue);
  assert.notEqual(main.shadeIndex, feature.shadeIndex);
  assert.notEqual(main.frameHex, feature.frameHex);
});

test("main, master, and null branch all map to shade 0", () => {
  for (const branch of ["main", "master", null, undefined, ""]) {
    assert.equal(colorsFor({ repoId: HIPPO, branch }).shadeIndex, 0);
  }
});

test("non-repo session: cwd identity works, no shade", () => {
  const home = colorsFor({ repoId: "C:/Users/skf_s", branch: null });
  assert.equal(home.shadeIndex, 0);
  assert.match(home.tintHex, /^#[0-9a-f]{6}$/);
  assert.match(home.frameHex, /^#[0-9a-f]{6}$/);
});

test("tint stays in the dark readable band for every shade", () => {
  for (const branch of ["main", "a", "bb", "ccc"]) {
    const { tintHex } = colorsFor({ repoId: HIPPO, branch });
    for (const value of channels(tintHex)) {
      assert.ok(value < 80, `channel ${value} too bright in ${tintHex} (branch ${branch})`);
    }
  }
});
