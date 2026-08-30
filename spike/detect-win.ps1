# aura Lane B spike: enumerate the windows a cross-app overlay would color.
# Visible, titled, non-tool, non-cloaked top-level windows only. Emits JSON:
# [{ hwnd, pid, process, title }]. Titles can hold prompt text; the output is
# for local spike runs and never gets committed.
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AuraDetect {
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

    public struct Row { public long Hwnd; public uint Pid; public string Title; }

    public static List<Row> Scan() {
        List<Row> rows = new List<Row>();
        EnumWindows(delegate(IntPtr h, IntPtr lp) {
            if (!IsWindowVisible(h)) return true;
            int ex = GetWindowLong(h, -20);
            if ((ex & 0x80) != 0) return true;                 // WS_EX_TOOLWINDOW: not a user-facing window
            int cloaked;
            if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;  // DWMWA_CLOAKED
            StringBuilder sb = new StringBuilder(512);
            GetWindowTextW(h, sb, 512);
            string title = sb.ToString();
            if (title.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            Row r = new Row(); r.Hwnd = (long)h; r.Pid = pid; r.Title = title;
            rows.Add(r);
            return true;
        }, IntPtr.Zero);
        return rows;
    }
}
"@

$rows = [AuraDetect]::Scan()
$out = @()
foreach ($row in $rows) {
    $proc = Get-Process -Id $row.Pid -ErrorAction SilentlyContinue
    $name = ""
    if ($proc) { $name = $proc.ProcessName }
    $out += [pscustomobject]@{ hwnd = $row.Hwnd; pid = $row.Pid; process = $name; title = $row.Title }
}
# -Compress keeps it one line; detect.js parses stdout whole.
ConvertTo-Json -InputObject $out -Compress
