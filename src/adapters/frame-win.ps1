# aura frame adapter, Windows 11 build 22000+. Paints one window frame and
# delivers the VT payload into the tab's real console. Design: docs/ARCHITECTURE.md.
# Prints the resolved HWND on stdout first, or 0.
param(
    [Parameter(Mandatory=$true)][string]$FrameColor,  # RRGGBB, no leading #
    [long]$Hwnd = 0,
    [switch]$NoPaint,          # resolve and report the HWND, but write no color
    [switch]$Reset,            # write DWMWA_COLOR_DEFAULT: back to the system frame
    [string]$SkipHwnds = "",   # -Reset only: comma-joined HWNDs a repo session owns
    [string]$VtB64 = "",
    [int]$VtDelayMs = 0,       # >0: hand targets to a delayed hidden writer instead of writing now
    [string]$VtTargets = "",   # delayed-writer mode: comma-joined attach-target PIDs, topmost first
    [string]$StateFile = "",   # delayed-writer mode: state.json path for the vtHex skip check
    [string]$SessionId = ""    # delayed-writer mode: which session's vtHex to check
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

if ($VtTargets -ne "") {
    # Delayed writer: the parent resolved the targets while the ancestor chain
    # was alive. Skip if a prompt already delivered a newer payload.
    if ($VtDelayMs -gt 0) { Start-Sleep -Milliseconds $VtDelayMs }
    if ($StateFile -ne "" -and $SessionId -ne "" -and (Test-Path -LiteralPath $StateFile)) {
        try {
            $state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
            $sess = $state.sessions.$SessionId
            if ($sess -and $sess.vtHex -eq ("#" + $FrameColor.ToLower())) { exit 0 }
        } catch {}
    }
    try {
        $bytes = [Convert]::FromBase64String($VtB64)
        foreach ($target in ($VtTargets -split ",")) {
            if ([AuraFrame]::WriteVt([uint32]$target, $bytes)) { break }
        }
    } catch {}
    exit 0
}

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
    # The resolved window may differ from the cached one, so the skip list is
    # checked here: a repo session's color outranks a bare shell's reset.
    $skip = $false
    if ($Reset -and $SkipHwnds -ne "") {
        $skip = ($SkipHwnds -split "," | Where-Object { $_ -eq ([int64]$target).ToString() }).Count -gt 0
    }
    if ($Reset -and -not $skip) {
        $default = -1  # DWMWA_COLOR_DEFAULT (0xFFFFFFFF)
        [void][AuraFrame]::DwmSetWindowAttribute($target, 34, [ref]$default, 4)
        [void][AuraFrame]::DwmSetWindowAttribute($target, 35, [ref]$default, 4)
    }
    # -NoPaint callers want the handle only.
    if (-not $NoPaint) {
        # COLORREF is 0x00BBGGRR.
        $r = [Convert]::ToInt32($FrameColor.Substring(0, 2), 16)
        $g = [Convert]::ToInt32($FrameColor.Substring(2, 2), 16)
        $b = [Convert]::ToInt32($FrameColor.Substring(4, 2), 16)
        $colorref = ($b -shl 16) -bor ($g -shl 8) -bor $r
        [void][AuraFrame]::DwmSetWindowAttribute($target, 34, [ref]$colorref, 4)  # DWMWA_BORDER_COLOR
        [void][AuraFrame]::DwmSetWindowAttribute($target, 35, [ref]$colorref, 4)  # DWMWA_CAPTION_COLOR
    }
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
        if ($VtDelayMs -gt 0) {
            # An immediate write races the TUI init, so hand off to a grandchild.
            if ($chain.Length -gt 0) {
                $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath,
                    "-FrameColor", $FrameColor, "-VtB64", $VtB64,
                    "-VtTargets", ($chain -join ","), "-VtDelayMs", $VtDelayMs)
                if ($StateFile -ne "") { $argList += @("-StateFile", $StateFile) }
                if ($SessionId -ne "") { $argList += @("-SessionId", $SessionId) }
                Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList $argList
            }
        } else {
            foreach ($ancestor in $chain) {
                if ([AuraFrame]::WriteVt($ancestor, $bytes)) { break }
            }
        }
    } catch {}
}
