<#
  Records every top-level window that appears while it runs, so a spec can fail
  when resmon (or a program it starts) shows a console window.

    powershell -NoProfile -File watch-windows.ps1 -Log windows.jsonl -Stop stop.flag

  Two independent recorders write to the same log, one JSON object per line:

    hook   SetWinEventHook for EVENT_OBJECT_CREATE and EVENT_OBJECT_SHOW, run
           out of context on a thread of its own with a message loop. It sees a
           window the moment it is created or shown, however briefly.
    poll   EnumWindows every 50 ms, noting each visible top-level window once.
           It does not depend on the hook's message loop, so a window the hook
           missed still shows up here.

  Each record names the window: its class, its title, the process that owns it,
  and that process's ancestors (executable path and id), because a console
  window belongs to a console host whose parent is the program that asked for
  the console. The helper writes {"ready":true} once it has taken a baseline of
  the windows already open, records until the Stop file exists, then writes
  {"done":true}.
#>
param(
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$Stop
)
$ErrorActionPreference = 'Stop'

# -IgnoreWarnings: Windows PowerShell treats a compiler warning as an error otherwise.
Add-Type -IgnoreWarnings -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ResmonWindowWatch
{
    delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2_0; public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int size, out int returned);

    const uint EVENT_OBJECT_CREATE = 0x8000;
    const uint EVENT_OBJECT_SHOW = 0x8002;
    const uint WINEVENT_OUTOFCONTEXT = 0;
    const uint WM_QUIT = 0x0012;
    const uint GA_ROOT = 2;

    static readonly object gate = new object();
    static string logPath;
    static WinEventProc keepAlive;          // the delegate must outlive the hook
    static uint hookThread;
    static Thread hookRunner;
    static readonly HashSet<long> polled = new HashSet<long>();

    static string Esc(string s)
    {
        if (s == null) return "";
        StringBuilder b = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { b.Append('\\').Append(c); }
            else if (c < 32) { b.Append(' '); }
            else { b.Append(c); }
        }
        return b.ToString();
    }

    static void Write(string line)
    {
        lock (gate) { File.AppendAllText(logPath, line + "\n", Encoding.UTF8); }
    }

    static int ParentOf(int pid)
    {
        try
        {
            Process p = Process.GetProcessById(pid);
            PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
            int returned;
            if (NtQueryInformationProcess(p.Handle, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return 0;
            return info.InheritedFromUniqueProcessId.ToInt32();
        }
        catch (Exception) { return 0; }
    }

    static string Describe(int pid)
    {
        try
        {
            Process p = Process.GetProcessById(pid);
            string path;
            try { path = p.MainModule.FileName; } catch (Exception) { path = p.ProcessName + ".exe"; }
            return path + "(" + pid + ")";
        }
        catch (Exception) { return "?(" + pid + ")"; }
    }

    static string Chain(int pid)
    {
        List<string> parts = new List<string>();
        int seen = 0;
        while (pid > 4 && seen < 8)
        {
            parts.Add(Describe(pid));
            pid = ParentOf(pid);
            seen++;
        }
        if (pid > 4) parts.Add("...");
        return string.Join(" < ", parts.ToArray());
    }

    static void Record(string source, string evt, IntPtr hwnd)
    {
        StringBuilder cls = new StringBuilder(256);
        StringBuilder title = new StringBuilder(256);
        GetClassName(hwnd, cls, cls.Capacity);
        GetWindowText(hwnd, title, title.Capacity);
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        Write("{\"t\":\"" + DateTime.UtcNow.ToString("o") + "\",\"source\":\"" + source + "\",\"event\":\"" + evt
            + "\",\"class\":\"" + Esc(cls.ToString()) + "\",\"title\":\"" + Esc(title.ToString())
            + "\",\"visible\":" + (IsWindowVisible(hwnd) ? "true" : "false")
            + ",\"pid\":" + pid + ",\"owner\":\"" + Esc(Chain((int)pid)) + "\"}");
    }

    static void OnEvent(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        // OBJID_WINDOW is 0; a child of a window or a non-window object is not a window being shown.
        if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
        if (GetAncestor(hwnd, GA_ROOT) != hwnd) return;
        if (evt != EVENT_OBJECT_CREATE && evt != EVENT_OBJECT_SHOW) return;   // 0x8001 is a destroy
        try { Record("hook", evt == EVENT_OBJECT_CREATE ? "create" : "show", hwnd); }
        catch (Exception e) { Write("{\"error\":\"" + Esc(e.Message) + "\"}"); }
    }

    static void HookLoop()
    {
        hookThread = GetCurrentThreadId();
        keepAlive = new WinEventProc(OnEvent);
        IntPtr hook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, IntPtr.Zero, keepAlive, 0, 0, WINEVENT_OUTOFCONTEXT);
        if (hook == IntPtr.Zero) { Write("{\"error\":\"SetWinEventHook failed\"}"); return; }
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
        UnhookWinEvent(hook);
    }

    static bool OnWindow(IntPtr hwnd, IntPtr lParam)
    {
        if (!IsWindowVisible(hwnd)) return true;
        long key = hwnd.ToInt64();
        if (polled.Add(key))
        {
            try { Record("poll", "visible", hwnd); }
            catch (Exception e) { Write("{\"error\":\"" + Esc(e.Message) + "\"}"); }
        }
        return true;
    }

    public static void Run(string log, string stopFile)
    {
        logPath = log;
        hookRunner = new Thread(HookLoop);
        hookRunner.IsBackground = true;
        hookRunner.Start();
        // The windows already open are the baseline, not something that appeared.
        EnumWindows(delegate (IntPtr hwnd, IntPtr l) { if (IsWindowVisible(hwnd)) polled.Add(hwnd.ToInt64()); return true; }, IntPtr.Zero);
        Write("{\"ready\":true}");
        EnumProc proc = new EnumProc(OnWindow);
        while (!File.Exists(stopFile))
        {
            EnumWindows(proc, IntPtr.Zero);
            Thread.Sleep(50);
        }
        PostThreadMessage(hookThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        hookRunner.Join(5000);
        Write("{\"done\":true}");
    }
}
'@

[ResmonWindowWatch]::Run($Log, $Stop)
