# Spike 2b: window-identification diagnostic. Answers three questions in one run:
# 1. What is the foreground window (the best HWND candidate when the user just typed)?
# 2. Does a console-title change ever reach a visible top-level window, and how fast?
# 3. What do the real Windows Terminal window titles look like?
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AuraDiag {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool SetConsoleTitleW(string t);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowW(string c, string t);

    static string Describe(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        string proc = "?";
        try { proc = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) {}
        return "hwnd=" + h + " pid=" + pid + " proc=" + proc + " title=\"" + sb.ToString() + "\"";
    }

    public static string Run(string nonce) {
        var lines = new List<string>();
        lines.Add("FOREGROUND: " + Describe(GetForegroundWindow()));
        lines.Add("CONSOLE_WINDOW: " + Describe(GetConsoleWindow()));
        SetConsoleTitleW(nonce);
        IntPtr found = IntPtr.Zero;
        int foundAtMs = -1;
        for (int i = 0; i < 20; i++) {
            found = FindWindowW(null, nonce);
            if (found != IntPtr.Zero) { foundAtMs = i * 50; break; }
            Thread.Sleep(50);
        }
        if (found == IntPtr.Zero) lines.Add("NONCE_FINDWINDOW: not found within 1000ms");
        else lines.Add("NONCE_FINDWINDOW: " + Describe(found) + " after " + foundAtMs + "ms");
        lines.Add("TERMINAL_WINDOWS:");
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string proc = "";
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) {}
            if (proc == "WindowsTerminal" || proc == "conhost" || proc == "OpenConsole") {
                lines.Add("  " + Describe(h));
            }
            return true;
        }, IntPtr.Zero);
        return string.Join("\n", lines.ToArray());
    }
}
"@

$nonce = "aura-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
Write-Output ("NONCE: " + $nonce)
Write-Output ([AuraDiag]::Run($nonce))
