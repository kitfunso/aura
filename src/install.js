"use strict";
// Wires aura into the two things that can call it: Claude Code's hooks, and a
// shell profile. Rule 4: back up first, merge, NEVER overwrite. Flags:
// --settings <path>, --shell <name>, --profile <path>.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { shellSnippet, SHELLS } = require("./shell/init.js");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const SETTINGS_FILE = argValue("--settings") || path.join(os.homedir(), ".claude", "settings.json");
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit"];
const BLOCK_OPEN = "# >>> aura >>>";
const BLOCK_CLOSE = "# <<< aura <<<";

// Forward slashes work in every shell Claude Code uses to run hook commands.
const hookScript = path.resolve(__dirname, "hook.js").replace(/\\/g, "/");
const hookCommand = 'node "' + hookScript + '"';
const cli = path.resolve(__dirname, "..", "bin", "aura.js");

function backUpOnce(file, raw) {
  // Only the first run writes the backup: it holds the pre-aura content.
  if (!fs.existsSync(file + ".aura-bak")) fs.writeFileSync(file + ".aura-bak", raw);
}

function writeAtomic(file, contents) {
  // A crash mid-write must never truncate the file we were asked to preserve.
  const tmp = file + ".aura-tmp";
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

function isAuraGroup(group) {
  return Array.isArray(group.hooks) && group.hooks.some(function (h) {
    return typeof h.command === "string" && h.command.indexOf("aura/src/hook.js") !== -1;
  });
}

function installHooks(uninstall) {
  if (!fs.existsSync(SETTINGS_FILE)) {
    console.error("aura: " + SETTINGS_FILE + " not found. Is Claude Code installed?");
    process.exit(1);
  }
  const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    console.error("aura: " + SETTINGS_FILE + " is not valid JSON; refusing to touch it.");
    process.exit(1);
  }
  backUpOnce(SETTINGS_FILE, raw);

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  let changed = false;
  for (const eventName of HOOK_EVENTS) {
    const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const hasAura = groups.some(isAuraGroup);
    if (uninstall && hasAura) {
      settings.hooks[eventName] = groups.filter(function (g) { return !isAuraGroup(g); });
      changed = true;
    } else if (!uninstall && !hasAura) {
      groups.push({ hooks: [{ type: "command", command: hookCommand }] });
      settings.hooks[eventName] = groups;
      changed = true;
    }
  }

  if (changed) writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  const action = uninstall ? "removed from" : "installed into";
  console.log("aura: " + (changed ? action : "no change needed in") + " " + SETTINGS_FILE);
  console.log("aura: backup at " + SETTINGS_FILE + ".aura-bak");
  if (changed && !uninstall) {
    console.log("aura: colors appear in NEW Claude Code sessions (existing sessions keep their old hook config).");
  }
}

function powershellProfile() {
  // PowerShell knows where its own profile is; Documents is often redirected.
  const out = execFileSync("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$PROFILE"]).toString().trim();
  if (!out) throw new Error("powershell.exe did not report a profile path");
  return out;
}

function profileFor(shell) {
  const explicit = argValue("--profile");
  if (explicit) return explicit;
  if (shell === "powershell") return powershellProfile();
  if (shell === "zsh") return path.join(os.homedir(), ".zshrc");
  return path.join(os.homedir(), ".bashrc");
}

function withoutAuraBlock(text) {
  const open = text.indexOf(BLOCK_OPEN);
  if (open === -1) return text;
  const close = text.indexOf(BLOCK_CLOSE, open);
  if (close === -1) return text;
  const before = text.slice(0, open).replace(/\n+$/, "");
  const after = text.slice(close + BLOCK_CLOSE.length).replace(/^\n+/, "");
  if (!before) return after;
  if (!after) return before + "\n";
  return before + "\n\n" + after;
}

function installShell(shell, uninstall) {
  let file;
  try {
    file = profileFor(shell);
  } catch (err) {
    console.error("aura: could not find the " + shell + " profile. Pass --profile <path>.");
    process.exit(1);
  }
  const existed = fs.existsSync(file);
  if (!existed && uninstall) {
    console.log("aura: no change needed in " + file);
    return;
  }
  const raw = existed ? fs.readFileSync(file, "utf8") : "";
  if (existed) backUpOnce(file, raw);

  const stripped = withoutAuraBlock(raw);
  let next = stripped;
  if (!uninstall) {
    const snippet = shellSnippet(shell, cli);
    const block = BLOCK_OPEN + "\n" + snippet.replace(/\n+$/, "") + "\n" + BLOCK_CLOSE + "\n";
    next = stripped ? stripped.replace(/\n*$/, "\n\n") + block : block;
  }
  if (next === raw) {
    console.log("aura: no change needed in " + file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, next);
  console.log("aura: " + (uninstall ? "removed from " : "installed into ") + file);
  if (existed) console.log("aura: backup at " + file + ".aura-bak");
  if (!uninstall) console.log("aura: colors appear in NEW shells. Open a terminal in a repo to see it.");
}

function run(uninstall) {
  const shell = argValue("--shell");
  if (shell) {
    if (SHELLS.indexOf(shell) === -1) {
      console.error("aura: unknown shell " + shell + ". Known: " + SHELLS.join(", "));
      process.exit(1);
    }
    installShell(shell, uninstall);
    return;
  }
  installHooks(uninstall);
}

module.exports = { run };
