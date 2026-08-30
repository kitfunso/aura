"use strict";
// bin/install.js exercised through its CLI against --settings targets in a
// temp directory. The installer writes the user's whole hook config (rule 4),
// so merge, backup, idempotency, and refusal behavior are tested here, not
// trusted from inspection. This was the top testing gap in the 2026-08-30
// review (all I/O orchestration untested).
const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const INSTALLER = path.join(__dirname, "..", "bin", "install.js");

function runInstaller(args, allowFailure) {
  try {
    execFileSync(process.execPath, [INSTALLER].concat(args), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (err) {
    if (!allowFailure) throw err;
    return err.status;
  }
}

// try/finally instead of t.after: works on every node >= 18.
function withSettings(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-install-"));
  try {
    const file = path.join(dir, "settings.json");
    if (contents !== undefined) fs.writeFileSync(file, contents);
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PRE_AURA = JSON.stringify({
  model: "opus",
  permissions: { allow: ["Read"] },
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node other-tool.js" }] }] },
}, null, 2);

function auraGroups(settings, eventName) {
  const groups = (settings.hooks && settings.hooks[eventName]) || [];
  return groups.filter(function (g) {
    return (g.hooks || []).some(function (h) {
      return String(h.command).indexOf("aura/src/hook.js") !== -1;
    });
  });
}

test("install merges both hook events and preserves everything else", () => {
  withSettings(PRE_AURA, (file) => {
    runInstaller(["--settings", file]);
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(auraGroups(settings, "SessionStart").length, 1);
    assert.strictEqual(auraGroups(settings, "UserPromptSubmit").length, 1);
    assert.strictEqual(settings.model, "opus");
    assert.deepStrictEqual(settings.permissions, { allow: ["Read"] });
    assert.strictEqual(settings.hooks.SessionStart.length, 2);   // the other tool's hook survives
    assert.strictEqual(fs.readFileSync(file + ".aura-bak", "utf8"), PRE_AURA);
    assert.strictEqual(fs.existsSync(file + ".aura-tmp"), false);   // atomic temp never survives
  });
});

test("reinstall is idempotent: file byte-identical after a second run", () => {
  withSettings(PRE_AURA, (file) => {
    runInstaller(["--settings", file]);
    const afterFirst = fs.readFileSync(file, "utf8");
    runInstaller(["--settings", file]);
    assert.strictEqual(fs.readFileSync(file, "utf8"), afterFirst);
  });
});

test("uninstall removes only aura's groups", () => {
  withSettings(PRE_AURA, (file) => {
    runInstaller(["--settings", file]);
    runInstaller(["--settings", file, "--uninstall"]);
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(auraGroups(settings, "SessionStart").length, 0);
    assert.strictEqual(auraGroups(settings, "UserPromptSubmit").length, 0);
    assert.strictEqual(settings.hooks.SessionStart.length, 1);   // the other tool stays
    assert.strictEqual(settings.model, "opus");
  });
});

test("backup keeps the FIRST pre-aura copy across install/uninstall cycles", () => {
  withSettings(PRE_AURA, (file) => {
    runInstaller(["--settings", file]);
    runInstaller(["--settings", file, "--uninstall"]);
    runInstaller(["--settings", file]);
    assert.strictEqual(fs.readFileSync(file + ".aura-bak", "utf8"), PRE_AURA);
  });
});

test("invalid JSON: exit 1, file untouched, no backup written", () => {
  withSettings("{not json", (file) => {
    assert.strictEqual(runInstaller(["--settings", file], true), 1);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{not json");
    assert.strictEqual(fs.existsSync(file + ".aura-bak"), false);
  });
});

test("missing settings file: exit 1", () => {
  withSettings(undefined, (file) => {
    assert.strictEqual(runInstaller(["--settings", file], true), 1);
  });
});
