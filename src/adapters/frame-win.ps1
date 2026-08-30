# aura frame adapter, Windows 11 build 22000+.
# First paint: no -Hwnd given. Takes GetForegroundWindow() (the window the user
#   just typed in) and paints it ONLY if it belongs to an allowlisted terminal
#   process, so an alt-tab race can never paint another app.
# Repaint: -Hwnd <n> reuses the cached handle, no foreground lookup.
# Prints the painted HWND as a decimal integer on stdout, or 0 if nothing was painted.
param(
    [Parameter(Mandatory=$true)][string]$FrameColor,  # RRGGBB, no leading #
    [long]$Hwnd = 0
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AuraFrame {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
}
"@

$allowedProcs = @("WindowsTerminal", "OpenConsole", "conhost", "wezterm-gui", "alacritty", "ghostty")

$target = [IntPtr]::Zero
if ($Hwnd -ne 0) {
    $target = [IntPtr]$Hwnd
} else {
    $fg = [AuraFrame]::GetForegroundWindow()
    $procId = [uint32]0
    [void][AuraFrame]::GetWindowThreadProcessId($fg, [ref]$procId)
    $procName = ""
    try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    if ($allowedProcs -contains $procName) { $target = $fg }
}

if ($target -eq [IntPtr]::Zero) {
    Write-Output "0"
    exit 0
}

# COLORREF is 0x00BBGGRR.
$r = [Convert]::ToInt32($FrameColor.Substring(0, 2), 16)
$g = [Convert]::ToInt32($FrameColor.Substring(2, 2), 16)
$b = [Convert]::ToInt32($FrameColor.Substring(4, 2), 16)
$colorref = ($b -shl 16) -bor ($g -shl 8) -bor $r
[void][AuraFrame]::DwmSetWindowAttribute($target, 34, [ref]$colorref, 4)  # DWMWA_BORDER_COLOR
[void][AuraFrame]::DwmSetWindowAttribute($target, 35, [ref]$colorref, 4)  # DWMWA_CAPTION_COLOR
Write-Output ("" + [int64]$target)
