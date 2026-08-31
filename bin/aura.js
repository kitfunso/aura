#!/usr/bin/env node
"use strict";
// The agent-neutral entry point: whoever knows the working directory changed
// calls "aura mark". Unlike the hook it prints escapes on stdout, because its
// caller owns a visible console. Design: docs/ARCHITECTURE.md.
const { mark } = require("../src/mark.js");

const USAGE = [
  "usage: aura mark [--cwd <dir>] [--session <id>] [--title <text>]",
  "",
  "  mark   print the escape sequences for <dir>, and paint the window frame.",
  "         The caller writes what is printed to its own terminal.",
].join("\n");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function commandMark() {
  const result = mark({
    cwd: argValue("--cwd") || process.cwd(),
    // The shell's pid outlives every command it runs, and dies with the window.
    sessionId: argValue("--session") || "shell-" + process.ppid,
    eventName: "prompt",
    promptText: argValue("--title"),
    sink: function () { return "stdout"; },
    redeliverVt: false,
  });
  process.stdout.write(result.escapes);
}

const command = process.argv[2];
if (command === "mark") {
  // Rule 6: this runs on a prompt path, so a broken aura prints nothing.
  try { commandMark(); } catch (err) { /* fail silent */ }
  process.exit(0);
}
console.error(USAGE);
process.exit(command === "--help" || command === "-h" ? 0 : 1);
