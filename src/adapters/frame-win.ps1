# aura frame adapter, Windows 11 build 22000+.
# First paint: no -Hwnd given. Takes GetForegroundWindow() (the window the user
#   just typed in) and paints it ONLY if it belongs to an allowlisted terminal
#   process, so an alt-tab race can never paint another app.
# Repaint: -Hwnd <n> reuses the cached handle, no foreground lookup.
# VT delivery: -VtB64 <base64 UTF-8 escape payload>. Claude Code spawns hooks
#   with their own hidden console (measured 2026-08-30: the hook's CONOUT$ write
#   succeeds but is invisible), so the payload is written by attaching to the
#   TOPMOST console-attached ancestor - that is the tab's real console. GUI
#   ancestors (WindowsTerminal, explorer) refuse AttachConsole and are skipped.
# Prints the painted HWND as a decimal integer on stdout FIRST (the VT step
#   detaches the console and must not disturb the result protocol), or 0.
param(
    [Parameter(Mandatory=$true)][string]$FrameColor,  # RRGGBB, no leading #
    [long]$Hwnd = 0,
    [string]$VtB64 = ""
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AuraFrame {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll")] static extern bool WriteFile(IntPtr h, byte[] buf, uint n, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    public static bool WriteVt(uint pid, byte[] bytes) {
        FreeConsole();
        if (!AttachConsole(pid)) { return false; }
        IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) { FreeConsole(); return false; }
        uint mode;
        if (GetConsoleMode(h, out mode)) { SetConsoleMode(h, mode | 0x4); }
        uint written;
        bool ok = WriteFile(h, bytes, (uint)bytes.Length, out written, IntPtr.Zero);
        CloseHandle(h);
        FreeConsole();
        return ok;
    }
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

if ($target -ne [IntPtr]::Zero) {
    # COLORREF is 0x00BBGGRR.
    $r = [Convert]::ToInt32($FrameColor.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($FrameColor.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($FrameColor.Substring(4, 2), 16)
    $colorref = ($b -shl 16) -bor ($g -shl 8) -bor $r
    [void][AuraFrame]::DwmSetWindowAttribute($target, 34, [ref]$colorref, 4)  # DWMWA_BORDER_COLOR
    [void][AuraFrame]::DwmSetWindowAttribute($target, 35, [ref]$colorref, 4)  # DWMWA_CAPTION_COLOR
    Write-Output ("" + [int64]$target)
} else {
    Write-Output "0"
}

if ($VtB64 -ne "") {
    try {
        $bytes = [Convert]::FromBase64String($VtB64)
        # One bulk pid->ppid query, then walk this process's ancestry.
        $parentOf = @{}
        foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId) {
            $parentOf[[uint32]$p.ProcessId] = [uint32]$p.ParentProcessId
        }
        $chain = @()
        $cur = [uint32]$PID
        for ($i = 0; $i -lt 12; $i++) {
            if (-not $parentOf.ContainsKey($cur)) { break }
            $up = $parentOf[$cur]
            if ($up -eq 0 -or -not $parentOf.ContainsKey($up)) { break }
            $chain += $up
            $cur = $up
        }
        # Topmost first: the highest attachable ancestor owns the tab console;
        # nearer ancestors (the hook's own node/cmd) hold the hidden one.
        [array]::Reverse($chain)
        foreach ($ancestor in $chain) {
            if ([AuraFrame]::WriteVt($ancestor, $bytes)) { break }
        }
    } catch {}
}
