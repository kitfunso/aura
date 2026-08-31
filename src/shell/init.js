"use strict";
// The snippets next to this file are data with one hole in them: the path of
// the CLI the shell should call. Both callers know it from their own location.
const fs = require("fs");
const path = require("path");

const SNIPPETS = { powershell: "powershell.ps1", bash: "posix.sh", zsh: "posix.sh" };

function shellSnippet(shell, cliPath) {
  if (!SNIPPETS[shell]) return null;
  const text = fs.readFileSync(path.join(__dirname, SNIPPETS[shell]), "utf8");
  // Forward slashes work in every shell these snippets target.
  return text.replace(/__AURA_CLI__/g, cliPath.replace(/\\/g, "/"));
}

module.exports = { shellSnippet, SHELLS: Object.keys(SNIPPETS) };
