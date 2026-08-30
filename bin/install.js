#!/usr/bin/env node
"use strict";
// aura installer: merges the SessionStart + UserPromptSubmit hook entries into
// ~/.claude/settings.json. Rule 4: back up first, merge, NEVER overwrite other
// settings. Idempotent: re-running adds nothing. --uninstall removes only
// aura's entries. --settings <path> targets a different file (testing the
// merge against a copy, non-standard setups).
const fs = require("fs");
const os = require("os");
const path = require("path");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const SETTINGS_FILE = argValue("--settings") || path.join(os.homedir(), ".claude", "settings.json");
const BACKUP_FILE = SETTINGS_FILE + ".aura-bak";
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit"];

// Forward slashes work in every shell Claude Code uses to run hook commands.
const hookScript = path.resolve(__dirname, "..", "src", "hook.js").replace(/\\/g, "/");
const hookCommand = 'node "' + hookScript + '"';

function isAuraGroup(group) {
  return Array.isArray(group.hooks) && group.hooks.some(function (h) {
    return typeof h.command === "string" && h.command.indexOf("aura/src/hook.js") !== -1;
  });
}

function main() {
  const uninstall = process.argv.indexOf("--uninstall") !== -1;

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

  // The backup exists to preserve the PRE-aura settings. Later runs (upgrade,
  // uninstall) must not clobber the only copy of that state with an
  // aura-present version, so only the first run writes it.
  if (!fs.existsSync(BACKUP_FILE)) fs.writeFileSync(BACKUP_FILE, raw);

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

  if (changed) {
    // settings.json carries the user's whole hook/permission config (rule 4):
    // a crash mid-write must never leave it truncated. Temp + rename is atomic
    // on the same volume.
    const tmp = SETTINGS_FILE + ".aura-tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
    fs.renameSync(tmp, SETTINGS_FILE);
  }
  const action = uninstall ? "removed from" : "installed into";
  console.log("aura: " + (changed ? action : "no change needed in") + " " + SETTINGS_FILE);
  console.log("aura: backup at " + BACKUP_FILE);
  if (changed && !uninstall) {
    console.log("aura: colors appear in NEW Claude Code sessions (existing sessions keep their old hook config).");
  }
}

main();
