# Spike 2c: the decisive run for both lanes.
# Lane 1 (frame): paint border + caption of the FOREGROUND window (the window the
#   user just typed in) via DWM. No nonce, no title games.
# Lane 2 (tint): walk the parent-process chain, AttachConsole() to each ancestor
#   until one holds the real terminal's console, then write OSC 11 to its CONOUT$
#   with VT processing enabled.
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AuraAttach {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll")] static extern bool WriteFile(IntPtr h, byte[] buf, uint n, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    public static string TryTint(uint pid, string osc) {
        FreeConsole();
        if (!AttachConsole(pid)) { return "attach-failed"; }
        IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) { FreeConsole(); return "conout-open-failed"; }
        uint mode;
        if (GetConsoleMode(h, out mode)) { SetConsoleMode(h, mode | 0x4); }
        byte[] bytes = Encoding.UTF8.GetBytes(osc);
        uint written;
        bool ok = WriteFile(h, bytes, (uint)bytes.Length, out written, IntPtr.Zero);
        CloseHandle(h);
        FreeConsole();
        if (ok) { return "wrote " + written + " bytes"; }
        return "write-failed";
    }
}
"@

# Lane 1: frame paint on the foreground window.
$hwnd = [AuraAttach]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][AuraAttach]::GetWindowTextW($hwnd, $sb, 512)
$colorref = 0x00E22B8A   # violet #8A2BE2 as COLORREF (0x00BBGGRR)
$rcBorder = [AuraAttach]::DwmSetWindowAttribute($hwnd, 34, [ref]$colorref, 4)
$rcCaption = [AuraAttach]::DwmSetWindowAttribute($hwnd, 35, [ref]$colorref, 4)
Write-Output ("FRAME: hwnd=" + $hwnd + " title=""" + $sb.ToString() + """ border_rc=" + $rcBorder + " caption_rc=" + $rcCaption + " (0 = S_OK)")

# Lane 2: tint via ancestor console attach.
$osc = [char]27 + "]11;#1a1230" + [char]7
$pid_ = $PID
$chain = @()
for ($i = 0; $i -lt 10 -and $pid_; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $pid_)
    if (-not $proc) { break }
    $chain += [pscustomobject]@{ Pid = $proc.ProcessId; Name = $proc.Name; Parent = $proc.ParentProcessId }
    $pid_ = $proc.ParentProcessId
}
foreach ($entry in $chain) {
    if ($entry.Pid -eq $PID) { continue }
    $result = [AuraAttach]::TryTint([uint32]$entry.Pid, $osc)
    Write-Output ("TINT: pid=" + $entry.Pid + " " + $entry.Name + " -> " + $result)
    if ($result.StartsWith("wrote")) { break }
}
