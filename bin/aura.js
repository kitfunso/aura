#!/usr/bin/env node
"use strict";
// The agent-neutral entry point: whoever knows the working directory changed
// calls "aura mark". Unlike the hook it may print escapes on stdout, because
// its caller owns a visible console. Design: docs/ARCHITECTURE.md.
const { mark } = require("../src/mark.js");
const { writeToTerminal } = require("../src/tty.js");
const { shellSnippet, SHELLS } = require("../src/shell/init.js");
const {
  sessionKey, readTag, writeTag, resolveTarget, inTerminalSession,
} = require("../src/tag.js");

const USAGE = [
  "usage: aura mark [--write] [--cwd <dir>] [--session <id>] [--title <text>]",
  "       aura tag [<dir>] [--clear] [--session <id>]",
  "       aura install [--shell powershell|bash|zsh] [--settings <path>] [--profile <path>]",
  "       aura uninstall [same flags as install]",
  "       aura shell-init [--shell powershell|bash|zsh]",
  "",
  "  mark        print the escape sequences for <dir>, and paint the window frame.",
  "              --write sends them to the terminal device instead, falling back",
  "              to stdout when that device is not reachable.",
  "  tag         color this session as <dir> instead of the working directory,",
  "              for an agent launched somewhere that names no project. It paints",
  "              the window at once, so an agent with no prompt hook still gets a",
  "              color. With no argument it prints the tag. --clear goes to cwd.",
  "  install     with --shell, wire that shell's prompt. Without it, register the",
  "              Claude Code hooks in ~/.claude/settings.json.",
  "  uninstall   take back out what install put in.",
  "  shell-init  print the prompt snippet to source from a shell profile.",
].join("\n");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function commandMark() {
  const toTerminal = process.argv.indexOf("--write") !== -1;
  let ttyTarget = null;
  const result = mark({
    cwd: argValue("--cwd") || process.cwd(),
    // The pid alone is not unique for long: the shell snippets add a start second.
    sessionId: argValue("--session") || "shell-" + process.ppid,
    eventName: "prompt",
    promptText: argValue("--title"),
    sink: function (escapes) {
      if (toTerminal) ttyTarget = writeToTerminal(escapes);
      return ttyTarget || "stdout";
    },
    redeliverVt: false,
  });
  if (!ttyTarget) process.stdout.write(result.escapes);
}

function commandShellInit() {
  // macOS has shipped zsh as the login shell since Catalina.
  const shell = argValue("--shell") || (process.platform === "win32" ? "powershell"
    : process.platform === "darwin" ? "zsh" : "bash");
  const snippet = shellSnippet(shell, __filename);
  if (!snippet) {
    console.error("aura: unknown shell " + shell + ". Known: " + SHELLS.join(", "));
    process.exit(1);
  }
  process.stdout.write(snippet);
}

// A full-screen agent has no prompt to fire after this, so the tag would sit in
// state unread. The escapes ride the adapter, the way a hook's do.
function paintTagged(sessionId) {
  if (!inTerminalSession(process.env)) return;
  try {
    mark({
      cwd: process.cwd(),
      sessionId,
      eventName: "prompt",
      sink: writeToTerminal,
      redeliverVt: true,
    });
  } catch (err) { /* the tag is written; a failed paint must not fail the CLI */ }
}

function commandTag() {
  const id = sessionKey(process.env, argValue("--session"));
  const clear = process.argv.indexOf("--clear") !== -1;
  const target = process.argv[3] && process.argv[3].charAt(0) !== "-" ? process.argv[3] : null;
  if (!target && !clear) {
    const current = readTag(id);
    console.log(id + ": " + (current || "no tag, using the working directory"));
    return 0;
  }
  const resolved = clear ? null : resolveTarget(target, process.cwd());
  if (!clear && !resolved) {
    console.error("aura: no such directory: " + target);
    return 1;
  }
  if (!writeTag(id, resolved)) {
    console.error("aura: state file is busy, nothing written");
    return 1;
  }
  paintTagged(id);
  console.log(clear ? id + ": tag cleared" : id + ": tagged " + resolved);
  return 0;
}

const command = process.argv[2];
if (command === "mark") {
  // Rule 6: this runs on a prompt path, so a broken aura prints nothing.
  try { commandMark(); } catch (err) { /* fail silent */ }
  process.exit(0);
}
if (command === "tag") {
  process.exit(commandTag());
}
if (command === "shell-init") {
  commandShellInit();
  process.exit(0);
}
if (command === "install" || command === "uninstall") {
  require("../src/install.js").run(command === "uninstall");
  process.exit(0);
}
console.error(USAGE);
process.exit(command === "--help" || command === "-h" ? 0 : 1);
