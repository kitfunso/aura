# Stands in for a real shell session: an existing prompt, a source, two cds,
# and a second source to prove the wrap guard holds. Driven by shell.test.js.
param(
    [Parameter(Mandatory=$true)][string]$Snippet,
    [Parameter(Mandatory=$true)][string]$RepoA,
    [Parameter(Mandatory=$true)][string]$RepoB,
    [Parameter(Mandatory=$true)][string]$StateHome,
    [Parameter(Mandatory=$true)][string]$OutFile
)
$ErrorActionPreference = "Stop"
$env:LOCALAPPDATA = $StateHome
$env:XDG_STATE_HOME = $StateHome

function global:prompt { "ORIGINAL> " }

. $Snippet
Set-Location -LiteralPath $RepoA
$null = prompt
$null = prompt
. $Snippet
Set-Location -LiteralPath $RepoB
$null = prompt

$result = New-Object PSObject -Property @{
    promptText = (prompt)
    lastPath = $global:AuraLastPath
    wrapCount = ([regex]::Matches($function:prompt.ToString(), "aura-prompt")).Count
}
$result | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $OutFile
