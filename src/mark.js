"use strict";
// The whole colouring operation, with no opinion about who called it. Callers
// differ only in where the escapes go and whether the adapter must repeat them.
// Rules and measurements: docs/ARCHITECTURE.md.
const path = require("path");
const { execFileSync } = require("child_process");
const { colorsFor, fnv1a } = require("./color.js");
const {
  identityFrom, usableWindowTitle, settleWindowName, isPromptEvent, decideEvent,
  hasTerminalMarker, windowHasColoredSession, coloredSessionHwnds,
} = require("./decide.js");
const { resolveIdentity } = require("./git.js");
const { readState, updateState, stateFile } = require("./state.js");

const ESC = "\u001b";
const BEL = "\u0007";
const PROMPT_SNIPPET_LEN = 60;
// Palette slot redefined to carry the tab RGB, then selected with DECAC. It sits
// above 255 so aura never repaints an index text can be printed in.
const TAB_COLOR_SLOT = 264;
// Slot 200 was that slot until 0.1.1 and was never given back, so a window an
// older build painted keeps a wrong text color for the life of its tab.
const LEGACY_TAB_SLOT = 200;

// Prompt text lands inside an escape sequence: strip control bytes so it can
// never terminate or inject a sequence of its own.
function sanitizeForTitle(text) {
  return String(text).replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

// The undo for every color the set branch below writes. OSC 111 and OSC 104
// land the terminal back on the user's own configured colors, not aura's last.
function restoreEscapes(env) {
  let out = `${ESC}]111${BEL}`;
  if (env.WT_SESSION) {
    out += `${ESC}]104;${TAB_COLOR_SLOT}${BEL}`;
    out += `${ESC}]104;${LEGACY_TAB_SLOT}${BEL}`;
  } else if (env.TERM_PROGRAM === "iTerm.app") {
    out += `${ESC}]6;1;bg;*;default${BEL}`;
  }
  return out;
}

// wasColored is the previous run's answer: aura restores only what it set, so a
// terminal it never touched keeps whatever colors the user configured.
function buildEscapes(colors, title, usesColor, env, wasColored) {
  // Sanitizing here, not per input: this is the only place text enters an
  // escape, so a directory named with a BEL byte cannot end the sequence early.
  const safe = sanitizeForTitle(title);
  const titleEscape = safe ? `${ESC}]0;${safe}${BEL}` : "";
  if (!usesColor) return (wasColored ? restoreEscapes(env) : "") + titleEscape;
  // Clearing the old slot on the way past is what repairs an already-wrong tab.
  let out = env.WT_SESSION ? `${ESC}]104;${LEGACY_TAB_SLOT}${BEL}` : "";
  out += `${ESC}]11;${colors.tintHex}${BEL}`;
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
  return out + titleEscape;
}

// The tab's own name, read through the same allowlist the frame paint uses. The
// cached handle is preferred: the foreground window may belong to another tab.
function queryWindowTitle(env, cachedHwnd) {
  if (process.platform !== "win32") return null;
  if (!cachedHwnd && !hasTerminalMarker(env)) return null;
  const adapter = path.join(__dirname, "adapters", "frame-win.ps1");
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", adapter,
    "-FrameColor", "000000", "-QueryTitle",
  ];
  if (cachedHwnd) args.push("-Hwnd", String(cachedHwnd));
  try {
    return execFileSync("powershell.exe", args, {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).toString().trim() || null;
  } catch (err) {
    return null;
  }
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
      args.push("-VtSig", vtDelay.sig);
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
  sink = () => null, redeliverVt = true, gitTimeoutMs,
}) {
  // Only a snapshot for identity and the decision; nothing here reaches disk.
  const state = readState() || { sessions: {} };
  // A tag outranks cwd, which carries no project when an agent was launched
  // from a home folder.
  const pinned = (state.tags || {})[sessionId];
  const session = state.sessions[sessionId] || {};
  // A tag is an explicit answer, so a tagged session never reads its tab name.
  const windowName = pinned ? null : session.windowName || null;
  let identity = resolveIdentity(pinned || cwd, state, eventName === "SessionStart", windowName, gitTimeoutMs);
  // git said nothing, so this prompt says nothing: no escapes, no paint, no write.
  if (identity.unresolved) return { identity, colors: null, escapes: "", hwnd: session.hwnd || null };
  if (!identity.hasColor && !pinned && session.windowName === undefined && isPromptEvent(eventName)) {
    const found = usableWindowTitle(queryWindowTitle(env, session.hwnd));
    const settled = settleWindowName(session.windowProbe, found);
    if (settled.probe) session.windowProbe = settled.probe;
    else {
      delete session.windowProbe;
      session.windowName = settled.name;
    }
    // git already answered null here, so the name settles it with no second spawn.
    if (session.windowName) identity = identityFrom({ gitCombined: null, cwd, windowTitle: session.windowName });
  }
  const colors = colorsFor({ repoId: identity.repoId, branch: identity.branch });

  const titleParts = [identity.name];
  if (identity.branch) titleParts.push(identity.branch);
  if (promptText) titleParts.push(sanitizeForTitle(promptText).slice(0, PROMPT_SNIPPET_LEN));
  // Writing a title over an identity we READ from that title renames it, and
  // the rename would move the color on the next prompt.
  const title = identity.fromWindowTitle ? "" : titleParts.join(" · ");
  const wasColored = session.hasColor === true;
  const escapes = buildEscapes(colors, title, identity.hasColor, env, wasColored);
  // The signature covers what was delivered, not just its color, so any change
  // to the escapes re-delivers. The title is out: it moves every prompt.
  const vtSignature = fnv1a(buildEscapes(colors, "", identity.hasColor, env, wasColored)).toString(36);

  // A caller that writes to a visible console has already delivered them, so
  // caching here is what keeps the adapter off that caller's prompt path.
  if (!redeliverVt) session.vtSent = vtSignature;
  session.tty = sink(escapes);

  const owners = state.frameOwner || {};
  const plan = decideEvent({
    eventName,
    platform: process.platform,
    session,
    frameHex: colors.frameHex,
    vtSignature,
    hasColor: identity.hasColor,
    windowFrameCleared: Boolean(session.hwnd && owners[String(session.hwnd)] === "cleared"),
  });
  if (plan.clearHandshake) {
    delete session.hwnd;
    delete session.vtSent;
    delete session.frameCleared;
  }
  let painted = false;
  let cleared = false;
  if (plan.spawnAdapter) {
    const vtDelay = plan.vtDelayMs > 0 ? { ms: plan.vtDelayMs, sessionId, sig: vtSignature } : null;
    // The adapter re-checks the list: the window it resolves may not be cached yet.
    const mode = plan.paintsFrame ? { name: "paint" }
      : plan.resetFrame ? { name: "reset", skipHwnds: coloredSessionHwnds(state.sessions, sessionId) }
      : { name: "none" };
    const payload = redeliverVt ? escapes : null;
    const hwnd = paintFrame(colors.frameHex, plan.cachedHwnd, payload, vtDelay, mode, env);
    if (hwnd) {
      session.hwnd = hwnd;
      // Ownership follows the color write, not the handle lookup.
      painted = plan.paintsFrame;
      cleared = mode.name === "reset" &&
        !windowHasColoredSession(state.sessions, hwnd, sessionId);
      if (cleared) session.frameCleared = true;
      if (plan.markVtSent && redeliverVt) session.vtSent = vtSignature;
    }
  }
  session.repoId = identity.repoId;
  session.branch = identity.branch;
  // repoId is a path either way, so it cannot tell a colored session from a bare one.
  session.isRepo = identity.isRepo;
  session.hasColor = identity.hasColor;
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

module.exports = { mark, buildEscapes, restoreEscapes, sanitizeForTitle };
