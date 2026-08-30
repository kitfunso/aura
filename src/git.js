"use strict";
// The git probe. Lives outside hook.js so tests can drive it against real repos.
const { execFileSync } = require("child_process");
const { identityFrom } = require("./decide.js");

// The output decides, never the exit code: rev-parse exits 128 on a repo with
// no commits yet, but still prints a valid toplevel on stdout.
function runGit(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd].concat(args), {
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim() || null;
  } catch (err) {
    const partial = err && err.stdout ? err.stdout.toString().trim() : "";
    return partial || null;
  }
}

// One git spawn on the hot path; the remote URL is cached per repo root.
function resolveIdentity(cwd, state, recheckNullRemote) {
  const combined = runGit(cwd, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]);
  let remoteUrl = null;
  if (combined) {
    const root = combined.split(/\r?\n/)[0];
    const remotes = state.remotes || (state.remotes = {});
    // Recheck nulls at session start only: a repo that gains an origin remote
    // must stop using its path color, but the prompt path stays at one spawn.
    if (!(root in remotes) || (recheckNullRemote && remotes[root] === null)) {
      remotes[root] = runGit(cwd, ["config", "--get", "remote.origin.url"]);
    }
    remoteUrl = remotes[root];
  }
  return identityFrom({ gitCombined: combined, remoteUrl, cwd });
}

module.exports = { runGit, resolveIdentity };
