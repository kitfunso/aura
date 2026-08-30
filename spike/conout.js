// Spike 1: can a process inside Claude Code's process tree reach the live terminal?
// Writes OSC 11 (background tint) + OSC 0 (title) to the console device, NOT stdout.
// stdout is reserved for the machine-readable result.
const fs = require("fs");

const TINT = "#1a1230"; // dark violet, aura's own folder color for this demo
const seq =
  "\x1b]11;" + TINT + "\x07" +
  "\x1b]0;aura spike | did this window tint violet?\x07";

const targets = process.platform === "win32" ? ["\\\\.\\CONOUT$", "CONOUT$"] : ["/dev/tty"];
let delivered = null;
const errors = [];
for (const target of targets) {
  try {
    const fd = fs.openSync(target, "w");
    fs.writeSync(fd, seq);
    fs.closeSync(fd);
    delivered = target;
    break;
  } catch (err) {
    errors.push(target + ": " + err.message);
  }
}
console.log(JSON.stringify({ delivered, errors }));
process.exit(0);
