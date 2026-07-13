$nativeCode = @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct AiBatteryRect {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
[StructLayout(LayoutKind.Sequential)]
public struct AiBatteryMonitorInfo {
  public int CbSize;
  public AiBatteryRect Monitor;
  public AiBatteryRect Work;
  public int Flags;
}
[StructLayout(LayoutKind.Sequential)]
public struct AiBatteryPowerThrottlingState {
  public uint Version;
  public uint ControlMask;
  public uint StateMask;
}
public delegate void AiBatteryWinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);
public delegate bool AiBatteryEnumWindowsDelegate(IntPtr hwnd, IntPtr lParam);
public static class AiBatteryNative {
  public const int ProcessPowerThrottling = 4;
  public const uint PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
  public const uint PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
  public const int PROCESS_PER_MONITOR_DPI_AWARE = 2;
  public const int DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
  public const int OBJID_WINDOW = 0;
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TRANSPARENT = 0x20;
  public const int WS_EX_TOOLWINDOW = 0x80;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int SW_HIDE = 0;
  public const int SW_MAXIMIZE = 3;
  public const int SW_SHOWNOACTIVATE = 4;
  public const int SW_RESTORE = 9;
  public const UInt32 MONITOR_DEFAULTTONEAREST = 2;
  public const UInt32 GW_HWNDNEXT = 2;
  public const int DWMWA_CLOAKED = 14;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  public const int DWMWA_NCRENDERING_POLICY = 2;
  public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
  public const int DWMWA_BORDER_COLOR = 34;
  public const int DWMWA_COLOR_DEFAULT = -1;
  public const int DWMWA_COLOR_NONE = -2;
  public const int DWMWCP_DEFAULT = 0;
  public const int DWMWCP_DONOTROUND = 1;
  public const int DWMWCP_ROUND = 2;
  public const int DWMNCRP_USEWINDOWSTYLE = 0;
  public const int DWMNCRP_DISABLED = 1;
  public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  public const uint EVENT_SYSTEM_MOVESIZESTART = 0x000A;
  public const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
  public const uint EVENT_OBJECT_SHOW = 0x8002;
  public const uint EVENT_OBJECT_HIDE = 0x8003;
  public const uint EVENT_OBJECT_REORDER = 0x8004;
  public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
  public const uint EVENT_OBJECT_CLOAKED = 0x8017;
  public const uint EVENT_OBJECT_UNCLOAKED = 0x8018;
  public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
  public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_TOP = IntPtr.Zero;
  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public const UInt32 GW_HWNDPREV = 3;
  public const UInt32 SWP_NOSIZE = 0x0001;
  public const UInt32 SWP_NOMOVE = 0x0002;
  public const UInt32 SWP_NOZORDER = 0x0004;
  public const UInt32 SWP_NOACTIVATE = 0x0010;
  public const UInt32 SWP_SHOWWINDOW = 0x0040;
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")]
  public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")]
  public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, UInt32 uFlags);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr hWnd, UInt32 uCmd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetTopWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(AiBatteryEnumWindowsDelegate callback, IntPtr lParam);
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hWnd, int dwAttribute, ref int pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")]
  public static extern int DwmGetWindowAttributeRect(IntPtr hWnd, int dwAttribute, out AiBatteryRect pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll")]
  public static extern int DwmFlush();
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetProcessInformation(IntPtr hProcess, int ProcessInformationClass, ref AiBatteryPowerThrottlingState ProcessInformation, int ProcessInformationSize);
  [DllImport("user32.dll")]
  public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, AiBatteryWinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
  [DllImport("user32.dll")]
  public static extern bool UnhookWinEvent(IntPtr hWinEventHook);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out AiBatteryRect rect);
  public static bool HasVisibleTopLevelWindowClass(string className) {
    bool found = false;
    AiBatteryEnumWindowsDelegate callback = delegate(IntPtr hwnd, IntPtr lParam) {
      if (!IsWindowVisible(hwnd)) return true;
      var value = new System.Text.StringBuilder(256);
      GetClassName(hwnd, value, value.Capacity);
      if (String.Equals(value.ToString(), className, StringComparison.Ordinal)) {
        found = true;
        return false;
      }
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return found;
  }
  [DllImport("user32.dll")]
  public static extern IntPtr MonitorFromWindow(IntPtr hWnd, UInt32 dwFlags);
  [DllImport("user32.dll")]
  public static extern bool GetMonitorInfo(IntPtr hMonitor, ref AiBatteryMonitorInfo lpmi);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@
Add-Type -TypeDefinition $nativeCode

function Enable-HudDpiAwareness {
  $context = [IntPtr]::new([AiBatteryNative]::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
  try {
    if ([AiBatteryNative]::SetProcessDpiAwarenessContext($context)) { return "per-monitor-v2" }
  } catch {
    # PowerShell may already own a hidden console HWND, which locks process DPI.
  }

  try {
    if ([AiBatteryNative]::SetThreadDpiAwarenessContext($context) -ne [IntPtr]::Zero) {
      return "thread-per-monitor-v2"
    }
  } catch {
    # Fall through to older process-level APIs.
  }

  try {
    if ([AiBatteryNative]::SetProcessDpiAwareness([AiBatteryNative]::PROCESS_PER_MONITOR_DPI_AWARE) -eq 0) { return "per-monitor" }
  } catch {
    # Fall through to system DPI awareness.
  }

  try {
    if ([AiBatteryNative]::SetProcessDPIAware()) { return "system" }
  } catch {
    # DPI awareness is a quality improvement; the HUD can still run without it.
  }

  return "default"
}
$script:hudDpiAwareness = Enable-HudDpiAwareness

function Disable-ProcessPowerThrottling {
  # When a fullscreen app is in the foreground, Windows applies EcoQoS power
  # throttling to background processes like this HUD, which stretches the
  # WinForms timer from 250ms out to several seconds. That made the HUD linger
  # over a fullscreen window for 3-5s before hiding (while unhide, which happens
  # after throttling lifts, stayed instant). Opt the process out so the
  # fullscreen check keeps firing on time even while backgrounded.
  try {
    $state = New-Object AiBatteryPowerThrottlingState
    $state.Version = [AiBatteryNative]::PROCESS_POWER_THROTTLING_CURRENT_VERSION
    $state.ControlMask = [AiBatteryNative]::PROCESS_POWER_THROTTLING_EXECUTION_SPEED
    $state.StateMask = 0
    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AiBatteryPowerThrottlingState])
    return [AiBatteryNative]::SetProcessInformation([AiBatteryNative]::GetCurrentProcess(), [AiBatteryNative]::ProcessPowerThrottling, [ref]$state, $size)
  } catch {
    # Older Windows builds lack ProcessPowerThrottling; the HUD still works.
    return $false
  }
}
$script:powerThrottlingDisabled = Disable-ProcessPowerThrottling
