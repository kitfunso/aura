# Spike 2: nonce-title handshake + DWM border/caption paint (Windows 11 22000+).
# Sets a unique console title, finds the top-level window carrying it,
# paints its border + title bar, restores the title. PS 5.1 compatible.
param([string]$ColorHex = "8A2BE2")
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AuraSpike {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
}
"@

$nonce = "aura-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$oldTitle = $Host.UI.RawUI.WindowTitle
$Host.UI.RawUI.WindowTitle = $nonce
Start-Sleep -Milliseconds 400
$hwnd = [AuraSpike]::FindWindowW($null, $nonce)
$Host.UI.RawUI.WindowTitle = $oldTitle

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output ("RESULT hwnd=0 nonce=" + $nonce + " : no visible window carries the nonce title. Process is likely detached from the visible terminal, or the tab title does not reach the window title.")
    exit 0
}

$r = [Convert]::ToInt32($ColorHex.Substring(0, 2), 16)
$g = [Convert]::ToInt32($ColorHex.Substring(2, 2), 16)
$b = [Convert]::ToInt32($ColorHex.Substring(4, 2), 16)
$colorref = ($b -shl 16) -bor ($g -shl 8) -bor $r   # COLORREF is 0x00BBGGRR

$rcBorder = [AuraSpike]::DwmSetWindowAttribute($hwnd, 34, [ref]$colorref, 4)   # DWMWA_BORDER_COLOR
$rcCaption = [AuraSpike]::DwmSetWindowAttribute($hwnd, 35, [ref]$colorref, 4)  # DWMWA_CAPTION_COLOR
Write-Output ("RESULT hwnd=" + $hwnd + " border_rc=" + $rcBorder + " caption_rc=" + $rcCaption + " (0 = S_OK)")
