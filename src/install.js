"use strict";
// Wires aura into the two things that can call it: Claude Code's hooks, and a
// shell profile. Rule 4: back up first, merge, NEVER overwrite. Flags:
// --settings <path>, --shell <name>, --profile <path>.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { shellSnippet, SHELLS } = require("./shell/init.js");
const { restoreEscapes } = require("./mark.js");
const { writeToTerminal } = require("./tty.js");

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

// Identity is the script the command runs, never the folder a user happened to
// name: a GitHub zip unpacks to aura-main, and that is still aura.
function isAuraCommand(command) {
  if (typeof command !== "string") return false;
  const quoted = command.match(/"([^"]+)"/);
  const script = (quoted ? quoted[1] : command.replace(/^\s*\S+\s+/, "")).replace(/\\/g, "/").trim();
  if (!/\/src\/hook\.js$/.test(script)) return false;
  return script === hookScript || /(^|\/)aura[^/]*\/src\/hook\.js$/i.test(script);
}

function isAuraGroup(group) {
  return Array.isArray(group.hooks) && group.hooks.some(function (h) {
    return isAuraCommand(h.command);
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

// macOS terminals start bash as a LOGIN shell, and a login shell reads
// .bash_profile and never .bashrc (GNU bash manual, "Bash Startup Files").
function bashProfile() {
  const home = os.homedir();
  if (process.platform !== "darwin") return path.join(home, ".bashrc");
  const found = [".bash_profile", ".bash_login", ".profile"]
    .map(function (name) { return path.join(home, name); })
    .filter(function (file) { return fs.existsSync(file); });
  return found[0] || path.join(home, ".bash_profile");
}

function profileFor(shell) {
  const explicit = argValue("--profile");
  if (explicit) return explicit;
  if (shell === "powershell") return powershellProfile();
  if (shell === "zsh") return path.join(os.homedir(), ".zshrc");
  return bashProfile();
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

// Taking aura out leaves the window wearing aura's colors, and the code that
// could give them back is what is being removed.
function restoreThisTerminal(write) {
  try { write(restoreEscapes(process.env)); }
  catch (err) { /* an uninstall with no terminal to write to still succeeds */ }
}

function run(uninstall) {
  if (uninstall) restoreThisTerminal(writeToTerminal);
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

module.exports = { run, restoreThisTerminal, bashProfile, isAuraCommand };
