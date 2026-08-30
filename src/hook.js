#!/usr/bin/env node
"use strict";
// aura hook entry, fired by Claude Code on SessionStart and UserPromptSubmit.
// Must never block a prompt: every failure path still exits 0 (rule 6), and the
// per-prompt path spawns no PowerShell (rule 5) - the DWM frame color persists
// on the window, so a repaint only happens when the color changed or no HWND
// is cached yet.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { colorsFor } = require("./color.js");
const { identityFrom, decideEvent } = require("./decide.js");
const { writeToTerminal } = require("./tty.js");
const { readState, writeState, pruneStale, stateFile, isProcessAlive } = require("./state.js");

const ESC = "\u001b";
const BEL = "\u0007";
const PROMPT_SNIPPET_LEN = 60;
// 256-color palette slot aura redefines to carry the exact tab RGB, then
// points the tab at it via DECAC. MEASURED 2026-08-30 on WT stable: slot 200
// + DECAC works (tab turns the exact color); the extended slot 262 from
// PR #13058 recolors the PANE BACKGROUND on this build - do not use it.
// Cost: TUI apps see 256-color index 200 as the repo color; acceptable.
const TAB_COLOR_SLOT = 200;

function runGit(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd].concat(args), {
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim() || null;
  } catch (err) {
    return null;
  }
}

// I/O side of identity: one git spawn on the hot path (root + branch
// together); the remote URL is stable per root, so it is cached in state and
// looked up at most once. Precedence itself lives in decide.js.
function resolveIdentity(cwd, state) {
  const combined = runGit(cwd, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]);
  let remoteUrl = null;
  if (combined) {
    const root = combined.split(/\r?\n/)[0];
    const remotes = state.remotes || (state.remotes = {});
    if (!(root in remotes)) {
      remotes[root] = runGit(cwd, ["config", "--get", "remote.origin.url"]);
    }
    remoteUrl = remotes[root];
  }
  return identityFrom({ gitCombined: combined, remoteUrl, cwd });
}

// Prompt text lands inside an escape sequence: strip control bytes so it can
// never terminate or inject a sequence of its own.
function sanitizeForTitle(text) {
  return String(text).replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

function buildEscapes(colors, title) {
  let out = `${ESC}]11;${colors.tintHex}${BEL}`;
  const hex = colors.frameHex;
  if (process.env.WT_SESSION) {
    const r = hex.slice(1, 3);
    const g = hex.slice(3, 5);
    const b = hex.slice(5, 7);
    out += `${ESC}]4;${TAB_COLOR_SLOT};rgb:${r}/${g}/${b}${BEL}`;
    out += `${ESC}[2;15;${TAB_COLOR_SLOT},|`;
  } else if (process.env.TERM_PROGRAM === "iTerm.app") {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    out += `${ESC}]6;1;bg;red;brightness;${r}${BEL}`;
    out += `${ESC}]6;1;bg;green;brightness;${g}${BEL}`;
    out += `${ESC}]6;1;bg;blue;brightness;${b}${BEL}`;
  }
  out += `${ESC}]0;${title}${BEL}`;
  return out;
}

function paintFrame(frameHex, cachedHwnd, vtPayload, vtDelay) {
  if (process.platform !== "win32") return null;
  // A foreground handshake is only safe when this session lives in a terminal
  // the user launched (WT_SESSION is inherited from the Windows Terminal tab).
  // Headless runs (cron, Task Scheduler, claude -p from a service) have no
  // WT_SESSION; grabbing the foreground window there would paint an unrelated
  // window. A cached HWND is always safe to repaint.
  if (!cachedHwnd && !process.env.WT_SESSION) return null;
  const adapter = path.join(__dirname, "adapters", "frame-win.ps1");
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", adapter,
    "-FrameColor", frameHex.slice(1),
  ];
  if (cachedHwnd) args.push("-Hwnd", String(cachedHwnd));
  // Windows hooks get their own hidden console (measured), so the direct
  // CONOUT$ write above lands nowhere visible; the adapter re-delivers the
  // escapes into the tab's real console via ancestor AttachConsole. With
  // vtDelay, the adapter instead hands its live-resolved attach targets to a
  // detached hidden writer that fires after Claude Code's TUI init - the
  // ancestry walk must run NOW, while this process still anchors the chain.
  if (vtPayload) {
    args.push("-VtB64", Buffer.from(vtPayload, "utf8").toString("base64"));
    if (vtDelay) {
      args.push("-VtDelayMs", String(vtDelay.ms));
      args.push("-StateFile", stateFile());
      args.push("-SessionId", vtDelay.sessionId);
    }
  }
  try {
    const out = execFileSync("powershell.exe", args, {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).toString().trim();
    const hwnd = parseInt(out, 10);
    return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
  } catch (err) {
    return null;
  }
}

// Background hue-cycle loop for non-repo windows (PRD post-MVP 1). The loop
// polices its own exit (window gone, 12 h cap, or a repo session taking frame
// ownership). MUST be launched via Start-Process, not spawned directly: the
// hook's whole process tree is cleaned up when the hook exits (measured
// 2026-08-30 - a node child_process.spawn survives ~1 s, unref or not), and
// Start-Process breaks the loop out of that tree with its own hidden console.
// Same survival pattern as frame-win.ps1's delayed VT writer. -PassThru hands
// back the grandchild pid for the state.rainbowPid dedup. Sync cost ~400 ms,
// paid only when a non-repo session has no live loop.
function startRainbow(hwnd) {
  const adapter = path.join(__dirname, "adapters", "rainbow-win.ps1");
  const launch = "(Start-Process -PassThru -WindowStyle Hidden powershell.exe -ArgumentList " +
    "'-NoProfile','-ExecutionPolicy','Bypass','-File','" + adapter + "'," +
    "'-Hwnd','" + String(hwnd) + "','-StateFile','" + stateFile() + "').Id";
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", launch], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).toString().trim();
    const pid = parseInt(out, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (err) {
    return null;
  }
}

function main() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch (err) { /* no stdin */ }
  let event = {};
  try { event = JSON.parse(raw); } catch (err) { /* not JSON */ }

  const cwd = event.cwd || process.cwd();
  const sessionId = event.session_id || "unknown";
  const state = readState();
  const identity = resolveIdentity(cwd, state);
  const colors = colorsFor({ repoId: identity.repoId, branch: identity.branch });

  const titleParts = [identity.name];
  if (identity.branch) titleParts.push(identity.branch);
  if (event.prompt) titleParts.push(sanitizeForTitle(event.prompt).slice(0, PROMPT_SNIPPET_LEN));
  const escapes = buildEscapes(colors, titleParts.join(" · "));
  // Direct tty write: the visible path where the hook shares the terminal's
  // console (POSIX /dev/tty). On Windows it lands in the hook's own hidden
  // console (harmless); the adapter spawn below is the visible delivery there.
  const ttyTarget = writeToTerminal(escapes);

  const session = state.sessions[sessionId] || {};
  session.tty = ttyTarget;
  // The what-to-do call is pure (decide.js documents the why of each rule);
  // everything below just executes the plan.
  const plan = decideEvent({
    eventName: event.hook_event_name,
    platform: process.platform,
    session,
    frameHex: colors.frameHex,
    isRepo: identity.isRepo,
  });
  if (plan.clearHandshake) {
    delete session.hwnd;
    delete session.vtHex;
  }
  let painted = false;
  if (plan.spawnAdapter) {
    const vtDelay = plan.vtDelayMs > 0 ? { ms: plan.vtDelayMs, sessionId } : null;
    const hwnd = paintFrame(colors.frameHex, plan.cachedHwnd, escapes, vtDelay);
    if (hwnd) {
      session.hwnd = hwnd;
      painted = true;
      if (plan.markVtHex) session.vtHex = colors.frameHex;
    }
  }
  // Frame ownership + rainbow lifecycle, both keyed by HWND (tabs share the
  // window frame; two non-repo tabs must share ONE loop, and a repo paint
  // must be able to stop it). Non-repo sessions mark the window "rainbow" and
  // keep a loop alive on it; repo sessions record ownership on every paint,
  // which the loop sees before its next write and exits.
  if (session.hwnd) {
    const hwndKey = String(session.hwnd);
    if (plan.wantsRainbow) {
      const owners = state.frameOwner || (state.frameOwner = {});
      owners[hwndKey] = "rainbow";
      const loops = state.rainbowPid || (state.rainbowPid = {});
      if (!isProcessAlive(loops[hwndKey])) {
        const pid = startRainbow(session.hwnd);
        if (pid) loops[hwndKey] = pid;
      }
    } else if (process.platform === "win32" && painted) {
      const owners = state.frameOwner || (state.frameOwner = {});
      owners[hwndKey] = sessionId;
    }
  }
  session.repoId = identity.repoId;
  session.branch = identity.branch;
  session.frameHex = colors.frameHex;
  if (event.prompt) session.lastPrompt = sanitizeForTitle(event.prompt).slice(0, 200);
  session.updatedAt = new Date().toISOString();
  state.sessions[sessionId] = session;
  pruneStale(state);
  writeState(state);
}

try { main(); } catch (err) { /* rule 6: fail silent */ }
process.exit(0);
