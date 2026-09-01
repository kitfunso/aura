"use strict";
// "aura install" through the real CLI, against --settings targets in a temp
// dir. It writes the user's whole hook config (rule 4), so nothing here is
// trusted from inspection.
const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { restoreThisTerminal, bashProfile, isAuraCommand } = require("../src/install.js");
const { restoreEscapes } = require("../src/mark.js");

const CLI = path.join(__dirname, "..", "bin", "aura.js");

function runInstaller(args, allowFailure) {
  try {
    execFileSync(process.execPath, [CLI, "install"].concat(args), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (err) {
    if (!allowFailure) throw err;
    return err.status;
  }
}

function runUninstaller(args) {
  execFileSync(process.execPath, [CLI, "uninstall"].concat(args), {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    return (g.hooks || []).some(function (h) { return isAuraCommand(h.command); });
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
    runUninstaller(["--settings", file]);
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
    runUninstaller(["--settings", file]);
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

const PRE_PROFILE = "Set-Alias ll Get-ChildItem\n\nfunction prompt { 'mine> ' }\n";

function withProfile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-profile-"));
  try {
    const file = path.join(dir, "profile.ps1");
    if (contents !== undefined) fs.writeFileSync(file, contents);
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("shell install appends a marked block and leaves the profile above it alone", () => {
  withProfile(PRE_PROFILE, (file) => {
    runInstaller(["--shell", "powershell", "--profile", file]);
    const after = fs.readFileSync(file, "utf8");
    assert.ok(after.startsWith(PRE_PROFILE), "the user's own profile stays first, byte for byte");
    assert.ok(after.includes("# >>> aura >>>") && after.includes("# <<< aura <<<"));
    assert.ok(after.includes("aura-prompt"), "the wrapped prompt is in the block");
    assert.strictEqual(after.indexOf("__AURA_CLI__"), -1, "the CLI path is substituted");
    assert.strictEqual(fs.readFileSync(file + ".aura-bak", "utf8"), PRE_PROFILE);
    assert.strictEqual(fs.existsSync(file + ".aura-tmp"), false);
  });
});

test("re-running the shell install replaces the block instead of stacking blocks", () => {
  withProfile(PRE_PROFILE, (file) => {
    runInstaller(["--shell", "powershell", "--profile", file]);
    const afterFirst = fs.readFileSync(file, "utf8");
    runInstaller(["--shell", "powershell", "--profile", file]);
    const afterSecond = fs.readFileSync(file, "utf8");
    assert.strictEqual(afterSecond, afterFirst);
    assert.strictEqual(afterSecond.split("# >>> aura >>>").length - 1, 1);
  });
});

test("shell uninstall leaves the rest of the profile byte-identical", () => {
  withProfile(PRE_PROFILE, (file) => {
    runInstaller(["--shell", "powershell", "--profile", file]);
    runUninstaller(["--shell", "powershell", "--profile", file]);
    assert.strictEqual(fs.readFileSync(file, "utf8"), PRE_PROFILE);
  });
});

test("shell install creates a profile that does not exist yet", () => {
  withProfile(undefined, (file) => {
    runInstaller(["--shell", "powershell", "--profile", file]);
    const after = fs.readFileSync(file, "utf8");
    assert.ok(after.startsWith("# >>> aura >>>"));
    assert.strictEqual(fs.existsSync(file + ".aura-bak"), false, "nothing existed to back up");
  });
});

test("bash and zsh get the posix snippet, and an unknown shell exits 1", () => {
  withProfile("export PATH=$PATH\n", (file) => {
    runInstaller(["--shell", "bash", "--profile", file]);
    assert.ok(fs.readFileSync(file, "utf8").includes("aura_mark_cwd"));
    assert.strictEqual(runInstaller(["--shell", "fish", "--profile", file], true), 1);
  });
});

// Rule 11 at the uninstall seam: the bytes handed to the terminal are the same
// undo the prompt path builds, and a write that fails still lets uninstall pass.
test("uninstall gives the terminal back exactly what the restore builds", () => {
  const written = [];
  restoreThisTerminal(function (text) { written.push(text); });
  assert.deepStrictEqual(written, [restoreEscapes(process.env)]);
  assert.ok(written[0].indexOf("]111") !== -1, "the background is in it");
  assert.doesNotThrow(function () {
    restoreThisTerminal(function () { throw new Error("no terminal here"); });
  }, "an uninstall with no terminal to write to still succeeds");
});

const FOREIGN_HOOK = 'node "/opt/aura-main/src/hook.js"';

test("aura recognises its own hook whatever the folder is called", () => {
  assert.ok(isAuraCommand(FOREIGN_HOOK), "a zip unpacked as aura-main is still aura");
  assert.ok(isAuraCommand('node "/x/node_modules/@kitfunso/aura/src/hook.js"'), "the npm layout");
  assert.ok(isAuraCommand("node /home/k/aura/src/hook.js"), "an unquoted command");
  assert.ok(!isAuraCommand('node "/opt/othertool/src/hook.js"'), "another tool's hook is not ours");
  assert.ok(!isAuraCommand("node other-tool.js"), "and neither is an unrelated command");
});

test("a hook installed from a differently named folder is not duplicated, and uninstalls", () => {
  const pre = JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: FOREIGN_HOOK }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: FOREIGN_HOOK }] }],
    },
  }, null, 2);
  withSettings(pre, (file) => {
    runInstaller(["--settings", file]);
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(settings.hooks.SessionStart.length, 1, "no second aura hook is added");
    runUninstaller(["--settings", file]);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(auraGroups(after, "SessionStart").length, 0, "uninstall finds it");
    assert.strictEqual(auraGroups(after, "UserPromptSubmit").length, 0);
  });
});

function withFakePlatform(platform, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aura-home-"));
  const saved = [process.platform, process.env.HOME, process.env.USERPROFILE];
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn(home);
  } finally {
    Object.defineProperty(process, "platform", { value: saved[0], configurable: true });
    if (saved[1] === undefined) delete process.env.HOME; else process.env.HOME = saved[1];
    if (saved[2] === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved[2];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// A macOS terminal starts a LOGIN shell, and a login shell never reads .bashrc.
test("on macOS bash installs into a login-shell profile, not .bashrc", () => {
  withFakePlatform("darwin", (home) => {
    assert.strictEqual(bashProfile(), path.join(home, ".bash_profile"), "none present: create .bash_profile");
    fs.writeFileSync(path.join(home, ".profile"), "");
    assert.strictEqual(bashProfile(), path.join(home, ".profile"), "an existing .profile is used");
    fs.writeFileSync(path.join(home, ".bash_profile"), "");
    assert.strictEqual(bashProfile(), path.join(home, ".bash_profile"), ".bash_profile wins");
  });
});

test("on linux bash still installs into .bashrc", () => {
  withFakePlatform("linux", (home) => {
    assert.strictEqual(bashProfile(), path.join(home, ".bashrc"));
  });
});
