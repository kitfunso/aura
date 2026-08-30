"use strict";
// Writes escape bytes to the LIVE terminal device, never stdout (rule 3:
// Claude Code captures hook stdout as model context).
const fs = require("fs");

function writeToTerminal(text) {
  const targets = process.platform === "win32"
    ? ["\\\\.\\CONOUT$", "CONOUT$"]
    : ["/dev/tty"];
  for (const target of targets) {
    let fd = null;
    try {
      fd = fs.openSync(target, "w");
      fs.writeSync(fd, text);
      return target;
    } catch (err) {
      // fall through to the next device path
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (err) { /* already closed */ }
      }
    }
  }
  return null;
}

module.exports = { writeToTerminal };
