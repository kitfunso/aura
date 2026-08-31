"use strict";
// The whole colouring operation, with no opinion about who called it. Callers
// differ only in where the escapes go and whether the adapter must repeat them.
// Rules and measurements: docs/ARCHITECTURE.md.
const path = require("path");
const { execFileSync } = require("child_process");
const { colorsFor } = require("./color.js");
const {
  decideEvent, hasTerminalMarker, windowHasRepoSession, repoSessionHwnds,
} = require("./decide.js");
const { resolveIdentity } = require("./git.js");
const { readState, updateState, stateFile } = require("./state.js");

const ESC = "\u001b";
const BEL = "\u0007";
const PROMPT_SNIPPET_LEN = 60;
// Palette slot redefined to carry the tab RGB, then selected with DECAC.
// Slot 262 recolors the pane background on Windows Terminal stable; keep 200.
const TAB_COLOR_SLOT = 200;

// Prompt text lands inside an escape sequence: strip control bytes so it can
// never terminate or inject a sequence of its own.
function sanitizeForTitle(text) {
  return String(text).replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

function buildEscapes(colors, title, usesColor, env) {
  if (!usesColor) return `${ESC}]0;${title}${BEL}`;
  let out = `${ESC}]11;${colors.tintHex}${BEL}`;
  const hex = colors.frameHex;
  if (env.WT_SESSION) {
    const r = hex.slice(1, 3);
    const g = hex.slice(3, 5);
    const b = hex.slice(5, 7);
    out += `${ESC}]4;${TAB_COLOR_SLOT};rgb:${r}/${g}/${b}${BEL}`;
    out += `${ESC}[2;15;${TAB_COLOR_SLOT},|`;
  } else if (env.TERM_PROGRAM === "iTerm.app") {
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

function paintFrame(frameHex, cachedHwnd, vtPayload, vtDelay, mode, env) {
  if (process.platform !== "win32") return null;
  // Without a terminal marker this is a headless run, where the foreground
  // window belongs to some unrelated app. A cached handle is always safe.
  if (!cachedHwnd && !hasTerminalMarker(env)) return null;
  const adapter = path.join(__dirname, "adapters", "frame-win.ps1");
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", adapter,
    "-FrameColor", frameHex.slice(1),
  ];
  if (cachedHwnd) args.push("-Hwnd", String(cachedHwnd));
  // Resolve the handle without writing a color a repo sibling may own.
  if (mode.name !== "paint") args.push("-NoPaint");
  if (mode.name === "reset") {
    args.push("-Reset");
    if (mode.skipHwnds.length) args.push("-SkipHwnds", mode.skipHwnds.join(","));
  }
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

// sink writes the escapes and returns a label for state. redeliverVt: the
// caller's console is hidden, so the adapter repeats them into the real one.
function mark({
  cwd, sessionId, eventName, promptText, env = process.env,
  sink = () => null, redeliverVt = true,
}) {
  // Only a snapshot for identity and the decision; nothing here reaches disk.
  const state = readState() || { sessions: {} };
  const identity = resolveIdentity(cwd, state, eventName === "SessionStart");
  const colors = colorsFor({ repoId: identity.repoId, branch: identity.branch });

  const titleParts = [identity.name];
  if (identity.branch) titleParts.push(identity.branch);
  if (promptText) titleParts.push(sanitizeForTitle(promptText).slice(0, PROMPT_SNIPPET_LEN));
  const escapes = buildEscapes(colors, titleParts.join(" · "), identity.isRepo, env);

  const session = state.sessions[sessionId] || {};
  // A caller that writes to a visible console has already delivered them, so
  // caching here is what keeps the adapter off that caller's prompt path.
  if (!redeliverVt) session.vtHex = colors.frameHex;
  session.tty = sink(escapes);

  const owners = state.frameOwner || {};
  const plan = decideEvent({
    eventName,
    platform: process.platform,
    session,
    frameHex: colors.frameHex,
    isRepo: identity.isRepo,
    windowFrameCleared: Boolean(session.hwnd && owners[String(session.hwnd)] === "cleared"),
  });
  if (plan.clearHandshake) {
    delete session.hwnd;
    delete session.vtHex;
    delete session.frameCleared;
  }
  let painted = false;
  let cleared = false;
  if (plan.spawnAdapter) {
    const vtDelay = plan.vtDelayMs > 0 ? { ms: plan.vtDelayMs, sessionId } : null;
    // The adapter re-checks the list: the window it resolves may not be cached yet.
    const mode = plan.paintsFrame ? { name: "paint" }
      : plan.resetFrame ? { name: "reset", skipHwnds: repoSessionHwnds(state.sessions, sessionId) }
      : { name: "none" };
    const payload = redeliverVt ? escapes : null;
    const hwnd = paintFrame(colors.frameHex, plan.cachedHwnd, payload, vtDelay, mode, env);
    if (hwnd) {
      session.hwnd = hwnd;
      // Ownership follows the color write, not the handle lookup.
      painted = plan.paintsFrame;
      cleared = mode.name === "reset" &&
        !windowHasRepoSession(state.sessions, hwnd, sessionId);
      if (cleared) session.frameCleared = true;
      if (plan.markVtHex && redeliverVt) session.vtHex = colors.frameHex;
    }
  }
  session.repoId = identity.repoId;
  session.branch = identity.branch;
  // repoId is a path either way, so it cannot tell a repo from a bare shell.
  session.isRepo = identity.isRepo;
  session.frameHex = colors.frameHex;
  if (promptText) session.lastPrompt = sanitizeForTitle(promptText).slice(0, 200);
  session.updatedAt = new Date().toISOString();
  // Only this session's entry is ours to write; the rest of the file belongs
  // to concurrent shells, so the delta goes onto a fresh read under a lock.
  updateState(function (fresh) {
    fresh.sessions[sessionId] = session;
    if (identity.root) (fresh.remotes || (fresh.remotes = {}))[identity.root] = identity.remoteUrl;
    // Ownership is keyed by HWND, because tabs share one frame.
    if (session.hwnd && process.platform === "win32") {
      const freshOwners = fresh.frameOwner || (fresh.frameOwner = {});
      const hwndKey = String(session.hwnd);
      if (painted) freshOwners[hwndKey] = sessionId;
      else if (cleared) freshOwners[hwndKey] = "cleared";
    }
  });
  return { identity, colors, escapes, hwnd: session.hwnd || null };
}

module.exports = { mark, buildEscapes, sanitizeForTitle };
