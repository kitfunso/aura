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
const { writeToTerminal } = require("./tty.js");
const { readState, writeState, pruneStale } = require("./state.js");

const ESC = "\u001b";
const BEL = "\u0007";
const PROMPT_SNIPPET_LEN = 60;
// Windows Terminal extended palette slot for the tab (frame) background,
// per microsoft/terminal PR #13058. See ARCHITECTURE.md Known Risks.
const TAB_COLOR_SLOT = 262;

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

// Identity: origin remote URL > repo root path > cwd (outside any repo).
// One git spawn on the hot path (root + branch together); the remote URL is
// stable per root, so it is cached in state and looked up at most once.
function resolveIdentity(cwd, state) {
  const combined = runGit(cwd, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]);
  if (!combined) {
    const normalized = path.resolve(cwd);
    return { repoId: normalized, branch: null, name: path.basename(normalized) };
  }
  const lines = combined.split(/\r?\n/);
  const root = lines[0];
  const branch = lines[1] || null;
  const remotes = state.remotes || (state.remotes = {});
  if (!(root in remotes)) {
    remotes[root] = runGit(cwd, ["config", "--get", "remote.origin.url"]);
  }
  return { repoId: remotes[root] || root, branch, name: path.basename(root) };
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

function paintFrame(frameHex, cachedHwnd) {
  if (process.platform !== "win32") return null;
  const adapter = path.join(__dirname, "adapters", "frame-win.ps1");
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", adapter,
    "-FrameColor", frameHex.slice(1),
  ];
  if (cachedHwnd) args.push("-Hwnd", String(cachedHwnd));
  try {
    const out = execFileSync("powershell.exe", args, {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    const hwnd = parseInt(out, 10);
    return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
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
  writeToTerminal(buildEscapes(colors, titleParts.join(" · ")));

  const session = state.sessions[sessionId] || {};
  if (!session.hwnd || session.frameHex !== colors.frameHex) {
    const hwnd = paintFrame(colors.frameHex, session.hwnd || null);
    if (hwnd) session.hwnd = hwnd;
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
