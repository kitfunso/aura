#!/usr/bin/env node
"use strict";
// aura hook entry, fired by Claude Code on SessionStart and UserPromptSubmit.
// Never blocks a prompt (rule 6) and never writes escapes to stdout (rule 3),
// which is why the sink here is the tty device. Design: docs/ARCHITECTURE.md.
const fs = require("fs");
const { mark } = require("./mark.js");
const { writeToTerminal } = require("./tty.js");

function main() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch (err) { /* no stdin */ }
  let event = {};
  try { event = JSON.parse(raw); } catch (err) { /* not JSON */ }

  mark({
    cwd: event.cwd || process.cwd(),
    sessionId: event.session_id || "unknown",
    eventName: event.hook_event_name,
    promptText: event.prompt,
    sink: writeToTerminal,
    // On Windows this write lands in the hook's own hidden console, so the
    // adapter has to repeat the escapes into the tab's real console.
    redeliverVt: true,
  });
}

try { main(); } catch (err) { /* rule 6: fail silent */ }
process.exit(0);
