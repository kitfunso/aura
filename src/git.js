"use strict";
// The git probe. Lives outside hook.js so tests can drive it against real repos.
const { execFileSync } = require("child_process");
const { identityFrom } = require("./decide.js");

const GIT_TIMEOUT_MS = 1500;
// A spawn we killed said nothing. git exiting 128 IS an answer, and so is a
// missing git, so only this case may keep the identity a window already has.
const NO_ANSWER = Object.freeze({ noAnswer: true });

// The output decides, never the exit code: rev-parse exits 128 on a repo with
// no commits yet, but still prints a valid toplevel on stdout.
function runGit(cwd, args, timeoutMs) {
  try {
    return execFileSync("git", ["-C", cwd].concat(args), {
      timeout: timeoutMs || GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim() || null;
  } catch (err) {
    const partial = err && err.stdout ? err.stdout.toString().trim() : "";
    if (partial) return partial;
    const killed = err && (err.code === "ETIMEDOUT" || err.signal === "SIGTERM");
    return killed ? NO_ANSWER : null;
  }
}

// One git spawn on the hot path; the remote URL is cached per repo root.
function resolveIdentity(cwd, state, recheckNullRemote, windowTitle, timeoutMs) {
  const combined = runGit(cwd, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], timeoutMs);
  // Reading silence as "not a repo" is what strips a colored window on a slow box.
  if (combined === NO_ANSWER) return { unresolved: true };
  let remoteUrl = null;
  if (combined) {
    const root = combined.split(/\r?\n/)[0];
    const remotes = state.remotes || (state.remotes = {});
    // Recheck nulls at session start only: a repo that gains an origin remote
    // must stop using its path color, but the prompt path stays at one spawn.
    if (!(root in remotes) || (recheckNullRemote && remotes[root] === null)) {
      const found = runGit(cwd, ["config", "--get", "remote.origin.url"], timeoutMs);
      if (found === NO_ANSWER) return { unresolved: true };
      remotes[root] = found;
    }
    remoteUrl = remotes[root];
  }
  // The caller persists remoteUrl under root: without it every prompt pays a
  // second git spawn to re-learn the same URL.
  return Object.assign(identityFrom({ gitCombined: combined, remoteUrl, cwd, windowTitle }), { remoteUrl });
}

module.exports = { runGit, resolveIdentity };
