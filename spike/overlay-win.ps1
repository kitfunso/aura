# aura Lane B spike: can a click-through colored border track ANY window?
# Raw Win32 window (no WinForms: a WinForms Form ACTIVATES itself on first
# show even with WS_EX_NOACTIVATE retrofitted, measured 2026-08-30). The
# overlay is created with WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
# | WS_EX_TOOLWINDOW | WS_EX_TOPMOST at CreateWindowEx time, draws a frame
# just OUTSIDE the target's visual rect (DWMWA_EXTENDED_FRAME_BOUNDS), and
# follows it from a WM_TIMER poll. The window region is the border ring only,
# so the center is not part of the window at all; the ring itself is
# click-through via WS_EX_TRANSPARENT.
# Exits when the target window dies, or after a 10 min spike cap.
param(
    [string]$ProcessName = "Notepad",
    [long]$Hwnd = 0,           # explicit target beats process-name lookup
    [string]$FrameColor = "26bbd9",  # RRGGBB, no leading #
    [int]$Thickness = 3,
    [int]$PollMs = 30,
    [int]$MaxMinutes = 10
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AuraOverlayNative {
    private delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX {
        public uint cbSize; public uint style; public WndProc lpfnWndProc;
        public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance;
        public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
        public string lpszMenuName; public string lpszClassName; public IntPtr hIconSm;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassExW(ref WNDCLASSEX wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowExW(uint exStyle, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] private static extern int GetMessageW(out MSG msg, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr proc);
    [DllImport("user32.dll")] private static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateSolidBrush(int color);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr dest, IntPtr a, IntPtr b, int mode);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr o);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT rect, int size);

    private const uint WM_TIMER = 0x0113;
    private const uint WM_DESTROY = 0x0002;

    private static WndProc procRef;          // held so the GC never collects the delegate
    private static IntPtr target;
    private static int thickness;
    private static DateTime deadline;
    private static bool shown;
    private static RECT last;
    private static bool haveLast;

    private static IntPtr Proc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam) {
        if (msg == WM_TIMER) { Tick(hWnd); return IntPtr.Zero; }
        if (msg == WM_DESTROY) { PostQuitMessage(0); return IntPtr.Zero; }
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private static void Tick(IntPtr hWnd) {
        if (DateTime.UtcNow > deadline || !IsWindow(target)) { DestroyWindow(hWnd); return; }
        if (IsIconic(target)) {
            if (shown) { ShowWindow(hWnd, 0); shown = false; }  // SW_HIDE
            return;
        }
        RECT r;
        // DWMWA_EXTENDED_FRAME_BOUNDS (9): the VISUAL rect; GetWindowRect
        // includes invisible resize borders and the ring would float in air.
        if (DwmGetWindowAttribute(target, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) return;
        if (!haveLast || r.Left != last.Left || r.Top != last.Top || r.Right != last.Right || r.Bottom != last.Bottom) {
            last = r; haveLast = true;
            int t = thickness;
            int x = r.Left - t, y = r.Top - t;
            int w = (r.Right - r.Left) + 2 * t, h = (r.Bottom - r.Top) + 2 * t;
            SetWindowPos(hWnd, IntPtr.Zero, x, y, w, h, 0x10 | 0x4);  // NOACTIVATE | NOZORDER (topmost comes from WS_EX_TOPMOST)
            IntPtr ring = CreateRectRgn(0, 0, w, h);
            IntPtr inner = CreateRectRgn(t, t, w - t, h - t);
            CombineRgn(ring, ring, inner, 4);  // RGN_DIFF: border ring only
            DeleteObject(inner);
            SetWindowRgn(hWnd, ring, true);    // the system owns the region from here
        }
        if (!shown) { ShowWindow(hWnd, 8); shown = true; }  // SW_SHOWNA: show, never activate
    }

    public static IntPtr overlayHwnd;

    public static int Run(long targetHwnd, int red, int green, int blue, int borderPx, int pollMs, int maxMinutes) {
        SetProcessDPIAware();
        target = (IntPtr)targetHwnd;
        thickness = borderPx;
        deadline = DateTime.UtcNow.AddMinutes(maxMinutes);

        procRef = Proc;
        WNDCLASSEX wc = new WNDCLASSEX();
        wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
        wc.lpfnWndProc = procRef;
        wc.hInstance = Marshal.GetHINSTANCE(typeof(AuraOverlayNative).Module);
        wc.hbrBackground = CreateSolidBrush((blue << 16) | (green << 8) | red);  // COLORREF is 0x00BBGGRR
        wc.lpszClassName = "AuraOverlaySpike";
        if (RegisterClassExW(ref wc) == 0) return 2;

        // LAYERED | TRANSPARENT | TOOLWINDOW | TOPMOST | NOACTIVATE, all at creation.
        uint ex = 0x80000u | 0x20u | 0x80u | 0x8u | 0x8000000u;
        IntPtr hwnd = CreateWindowExW(ex, wc.lpszClassName, "", 0x80000000u /* WS_POPUP */,
            0, 0, 10, 10, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) return 3;
        overlayHwnd = hwnd;
        SetLayeredWindowAttributes(hwnd, 0, 255, 2);  // LWA_ALPHA, fully opaque
        SetTimer(hwnd, (IntPtr)1, (uint)pollMs, IntPtr.Zero);

        MSG msg;
        while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
        return 0;
    }
}
"@

$target = [IntPtr]$Hwnd
if ($target -eq [IntPtr]::Zero) {
    $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
    if (-not $proc) { Write-Output "no $ProcessName window found"; exit 1 }
    $target = $proc.MainWindowHandle
}
Write-Output ("tracking hwnd " + [int64]$target)

$colorR = [Convert]::ToInt32($FrameColor.Substring(0, 2), 16)
$colorG = [Convert]::ToInt32($FrameColor.Substring(2, 2), 16)
$colorB = [Convert]::ToInt32($FrameColor.Substring(4, 2), 16)

$code = [AuraOverlayNative]::Run([int64]$target, $colorR, $colorG, $colorB, $Thickness, $PollMs, $MaxMinutes)
Write-Output "overlay exited code=$code"
exit $code
