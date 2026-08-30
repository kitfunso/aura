# aura rainbow adapter, Windows 11 build 22000+.
# Detached hue-cycle loop for non-repo sessions: every tick advance the hue and
# repaint the DWM border + caption of one handshook HWND. Spawned hidden by
# hook.js, at most one loop per HWND (state.rainbowPid, keyed by HWND so two
# non-repo tabs in one window share ONE loop).
# Exit conditions, all enforced in-loop:
#   1. IsWindow(hwnd) fails (window closed).
#   2. MaxHours cap (runaway guard; the hook respawns on the next prompt).
#   3. Another owner: state.frameOwner[hwnd] is a session id, not "rainbow"
#      (a repo session painted this window - its color must hold).
#   4. A newer loop took over: state.rainbowPid[hwnd] is some other pid.
# The ownership re-read happens IMMEDIATELY before every DWM write, with no
# sleep between check and write - a once-per-tick check earlier in the loop
# leaves a blind spot that flashes over a repo session's paint.
param(
    [Parameter(Mandatory=$true)][long]$Hwnd,
    [string]$StateFile = "",
    [int]$TickMs = 2000,
    [double]$HueStep = 12,
    [int]$MaxHours = 12
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AuraRainbow {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
}
"@

function Convert-HsvToRgb([double]$h, [double]$s, [double]$v) {
    $c = $v * $s
    $hp = ($h % 360) / 60
    $x = $c * (1 - [Math]::Abs(($hp % 2) - 1))
    switch ([int][Math]::Floor($hp)) {
        0 { $rgb = @($c, $x, 0) }
        1 { $rgb = @($x, $c, 0) }
        2 { $rgb = @(0, $c, $x) }
        3 { $rgb = @(0, $x, $c) }
        4 { $rgb = @($x, 0, $c) }
        default { $rgb = @($c, 0, $x) }
    }
    $m = $v - $c
    return @(
        [int](($rgb[0] + $m) * 255),
        [int](($rgb[1] + $m) * 255),
        [int](($rgb[2] + $m) * 255)
    )
}

$target = [IntPtr]$Hwnd
$hwndKey = "$Hwnd"
$hue = 0.0
$deadline = (Get-Date).AddHours($MaxHours)

# Sleep-first: the spawning hook writes rainbowPid + frameOwner to state right
# after this process starts, and paints the identity color itself; the first
# cycle paint waits one tick so neither race matters.
while ($true) {
    Start-Sleep -Milliseconds $TickMs
    if ((Get-Date) -gt $deadline) { break }
    if (-not [AuraRainbow]::IsWindow($target)) { break }
    if ($StateFile -ne "" -and (Test-Path -LiteralPath $StateFile)) {
        try {
            $state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
            $owner = $state.frameOwner.$hwndKey
            if ($owner -and $owner -ne "rainbow") { break }
            $loopPid = $state.rainbowPid.$hwndKey
            if ($loopPid -and [int]$loopPid -ne $PID) { break }
        } catch {}
    }
    $rgb = Convert-HsvToRgb $hue 0.75 0.85
    # COLORREF is 0x00BBGGRR.
    $colorref = ($rgb[2] -shl 16) -bor ($rgb[1] -shl 8) -bor $rgb[0]
    [void][AuraRainbow]::DwmSetWindowAttribute($target, 34, [ref]$colorref, 4)  # DWMWA_BORDER_COLOR
    [void][AuraRainbow]::DwmSetWindowAttribute($target, 35, [ref]$colorref, 4)  # DWMWA_CAPTION_COLOR
    $hue = ($hue + $HueStep) % 360
}
