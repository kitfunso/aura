"use strict";
// Pure decision core: identity precedence and the per-event action plan,
// computed from injected inputs only. No fs, no child processes, no Win32 -
// hook.js owns all I/O and feeds results in; Lane B lifts this unchanged
// (rule 2 applies here exactly as it does to color.js).
const path = require("path");

// Identity precedence: origin remote URL > repo root path > cwd.
// gitCombined is the raw `git rev-parse --show-toplevel --abbrev-ref HEAD`
// output (root on line 1, branch on line 2), or null outside any repo.
function identityFrom({ gitCombined, remoteUrl, cwd }) {
  if (!gitCombined) {
    const normalized = path.resolve(cwd);
    return { repoId: normalized, branch: null, name: path.basename(normalized), isRepo: false };
  }
  const lines = gitCombined.split(/\r?\n/);
  const root = lines[0];
  const branch = lines[1] || null;
  return { repoId: remoteUrl || root, branch, name: path.basename(root), isRepo: true };
}

// What the hook should do for one event.
// - SessionStart (open, resume, clear) may land the session in a brand-new
//   tab or window: the cached handle and delivery mark are dropped so the
//   session re-handshakes and re-delivers where it lives NOW.
// - vtHex only marks from prompt events. An immediate SessionStart write
//   races Claude Code's TUI init and gets wiped (measured 2026-08-30), so
//   session-start delivery goes through the delayed writer and the first
//   prompt re-delivers once as the backstop, then never again.
// - Non-repo windows route to the rainbow loop; repo paints own the frame.
function decideEvent({ eventName, platform, session, frameHex, isRepo }) {
  const isPrompt = eventName === "UserPromptSubmit";
  const clearHandshake = !isPrompt;
  const cachedHwnd = clearHandshake ? null : session.hwnd || null;
  const cachedVtHex = clearHandshake ? undefined : session.vtHex;
  const needsFrame = !cachedHwnd || session.frameHex !== frameHex;
  const needsVt = platform === "win32" && cachedVtHex !== frameHex;
  return {
    isPrompt,
    clearHandshake,
    cachedHwnd,
    spawnAdapter: needsFrame || needsVt,
    vtDelayMs: isPrompt ? 0 : 2000,
    markVtHex: isPrompt && needsVt,
    wantsRainbow: platform === "win32" && !isRepo,
  };
}

module.exports = { identityFrom, decideEvent };
