# Wraps the current prompt instead of replacing it, so posh-git, oh-my-posh and
# Starship keep working. Emitted by "aura shell-init", which fills the CLI path.
$global:AuraCli = "__AURA_CLI__"

# Start second, because Windows recycles pids well inside the 48h state window.
if (-not $global:AuraSession) {
    $global:AuraSession = "shell-" + $PID + "-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}

# Re-wrap when something else took the prompt; a plain re-source is a no-op.
if ($null -eq $function:prompt -or $function:prompt.ToString() -notmatch 'aura-prompt') {
    $global:AuraPrevPrompt = $function:prompt
    $global:AuraLastPath = ""
}

function global:prompt {
    # aura-prompt
    try {
        $auraPath = $PWD.ProviderPath
        if ($auraPath -ne $global:AuraLastPath) {
            $global:AuraLastPath = $auraPath
            $auraOut = & node $global:AuraCli mark --write --cwd $auraPath --session $global:AuraSession
            if ($auraOut) { [Console]::Write(($auraOut -join "")) }
        }
    } catch { }
    if ($global:AuraPrevPrompt) { & $global:AuraPrevPrompt } else { "PS " + $PWD.ProviderPath + "> " }
}
