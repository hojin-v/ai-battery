// Vendored from the rowpty project (commit ff36499+local). Do not edit here -
// change it upstream in Projects/rowpty and run: node scripts/sync-rowpty.mjs
// "ai-battery setup" compiles this file on the user machine with the in-box
// .NET Framework csc.exe so no unsigned binary ships in the npm package.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal sealed class RowPty
{
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;

    private const uint ENABLE_PROCESSED_OUTPUT = 0x0001;
    private const uint ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
    private const uint DISABLE_NEWLINE_AUTO_RETURN = 0x0008;
    private const uint ENABLE_WINDOW_INPUT = 0x0008;
    private const uint ENABLE_EXTENDED_FLAGS = 0x0080;

    private const ushort KEY_EVENT = 0x0001;
    private const uint LEFT_ALT_PRESSED = 0x0002;
    private const uint LEFT_CTRL_PRESSED = 0x0008;
    private const uint SHIFT_PRESSED = 0x0010;

    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);

    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint INFINITE = 0xffffffff;

    private const uint CTRL_C_EVENT = 0;
    private const uint CTRL_BREAK_EVENT = 1;
    private const uint CTRL_CLOSE_EVENT = 2;

    private const int VT_STATE_GROUND = 0;
    private const int VT_STATE_ESC = 1;
    private const int VT_STATE_CSI = 2;
    private const int VT_STATE_OSC = 3;
    private const int VT_STATE_DCS = 4;
    private const int VT_STATE_OSC_ESC = 5;
    private const int VT_STATE_DCS_ESC = 6;

    private static readonly byte[] HostClearDisplayAction = Encoding.ASCII.GetBytes("\u001b]633;RowPtyClearDisplay\u0007");
    private static readonly byte[] HostClearFromCursorAction = Encoding.ASCII.GetBytes("\u001b]633;RowPtyClearFromCursor\u0007");

    // The bundled Windows Terminal ConPTY (conpty.dll >= 1.22) probes the
    // hosting terminal with a DA1 query (ESC[c) at startup and blocks in
    // WaitUntilDA1(3000) until a response arrives. InputPump deliberately
    // drops terminal responses coming back from the real host (they would
    // otherwise leak into the child's composer), so rowpty answers the probe
    // itself and swallows the query before it reaches the host terminal.
    private static readonly byte[] Da1Response = Encoding.ASCII.GetBytes("\x1b[?61;6;7;14;21;22;23;24;28;32;42c");

    private static readonly ConsoleCtrlDelegate CtrlDelegate = new ConsoleCtrlDelegate(ConsoleCtrlHandler);
    private static RowPty activeInstance;

    private readonly object consoleLock = new object();
    private readonly object stateLock = new object();
    private readonly object statusLock = new object();
    private readonly object fetchLock = new object();
    private readonly object cleanupLock = new object();
    private readonly object conptyInputWriteLock = new object();

    private Options options;
    private IntPtr hStdIn = IntPtr.Zero;
    private IntPtr hStdOut = IntPtr.Zero;
    private uint originalInputMode;
    private uint originalOutputMode;
    private uint originalConsoleCP;
    private uint originalConsoleOutputCP;
    private bool consoleStateSaved;
    private bool outputConfigured;
    private bool hostScrollRegionConfigured;
    private bool ctrlHandlerInstalled;

    private IntPtr hPseudoConsole = IntPtr.Zero;
    private IntPtr conptyInRead = IntPtr.Zero;
    private IntPtr conptyInWrite = IntPtr.Zero;
    private IntPtr conptyOutRead = IntPtr.Zero;
    private IntPtr conptyOutWrite = IntPtr.Zero;
    private IntPtr attributeList = IntPtr.Zero;
    private IntPtr childProcessHandle = IntPtr.Zero;
    private IntPtr conptyProviderLibrary = IntPtr.Zero;
    private CreatePseudoConsoleDelegate createPseudoConsoleProvider = new CreatePseudoConsoleDelegate(KernelCreatePseudoConsole);
    private ResizePseudoConsoleDelegate resizePseudoConsoleProvider = new ResizePseudoConsoleDelegate(KernelResizePseudoConsole);
    private ClosePseudoConsoleDelegate closePseudoConsoleProvider = new ClosePseudoConsoleDelegate(KernelClosePseudoConsole);

    private Thread inputThread;
    private Thread outputThread;
    private Thread statusThread;
    private AutoResetEvent fetchEvent;

    private volatile bool stopping;
    private volatile bool cleanupStarted;
    private volatile bool win32InputModeEnabled;
    private bool fetchStop;
    private int fetchMaxWidth;

    private Stopwatch clock;
    private bool preserveScrollback = true;
    private bool filterAlternateScreen;
    private byte[] pendingHostOutput = new byte[0];
    private volatile bool da1QueryAnswered;
    private bool childOutputSeen;
    private bool screenDirty;
    private long lastOutputMs;
    private int forceRepaintCount;
    private volatile int outputVtState = VT_STATE_GROUND;
    private long outputVtStateChangedMs;

    private string statusText = "";
    private int statusVersion;

    private int currentCols = 80;
    private int currentRows = 24;
    private int paintedStatusVersion = -1;
    private string lastPaintedLine = null;
    private int lastPaintedRow = -1;
    private long lastPaintMs;

    public static int Main(string[] args)
    {
        RowPty app = new RowPty();
        try
        {
            return app.Execute(args);
        }
        catch (UsageException ex)
        {
            if (ex.Message.Length > 0)
            {
                Console.Error.WriteLine("rowpty: " + ex.Message);
            }
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("rowpty: " + ex.Message);
            return 2;
        }
        finally
        {
            app.Cleanup();
        }
    }

    private int Execute(string[] args)
    {
        if (args.Length > 0 && args[0] == "--foreground-terminal")
        {
            long window = ForegroundTerminalWindow();
            string title = TerminalWindowTitle(new IntPtr(window));
            Console.WriteLine(window.ToString(CultureInfo.InvariantCulture) + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(title)));
            return 0;
        }

        if (args.Length > 0 && args[0] == "--launch-detached")
        {
            return LaunchDetached(args);
        }

        bool handled;
        int immediateExitCode;
        this.options = ParseOptions(args, out handled, out immediateExitCode);
        if (handled)
        {
            return immediateExitCode;
        }

        this.preserveScrollback = PreserveScrollbackEnabled();
        this.filterAlternateScreen = FilterAlternateScreenEnabled();
        this.clock = Stopwatch.StartNew();
        this.outputVtStateChangedMs = this.clock.ElapsedMilliseconds;
        SetupConsole();
        if (!ReadConsoleSize(out this.currentCols, out this.currentRows))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "GetConsoleScreenBufferInfo failed");
        }
        ConfigureHostScrollRegion();
        ResolveConptyProvider();
        CreatePseudoConsoleAndChild();
        StartThreads();

        int exitCode = RunMainLoop();
        return exitCode;
    }

    private static int LaunchDetached(string[] args)
    {
        if (args.Length < 3 || args.Length > 4)
        {
            throw new UsageException("--launch-detached requires COMMAND_BASE64 CWD_BASE64 [WINDOW_PLACEHOLDER]");
        }

        string commandLineText;
        string workingDirectory;
        try
        {
            commandLineText = Encoding.UTF8.GetString(Convert.FromBase64String(args[1]));
            workingDirectory = Encoding.UTF8.GetString(Convert.FromBase64String(args[2]));
        }
        catch (FormatException)
        {
            throw new UsageException("--launch-detached arguments must be base64-encoded UTF-8");
        }

        if (args.Length == 4 && args[3].Length > 0)
        {
            commandLineText = commandLineText.Replace(args[3], ForegroundTerminalWindow().ToString(CultureInfo.InvariantCulture));
        }

        STARTUPINFOEX startupInfo = new STARTUPINFOEX();
        startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startupInfo.StartupInfo.dwFlags = STARTF_USESHOWWINDOW;
        startupInfo.StartupInfo.wShowWindow = SW_HIDE;
        StringBuilder commandLine = new StringBuilder(commandLineText, commandLineText.Length + 1);
        PROCESS_INFORMATION processInfo;
        bool ok = CreateProcessW(
            null,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            IntPtr.Zero,
            workingDirectory,
            ref startupInfo,
            out processInfo);
        if (!ok)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "detached CreateProcess failed");
        }

        CloseHandle(processInfo.hThread);
        CloseHandle(processInfo.hProcess);
        return 0;
    }

    private static long ForegroundTerminalWindow()
    {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero)
        {
            return 0;
        }

        uint processId;
        GetWindowThreadProcessId(window, out processId);
        try
        {
            string name = Process.GetProcessById((int)processId).ProcessName.ToLowerInvariant();
            string[] terminals = { "windowsterminal", "conhost", "wezterm-gui", "alacritty", "code", "hyper", "tabby", "conemu64", "conemu" };
            for (int i = 0; i < terminals.Length; i++)
            {
                if (name == terminals[i])
                {
                    return window.ToInt64();
                }
            }
        }
        catch
        {
            return 0;
        }
        return 0;
    }

    private static string TerminalWindowTitle(IntPtr window)
    {
        if (window == IntPtr.Zero)
        {
            return "";
        }
        int length = GetWindowTextLengthW(window);
        if (length <= 0)
        {
            return "";
        }
        StringBuilder title = new StringBuilder(length + 1);
        return GetWindowTextW(window, title, title.Capacity) > 0 ? title.ToString() : "";
    }

    private static Options ParseOptions(string[] args, out bool handled, out int immediateExitCode)
    {
        Options parsed = new Options();
        parsed.IntervalSeconds = 10.0;
        parsed.ReserveRows = 1;
        parsed.StatusCommand = null;
        parsed.SettleMs = 50;

        handled = false;
        immediateExitCode = 0;

        int i = 0;
        while (i < args.Length)
        {
            string arg = args[i];
            if (arg == "--")
            {
                i++;
                break;
            }
            if (arg == "--help")
            {
                PrintHelp();
                handled = true;
                return parsed;
            }
            if (arg == "--version")
            {
                Console.WriteLine("rowpty 0.1.0");
                handled = true;
                return parsed;
            }
            if (arg == "--interval")
            {
                i++;
                if (i >= args.Length)
                {
                    throw new UsageException("--interval requires a value");
                }
                double seconds;
                if (!double.TryParse(args[i], NumberStyles.Float, CultureInfo.InvariantCulture, out seconds))
                {
                    throw new UsageException("--interval must be a number");
                }
                if (seconds < 0.5)
                {
                    seconds = 0.5;
                }
                parsed.IntervalSeconds = seconds;
                i++;
                continue;
            }
            if (arg == "--reserve")
            {
                i++;
                if (i >= args.Length)
                {
                    throw new UsageException("--reserve requires a value");
                }
                int reserve;
                if (!int.TryParse(args[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out reserve))
                {
                    throw new UsageException("--reserve must be an integer");
                }
                if (reserve < 1)
                {
                    reserve = 1;
                }
                if (reserve > 5)
                {
                    reserve = 5;
                }
                parsed.ReserveRows = reserve;
                i++;
                continue;
            }
            if (arg == "--status-cmd")
            {
                i++;
                if (i >= args.Length)
                {
                    throw new UsageException("--status-cmd requires a value");
                }
                parsed.StatusCommand = args[i];
                i++;
                continue;
            }
            if (arg == "--settle-ms")
            {
                i++;
                if (i >= args.Length)
                {
                    throw new UsageException("--settle-ms requires a value");
                }
                int settle;
                if (!int.TryParse(args[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out settle))
                {
                    throw new UsageException("--settle-ms must be an integer");
                }
                if (settle < 0)
                {
                    settle = 0;
                }
                parsed.SettleMs = settle;
                i++;
                continue;
            }
            throw new UsageException("unknown option " + arg);
        }

        if (i > args.Length || i == 0 && args.Length == 0)
        {
            throw new UsageException("missing -- CHILD.exe [ARGS...]");
        }
        if (i >= args.Length)
        {
            throw new UsageException("missing child command after --");
        }

        string[] childArgs = new string[args.Length - i];
        Array.Copy(args, i, childArgs, 0, childArgs.Length);
        parsed.ChildArgs = childArgs;
        return parsed;
    }

    private static void PrintHelp()
    {
        Console.WriteLine("usage: rowpty.exe [options] -- CHILD.exe [ARGS...]");
        Console.WriteLine();
        Console.WriteLine("--interval SECONDS   status refresh period (default 10, min 0.5)");
        Console.WriteLine("--reserve N          rows reserved at the bottom (default 1, clamp 1..5)");
        Console.WriteLine("--status-cmd CMD     command line used to fetch status text");
        Console.WriteLine("--settle-ms N        quiet time after child output before painting (default 50)");
        Console.WriteLine("--foreground-terminal print the active terminal window handle and exit");
        Console.WriteLine("--launch-detached COMMAND_BASE64 CWD_BASE64 [WINDOW_PLACEHOLDER]");
        Console.WriteLine("--version / --help");
    }

    private void SetupConsole()
    {
        this.hStdIn = GetStdHandle(STD_INPUT_HANDLE);
        this.hStdOut = GetStdHandle(STD_OUTPUT_HANDLE);

        uint inputMode;
        uint outputMode;
        if (!GetConsoleMode(this.hStdIn, out inputMode) || !GetConsoleMode(this.hStdOut, out outputMode))
        {
            throw new UsageException("stdin/stdout must be a real console");
        }

        this.originalInputMode = inputMode;
        this.originalOutputMode = outputMode;
        this.originalConsoleCP = GetConsoleCP();
        this.originalConsoleOutputCP = GetConsoleOutputCP();
        this.consoleStateSaved = true;

        activeInstance = this;
        if (!SetConsoleCtrlHandler(CtrlDelegate, true))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetConsoleCtrlHandler failed");
        }
        this.ctrlHandlerInstalled = true;

        uint rawInputMode = ENABLE_EXTENDED_FLAGS | ENABLE_WINDOW_INPUT;
        uint rawOutputMode = ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN;

        if (!SetConsoleMode(this.hStdIn, rawInputMode))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetConsoleMode(stdin) failed");
        }
        if (!SetConsoleMode(this.hStdOut, rawOutputMode))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetConsoleMode(stdout) failed");
        }
        this.outputConfigured = true;

        SetConsoleCP(65001);
        SetConsoleOutputCP(65001);
    }

    private void ResolveConptyProvider()
    {
        SetKernel32ConptyProvider();

        string disabled = Environment.GetEnvironmentVariable("ROWPTY_NO_CONPTY_DLL");
        if (string.Equals(disabled, "1", StringComparison.Ordinal))
        {
            return;
        }

        string dllPath = Environment.GetEnvironmentVariable("ROWPTY_CONPTY_DLL");
        if (dllPath == null || dllPath.Length == 0)
        {
            dllPath = FindBundledConptyDll();
        }
        if (dllPath == null || dllPath.Length == 0)
        {
            return;
        }

        TryLoadConptyProvider(dllPath);
    }

    private void SetKernel32ConptyProvider()
    {
        this.createPseudoConsoleProvider = new CreatePseudoConsoleDelegate(KernelCreatePseudoConsole);
        this.resizePseudoConsoleProvider = new ResizePseudoConsoleDelegate(KernelResizePseudoConsole);
        this.closePseudoConsoleProvider = new ClosePseudoConsoleDelegate(KernelClosePseudoConsole);
    }

    private static string FindBundledConptyDll()
    {
        try
        {
            Process process = Process.GetCurrentProcess();
            ProcessModule module = process.MainModule;
            if (module == null || module.FileName == null || module.FileName.Length == 0)
            {
                return null;
            }

            string directory = Path.GetDirectoryName(module.FileName);
            if (directory == null || directory.Length == 0)
            {
                return null;
            }

            string candidate = Path.Combine(directory, "conpty.dll");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }
        catch (Exception)
        {
        }
        return null;
    }

    private void TryLoadConptyProvider(string dllPath)
    {
        IntPtr library = IntPtr.Zero;
        try
        {
            library = LoadLibraryW(dllPath);
            if (library == IntPtr.Zero)
            {
                return;
            }

            IntPtr createProc = GetProcAddress(library, "ConptyCreatePseudoConsole");
            IntPtr resizeProc = GetProcAddress(library, "ConptyResizePseudoConsole");
            IntPtr closeProc = GetProcAddress(library, "ConptyClosePseudoConsole");
            if (createProc == IntPtr.Zero || resizeProc == IntPtr.Zero || closeProc == IntPtr.Zero)
            {
                return;
            }

            CreatePseudoConsoleDelegate createDelegate = (CreatePseudoConsoleDelegate)Marshal.GetDelegateForFunctionPointer(createProc, typeof(CreatePseudoConsoleDelegate));
            ResizePseudoConsoleDelegate resizeDelegate = (ResizePseudoConsoleDelegate)Marshal.GetDelegateForFunctionPointer(resizeProc, typeof(ResizePseudoConsoleDelegate));
            ClosePseudoConsoleDelegate closeDelegate = (ClosePseudoConsoleDelegate)Marshal.GetDelegateForFunctionPointer(closeProc, typeof(ClosePseudoConsoleDelegate));

            this.createPseudoConsoleProvider = createDelegate;
            this.resizePseudoConsoleProvider = resizeDelegate;
            this.closePseudoConsoleProvider = closeDelegate;
            this.conptyProviderLibrary = library;
            library = IntPtr.Zero;
        }
        catch (Exception)
        {
            SetKernel32ConptyProvider();
        }
        finally
        {
            if (library != IntPtr.Zero)
            {
                FreeLibrary(library);
            }
        }
    }

    private void CreatePseudoConsoleAndChild()
    {
        if (!CreatePipe(out this.conptyInRead, out this.conptyInWrite, IntPtr.Zero, 0))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe(input) failed");
        }
        if (!CreatePipe(out this.conptyOutRead, out this.conptyOutWrite, IntPtr.Zero, 0))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe(output) failed");
        }

        COORD size = MakeSize(this.currentCols, ChildRows(this.currentRows));
        int hr = this.createPseudoConsoleProvider(size, this.conptyInRead, this.conptyOutWrite, 0, out this.hPseudoConsole);
        if (hr < 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }

        CloseHandleRef(ref this.conptyInRead);
        CloseHandleRef(ref this.conptyOutWrite);

        STARTUPINFOEX startupInfo = new STARTUPINFOEX();
        startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));

        IntPtr attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        if (attrSize == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList(size) failed");
        }

        this.attributeList = Marshal.AllocHGlobal(attrSize);
        if (!InitializeProcThreadAttributeList(this.attributeList, 1, 0, ref attrSize))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");
        }

        if (!UpdateProcThreadAttribute(this.attributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, this.hPseudoConsole, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute failed");
        }

        startupInfo.lpAttributeList = this.attributeList;

        string commandLineText = BuildCommandLine(this.options.ChildArgs);
        StringBuilder commandLine = new StringBuilder(commandLineText, commandLineText.Length + 1);
        PROCESS_INFORMATION processInfo;
        bool ok = CreateProcessW(
            null,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            EXTENDED_STARTUPINFO_PRESENT,
            IntPtr.Zero,
            Directory.GetCurrentDirectory(),
            ref startupInfo,
            out processInfo);
        if (!ok)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
        }

        this.childProcessHandle = processInfo.hProcess;
        CloseHandleRef(ref processInfo.hThread);
    }

    private void StartThreads()
    {
        this.inputThread = new Thread(new ThreadStart(InputPump));
        this.inputThread.IsBackground = true;
        this.inputThread.Name = "rowpty input";
        this.inputThread.Start();

        this.outputThread = new Thread(new ThreadStart(OutputPump));
        this.outputThread.IsBackground = true;
        this.outputThread.Name = "rowpty output";
        this.outputThread.Start();

        if (this.options.StatusCommand != null)
        {
            this.fetchEvent = new AutoResetEvent(false);
            this.statusThread = new Thread(new ThreadStart(StatusFetcherLoop));
            this.statusThread.IsBackground = true;
            this.statusThread.Name = "rowpty status";
            this.statusThread.Start();
        }
    }

    private int RunMainLoop()
    {
        bool forcePaint = false;
        long nextSizeCheckMs = 0;
        long nextFetchMs = 0;
        long intervalMs = (long)(this.options.IntervalSeconds * 1000.0);
        if (intervalMs < 500)
        {
            intervalMs = 500;
        }

        while (true)
        {
            if (WaitForSingleObject(this.childProcessHandle, 0) == WAIT_OBJECT_0)
            {
                break;
            }

            long nowMs = this.clock.ElapsedMilliseconds;
            bool childOutputSeenNow;
            lock (this.stateLock)
            {
                childOutputSeenNow = this.childOutputSeen;
            }

            if (nowMs >= nextSizeCheckMs)
            {
                int cols;
                int rows;
                if (ReadConsoleSize(out cols, out rows))
                {
                    if (cols != this.currentCols || rows != this.currentRows)
                    {
                        int previousStatusRow = this.lastPaintedRow;
                        this.currentCols = cols;
                        this.currentRows = rows;
                        ClearStaleStatusRow(previousStatusRow);
                        ConfigureHostScrollRegion();
                        this.resizePseudoConsoleProvider(this.hPseudoConsole, MakeSize(cols, ChildRows(rows)));
                        if (childOutputSeenNow)
                        {
                            RequestStatusFetch(MaxStatusWidth(cols));
                            forcePaint = true;
                        }
                    }
                }
                nextSizeCheckMs = nowMs + 200;
            }

            if (childOutputSeenNow && this.options.StatusCommand != null && nowMs >= nextFetchMs)
            {
                RequestStatusFetch(MaxStatusWidth(this.currentCols));
                nextFetchMs = nowMs + intervalMs;
            }

            bool paintNow = forcePaint;
            bool forced = forcePaint;
            bool clearDirty = false;
            bool consumeForceRepaint = false;
            int version;
            lock (this.statusLock)
            {
                version = this.statusVersion;
            }

            lock (this.stateLock)
            {
                if (!this.childOutputSeen)
                {
                    paintNow = false;
                }
                else if (this.screenDirty && nowMs - this.lastOutputMs >= this.options.SettleMs)
                {
                    // Repaint ONLY when the child's output has settled -- it
                    // has finished a render and its cursor is at rest. This is
                    // the only place the reserved row is touched during normal
                    // operation. Painting mid-render (as the old immediate
                    // clear-repaint and the 750ms force-rewrite did) captured
                    // the child's cursor at a transient position, so the single
                    // hardware cursor bounced between the composer and the
                    // footer -- looking like two rapidly blinking cursors.
                    paintNow = true;
                    clearDirty = true;
                    if (!this.hostScrollRegionConfigured)
                    {
                        // No scroll region (the default): the child scrolls and
                        // erases the whole buffer natively, so it can overwrite
                        // the reserved bottom row at any time. Force the rewrite
                        // at every settle to keep the battery visible. This is
                        // still flicker-free: it only runs once the child has
                        // settled (cursor at rest), and the move->paint->restore
                        // is one atomic write, so the cursor never lands off the
                        // composer.
                        forced = true;
                    }
                    if (this.forceRepaintCount > 0)
                    {
                        // A clear/erase (ScanForClear) definitely wiped the row.
                        forced = true;
                        consumeForceRepaint = true;
                    }
                }

                if (this.childOutputSeen && !paintNow && !this.screenDirty
                    && version != this.paintedStatusVersion)
                {
                    // Battery text changed while the child is idle (no pending
                    // output). Safe to repaint now: the cursor is at rest, so
                    // reading it back for the restore lands in the right place.
                    paintNow = true;
                }
            }

            if (paintNow)
            {
                if (PaintStatus(forced, clearDirty, consumeForceRepaint, nowMs))
                {
                    forcePaint = false;
                }
            }

            Thread.Sleep(50);
        }

        WaitForSingleObject(this.childProcessHandle, INFINITE);
        uint exitCode;
        if (!GetExitCodeProcess(this.childProcessHandle, out exitCode))
        {
            exitCode = 1;
        }
        return unchecked((int)exitCode);
    }

    private void InputPump()
    {
        INPUT_RECORD[] records = new INPUT_RECORD[32];
        while (!this.stopping)
        {
            uint read;
            bool ok = ReadConsoleInputW(this.hStdIn, records, (uint)records.Length, out read);
            if (!ok || read == 0)
            {
                break;
            }

            uint i;
            for (i = 0; i < read; i++)
            {
                if (records[i].EventType != KEY_EVENT)
                {
                    continue;
                }

                KEY_EVENT_RECORD key = records[i].KeyEvent;
                RepairKeyEvent(ref key);

                if (this.win32InputModeEnabled)
                {
                    if (TryDropTerminalResponse(records, read, ref i))
                    {
                        continue;
                    }

                    byte[] sequence = EncodeWin32InputMode(key);
                    bool sequenceWritten;
                    lock (this.conptyInputWriteLock)
                    {
                        sequenceWritten = WriteAll(this.conptyInWrite, sequence, sequence.Length);
                    }
                    if (!sequenceWritten)
                    {
                        return;
                    }
                }
                else if (key.bKeyDown != 0 && key.UnicodeChar != (char)0)
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(new char[] { key.UnicodeChar });
                    bool bytesWritten;
                    lock (this.conptyInputWriteLock)
                    {
                        bytesWritten = WriteAll(this.conptyInWrite, bytes, bytes.Length);
                    }
                    if (!bytesWritten)
                    {
                        return;
                    }
                }
            }
        }
    }

    private static bool TryDropTerminalResponse(INPUT_RECORD[] records, uint read, ref uint index)
    {
        char ch;
        if (!TryGetKeyDownChar(records[index], out ch) || ch != (char)27)
        {
            return false;
        }

        uint j = index + 1;
        if (j >= read || !TryGetKeyDownChar(records[j], out ch) || ch != '[')
        {
            return false;
        }

        StringBuilder builder = new StringBuilder(64);
        builder.Append((char)27);
        builder.Append('[');
        j++;

        while (j < read && builder.Length < 64)
        {
            if (!TryGetKeyDownChar(records[j], out ch))
            {
                return false;
            }
            builder.Append(ch);

            if (ch == 'c' || ch == 'R' || ch == 't')
            {
                index = j;
                return true;
            }

            if (!((ch >= '0' && ch <= '?') || ch == ';'))
            {
                return false;
            }
            j++;
        }

        return false;
    }

    private static bool TryGetKeyDownChar(INPUT_RECORD record, out char ch)
    {
        ch = (char)0;
        if (record.EventType != KEY_EVENT)
        {
            return false;
        }
        KEY_EVENT_RECORD key = record.KeyEvent;
        if (key.bKeyDown == 0 || key.UnicodeChar == (char)0)
        {
            return false;
        }
        ch = key.UnicodeChar;
        return true;
    }

    private static void RepairKeyEvent(ref KEY_EVENT_RECORD key)
    {
        if (key.wVirtualKeyCode != 0 || key.UnicodeChar == (char)0)
        {
            return;
        }

        char ch = key.UnicodeChar;
        if (ch == (char)13)
        {
            key.wVirtualKeyCode = 13;
            return;
        }
        if (ch == (char)8 || ch == (char)127)
        {
            key.wVirtualKeyCode = 8;
            key.UnicodeChar = (char)8;
            return;
        }
        if (ch == (char)9)
        {
            key.wVirtualKeyCode = 9;
            return;
        }
        if (ch == (char)27)
        {
            key.wVirtualKeyCode = 27;
            return;
        }

        short vkey = VkKeyScanW(ch);
        if (vkey == -1)
        {
            return;
        }

        int packed = (int)vkey;
        int shiftState = (packed >> 8) & 0xff;
        key.wVirtualKeyCode = (ushort)(packed & 0xff);
        if ((shiftState & 1) != 0)
        {
            key.dwControlKeyState = key.dwControlKeyState | SHIFT_PRESSED;
        }
        if ((shiftState & 2) != 0)
        {
            key.dwControlKeyState = key.dwControlKeyState | LEFT_CTRL_PRESSED;
        }
        if ((shiftState & 4) != 0)
        {
            key.dwControlKeyState = key.dwControlKeyState | LEFT_ALT_PRESSED;
        }
    }

    private static byte[] EncodeWin32InputMode(KEY_EVENT_RECORD key)
    {
        StringBuilder builder = new StringBuilder(48);
        builder.Append('\u001b');
        builder.Append('[');
        builder.Append(((int)key.wVirtualKeyCode).ToString(CultureInfo.InvariantCulture));
        builder.Append(';');
        builder.Append(((int)key.wVirtualScanCode).ToString(CultureInfo.InvariantCulture));
        builder.Append(';');
        builder.Append(((int)key.UnicodeChar).ToString(CultureInfo.InvariantCulture));
        builder.Append(';');
        builder.Append((key.bKeyDown != 0 ? 1 : 0).ToString(CultureInfo.InvariantCulture));
        builder.Append(';');
        builder.Append(key.dwControlKeyState.ToString(CultureInfo.InvariantCulture));
        builder.Append(';');
        builder.Append(((int)key.wRepeatCount).ToString(CultureInfo.InvariantCulture));
        builder.Append('_');
        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    private void OutputPump()
    {
        byte[] buffer = new byte[16384];
        while (!this.stopping)
        {
            int read;
            bool ok = ReadFile(this.conptyOutRead, buffer, buffer.Length, out read, IntPtr.Zero);
            if (!ok || read <= 0)
            {
                break;
            }

            int currentVtState = this.outputVtState;
            bool clearSeen = ScanForClear(buffer, read);
            bool visibleTextSeen = ScanForVisibleText(currentVtState, buffer, read);
            int win32InputModeChange = ScanForWin32InputMode(buffer, read);
            int nextVtState = ScanVtState(currentVtState, buffer, read);
            if (win32InputModeChange > 0)
            {
                this.win32InputModeEnabled = true;
            }
            else if (win32InputModeChange < 0)
            {
                this.win32InputModeEnabled = false;
            }

            byte[] hostOutput = null;
            int hostOutputCount = read;
            // The DA1 probe arrives in the first chunks after startup; keep the
            // CSI rewriter engaged until it has been answered even when both
            // scrollback filters are disabled.
            if (this.preserveScrollback || this.filterAlternateScreen || !this.da1QueryAnswered)
            {
                hostOutput = FilterHostOutput(buffer, read);
                hostOutputCount = hostOutput.Length;
            }
            else
            {
                hostOutput = buffer;
            }

            lock (this.consoleLock)
            {
                if (hostOutputCount > 0)
                {
                    ClearPaintedStatusRowBeforeChildOutput();
                }

                if (hostOutputCount > 0 && !WriteHostOutput(hostOutput, hostOutputCount))
                {
                    break;
                }

                lock (this.stateLock)
                {
                    long nowMs = this.clock.ElapsedMilliseconds;
                    if (nextVtState != this.outputVtState)
                    {
                        this.outputVtState = nextVtState;
                        this.outputVtStateChangedMs = nowMs;
                    }
                    if (visibleTextSeen)
                    {
                        this.childOutputSeen = true;
                    }
                    this.lastOutputMs = nowMs;
                    this.screenDirty = true;
                    if (clearSeen)
                    {
                        this.forceRepaintCount = 3;
                    }
                }
            }
        }
    }

    private void StatusFetcherLoop()
    {
        while (true)
        {
            this.fetchEvent.WaitOne();

            int width;
            lock (this.fetchLock)
            {
                if (this.fetchStop)
                {
                    break;
                }
                width = this.fetchMaxWidth;
            }

            try
            {
                string command = this.options.StatusCommand.Replace("{MAXWIDTH}", width.ToString(CultureInfo.InvariantCulture));
                FetchStatus(command);
            }
            catch (Exception)
            {
            }
        }
    }

    private void FetchStatus(string commandLine)
    {
        string fileName;
        string arguments;
        SplitFirstCommandToken(commandLine, out fileName, out arguments);
        if (fileName.Length == 0)
        {
            return;
        }

        if (string.Equals(fileName, "cmd", StringComparison.OrdinalIgnoreCase))
        {
            string comspec = Environment.GetEnvironmentVariable("COMSPEC");
            if (comspec != null && comspec.Length > 0)
            {
                fileName = comspec;
            }
            else
            {
                fileName = "cmd.exe";
            }
        }

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = fileName;
        startInfo.Arguments = arguments;
        startInfo.UseShellExecute = false;
        startInfo.RedirectStandardOutput = true;
        startInfo.CreateNoWindow = true;
        startInfo.StandardOutputEncoding = Encoding.UTF8;

        Process process = null;
        Thread reader = null;
        OutputReaderState readerState = new OutputReaderState();
        bool exited = false;
        try
        {
            process = new Process();
            process.StartInfo = startInfo;
            if (!process.Start())
            {
                return;
            }

            reader = new Thread(delegate()
            {
                try
                {
                    readerState.Text = process.StandardOutput.ReadToEnd();
                }
                catch (Exception)
                {
                    readerState.Text = "";
                }
            });
            reader.IsBackground = true;
            reader.Start();

            exited = process.WaitForExit(1500);
            if (!exited)
            {
                try
                {
                    process.Kill();
                }
                catch (Exception)
                {
                }
                try
                {
                    process.WaitForExit(500);
                }
                catch (Exception)
                {
                }
            }

            if (reader != null)
            {
                reader.Join(500);
            }

            if (exited && process.ExitCode == 0)
            {
                string text = TrimTrailingCrLf(readerState.Text);
                if (text.Length > 0)
                {
                    lock (this.statusLock)
                    {
                        if (this.statusText != text)
                        {
                            this.statusText = text;
                            this.statusVersion++;
                        }
                    }
                }
            }
        }
        finally
        {
            if (process != null)
            {
                process.Dispose();
            }
        }
    }

    private void RequestStatusFetch(int width)
    {
        if (this.fetchEvent == null)
        {
            return;
        }
        lock (this.fetchLock)
        {
            this.fetchMaxWidth = width;
        }
        this.fetchEvent.Set();
    }

    private bool PaintStatus(bool forced, bool clearDirty, bool consumeForceRepaint, long nowMs)
    {
        string text;
        int version;
        lock (this.statusLock)
        {
            text = this.statusText;
            version = this.statusVersion;
        }

        int row = this.currentRows;
        int width = this.currentCols - 1;
        if (width < 1)
        {
            width = 1;
        }

        string line = FitStatusLine(text, width);
        bool needsWrite = forced || this.lastPaintedLine == null || this.lastPaintedRow != row || this.lastPaintedLine != line;

        lock (this.consoleLock)
        {
            lock (this.stateLock)
            {
                if (!CanPaintWithVtStateLocked(nowMs))
                {
                    return false;
                }

                if (consumeForceRepaint && this.forceRepaintCount > 0)
                {
                    this.forceRepaintCount--;
                }
                if (clearDirty)
                {
                    this.screenDirty = false;
                }
            }

            if (needsWrite)
            {
                WriteStatusRowPayload("\u001b[0m\r\u001b[1G" + line + "\u001b[K\u001b[0m");
            }

            this.lastPaintedLine = line;
            this.lastPaintedRow = row;
            this.paintedStatusVersion = version;
            this.lastPaintMs = this.clock.ElapsedMilliseconds;
        }

        return true;
    }

    private void ClearStaleStatusRow(int previousRow)
    {
        if (previousRow < 1 || previousRow == this.currentRows)
        {
            this.lastPaintedLine = null;
            return;
        }

        this.lastPaintedLine = null;
        this.lastPaintedRow = -1;
        if (previousRow > this.currentRows)
        {
            return;
        }

        lock (this.consoleLock)
        {
            WriteConsoleRowPayload(previousRow, "\u001b[0m\r\u001b[1G\u001b[2K\u001b[0m");
        }
    }

    private void ClearPaintedStatusRowBeforeChildOutput()
    {
        if (this.hostScrollRegionConfigured || this.lastPaintedRow < 1)
        {
            return;
        }

        int row = this.lastPaintedRow;
        this.lastPaintedLine = null;
        this.lastPaintedRow = -1;
        this.paintedStatusVersion = -1;
        WriteConsoleRowPayload(row, "\u001b[0m\r\u001b[1G\u001b[2K\u001b[0m");
    }

    private static bool HostScrollRegionEnabled()
    {
        // OFF by default. A DECSTBM bottom margin corrupts the host scrollback
        // on Windows (both Windows Terminal and legacy conhost captured the
        // fixed rows -- composer/footer/battery -- into scrollback as ghost
        // frames, and cmd's console host also offset the composer). Codex is an
        // inline app, so we let it scroll the main buffer natively and just
        // repaint the battery over the reserved bottom row. Opt back in with
        // ROWPTY_SCROLL_REGION=1 for terminals where the margin behaves.
        string value = Environment.GetEnvironmentVariable("ROWPTY_SCROLL_REGION");
        return value == "1" || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
    }

    private void ConfigureHostScrollRegion()
    {
        if (!HostScrollRegionEnabled() || !this.outputConfigured || this.hStdOut == IntPtr.Zero)
        {
            return;
        }

        int bottom = ChildRows(this.currentRows);
        if (bottom >= this.currentRows)
        {
            RestoreHostScrollRegion();
            return;
        }

        string payload = "\u001b7\u001b[1;" + bottom.ToString(CultureInfo.InvariantCulture) + "r\u001b8";
        lock (this.consoleLock)
        {
            WriteConsoleControlPayload(payload);
            this.hostScrollRegionConfigured = true;
        }
    }

    private void RestoreHostScrollRegion()
    {
        if (!this.outputConfigured || this.hStdOut == IntPtr.Zero || !this.hostScrollRegionConfigured)
        {
            return;
        }

        lock (this.consoleLock)
        {
            WriteConsoleControlPayload("\u001b7\u001b[r\u001b8");
            this.hostScrollRegionConfigured = false;
        }
    }

    private bool WriteConsoleControlPayload(string payload)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(payload);
        return WriteAll(this.hStdOut, bytes, bytes.Length);
    }

    private bool WriteConsoleRowPayload(int targetRow, string payload)
    {
        // Paint the reserved bottom row, then move the cursor back to wherever
        // the child left it -- all in ONE write. We already hold consoleLock,
        // so the child cannot move the cursor underneath us; reading it with
        // GetConsoleScreenBufferInfo lets us restore via an absolute CUP
        // (ESC[row;colH) instead of DECSC/DECRC (ESC 7 / ESC 8). That matters
        // because DECSC/DECRC share a SINGLE save slot: crossterm children
        // (Codex) use the same slot for their own save/restore, so painting
        // through it made Codex restore its cursor to our status row --
        // corrupting its layout and leaving the cursor flickering between
        // positions. A computed CUP touches no shared state, and folding both
        // moves into one write keeps the cursor off the status row (no flicker
        // the way two SetConsoleCursorPosition calls produced).
        char esc = (char)27;
        if (targetRow < 1 || targetRow > this.currentRows)
        {
            return true;
        }

        CONSOLE_SCREEN_BUFFER_INFO info;
        if (GetConsoleScreenBufferInfo(this.hStdOut, out info))
        {
            int savedRow = info.dwCursorPosition.Y - info.srWindow.Top + 1;
            int savedCol = info.dwCursorPosition.X - info.srWindow.Left + 1;
            if (savedRow < 1)
            {
                savedRow = 1;
            }
            if (savedRow > this.currentRows)
            {
                savedRow = this.currentRows;
            }
            if (savedCol < 1)
            {
                savedCol = 1;
            }
            if (savedCol > this.currentCols)
            {
                savedCol = this.currentCols;
            }
            string framed = esc + "[" + targetRow.ToString(CultureInfo.InvariantCulture) + ";1H"
                + payload
                + esc + "[" + savedRow.ToString(CultureInfo.InvariantCulture) + ";" + savedCol.ToString(CultureInfo.InvariantCulture) + "H";
            byte[] bytes = Encoding.UTF8.GetBytes(framed);
            return WriteAll(this.hStdOut, bytes, bytes.Length);
        }

        // Fallback when the cursor position is unavailable: pure VT DECSC/DECRC.
        string fallback = esc + "7" + esc + "[" + targetRow.ToString(CultureInfo.InvariantCulture) + ";1H" + payload + esc + "8";
        byte[] fallbackBytes = Encoding.UTF8.GetBytes(fallback);
        return WriteAll(this.hStdOut, fallbackBytes, fallbackBytes.Length);
    }

    private bool WriteStatusRowPayload(string payload)
    {
        return WriteConsoleRowPayload(this.currentRows, payload);
    }

    private static string FitStatusLine(string text, int width)
    {
        if (text == null)
        {
            text = "";
        }

        int visible = VisibleLength(text);
        string line;
        int lineVisible;
        if (visible > width)
        {
            string stripped = StripAnsi(text);
            if (stripped.Length > width)
            {
                stripped = stripped.Substring(0, width);
            }
            line = stripped;
            lineVisible = stripped.Length;
        }
        else
        {
            line = text;
            lineVisible = visible;
        }

        if (lineVisible < width)
        {
            line = line + new string(' ', width - lineVisible);
        }
        return line;
    }

    private static int VisibleLength(string text)
    {
        int count = 0;
        int i = 0;
        while (i < text.Length)
        {
            int next;
            if (TrySkipAnsi(text, i, out next))
            {
                i = next;
            }
            else
            {
                count++;
                i++;
            }
        }
        return count;
    }

    private static string StripAnsi(string text)
    {
        StringBuilder builder = new StringBuilder(text.Length);
        int i = 0;
        while (i < text.Length)
        {
            int next;
            if (TrySkipAnsi(text, i, out next))
            {
                i = next;
            }
            else
            {
                builder.Append(text[i]);
                i++;
            }
        }
        return builder.ToString();
    }

    private static bool TrySkipAnsi(string text, int index, out int nextIndex)
    {
        nextIndex = index;
        if (index + 2 > text.Length)
        {
            return false;
        }
        if (text[index] != (char)27 || text[index + 1] != '[')
        {
            return false;
        }

        int i = index + 2;
        while (i < text.Length && text[i] >= '0' && text[i] <= '?')
        {
            i++;
        }
        while (i < text.Length && text[i] >= ' ' && text[i] <= '/')
        {
            i++;
        }
        if (i < text.Length && text[i] >= '@' && text[i] <= '~')
        {
            nextIndex = i + 1;
            return true;
        }
        return false;
    }

    private bool ReadConsoleSize(out int cols, out int rows)
    {
        cols = this.currentCols;
        rows = this.currentRows;

        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(this.hStdOut, out info))
        {
            return false;
        }

        cols = info.srWindow.Right - info.srWindow.Left + 1;
        rows = info.srWindow.Bottom - info.srWindow.Top + 1;
        if (cols < 20)
        {
            cols = 20;
        }
        if (rows < 4)
        {
            rows = 4;
        }
        return true;
    }

    private int ChildRows(int rows)
    {
        int childRows = rows - this.options.ReserveRows;
        if (childRows < 1)
        {
            childRows = 1;
        }
        return childRows;
    }

    private static int MaxStatusWidth(int cols)
    {
        int width = cols - 4;
        if (width < 0)
        {
            width = 0;
        }
        return width;
    }

    private static COORD MakeSize(int cols, int rows)
    {
        COORD coord = new COORD();
        if (cols < 1)
        {
            cols = 1;
        }
        if (rows < 1)
        {
            rows = 1;
        }
        if (cols > short.MaxValue)
        {
            cols = short.MaxValue;
        }
        if (rows > short.MaxValue)
        {
            rows = short.MaxValue;
        }
        coord.X = (short)cols;
        coord.Y = (short)rows;
        return coord;
    }

    private static string BuildCommandLine(string[] args)
    {
        StringBuilder builder = new StringBuilder();
        int i;
        for (i = 0; i < args.Length; i++)
        {
            if (i > 0)
            {
                builder.Append(' ');
            }
            builder.Append(QuoteArg(args[i]));
        }
        return builder.ToString();
    }

    private static string QuoteArg(string arg)
    {
        if (arg == null)
        {
            arg = "";
        }

        bool needsQuotes = arg.Length == 0;
        int i;
        for (i = 0; i < arg.Length; i++)
        {
            char ch = arg[i];
            if (ch == ' ' || ch == '\t' || ch == '"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes)
        {
            return arg;
        }

        StringBuilder builder = new StringBuilder();
        builder.Append('"');
        int backslashes = 0;
        for (i = 0; i < arg.Length; i++)
        {
            char ch = arg[i];
            if (ch == '\\')
            {
                backslashes++;
            }
            else if (ch == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
            }
            else
            {
                if (backslashes > 0)
                {
                    builder.Append('\\', backslashes);
                    backslashes = 0;
                }
                builder.Append(ch);
            }
        }
        if (backslashes > 0)
        {
            builder.Append('\\', backslashes * 2);
        }
        builder.Append('"');
        return builder.ToString();
    }

    private static void SplitFirstCommandToken(string commandLine, out string fileName, out string arguments)
    {
        commandLine = commandLine == null ? "" : commandLine.TrimStart();
        fileName = "";
        arguments = "";
        if (commandLine.Length == 0)
        {
            return;
        }

        int i = 0;
        if (commandLine[0] == '"')
        {
            StringBuilder token = new StringBuilder();
            i = 1;
            while (i < commandLine.Length)
            {
                if (commandLine[i] == '"')
                {
                    i++;
                    break;
                }
                token.Append(commandLine[i]);
                i++;
            }
            fileName = token.ToString();
        }
        else
        {
            while (i < commandLine.Length && commandLine[i] != ' ' && commandLine[i] != '\t')
            {
                i++;
            }
            fileName = commandLine.Substring(0, i);
        }

        while (i < commandLine.Length && (commandLine[i] == ' ' || commandLine[i] == '\t'))
        {
            i++;
        }
        if (i < commandLine.Length)
        {
            arguments = commandLine.Substring(i);
        }
    }

    private static string TrimTrailingCrLf(string text)
    {
        if (text == null)
        {
            return "";
        }
        int end = text.Length;
        while (end > 0 && (text[end - 1] == '\r' || text[end - 1] == '\n'))
        {
            end--;
        }
        if (end == text.Length)
        {
            return text;
        }
        return text.Substring(0, end);
    }

    private static bool PreserveScrollbackEnabled()
    {
        string value = Environment.GetEnvironmentVariable("ROWPTY_PRESERVE_SCROLLBACK");
        if (value == null || value.Length == 0)
        {
            return true;
        }

        value = value.Trim().ToLowerInvariant();
        return !(value == "0" || value == "false" || value == "no" || value == "off");
    }

    private static bool FilterAlternateScreenEnabled()
    {
        string value = Environment.GetEnvironmentVariable("ROWPTY_FILTER_ALT_SCREEN");
        if (value == null || value.Length == 0)
        {
            return false;
        }

        value = value.Trim().ToLowerInvariant();
        return value == "1" || value == "true" || value == "yes" || value == "on";
    }

    private byte[] FilterHostOutput(byte[] buffer, int count)
    {
        byte[] input;
        int offset = 0;
        if (this.pendingHostOutput.Length > 0)
        {
            input = new byte[this.pendingHostOutput.Length + count];
            Buffer.BlockCopy(this.pendingHostOutput, 0, input, 0, this.pendingHostOutput.Length);
            Buffer.BlockCopy(buffer, 0, input, this.pendingHostOutput.Length, count);
            this.pendingHostOutput = new byte[0];
        }
        else
        {
            input = new byte[count];
            Buffer.BlockCopy(buffer, 0, input, 0, count);
        }

        System.Collections.Generic.List<byte> output = new System.Collections.Generic.List<byte>(count);
        while (offset < input.Length)
        {
            if (input[offset] != 27)
            {
                output.Add(input[offset]);
                offset++;
                continue;
            }

            if (offset + 1 >= input.Length)
            {
                break;
            }

            if (input[offset + 1] != (byte)'[')
            {
                output.Add(input[offset]);
                offset++;
                continue;
            }

            int parameterStart = offset + 2;
            int cursor = parameterStart;
            while (cursor < input.Length && input[cursor] >= 0x30 && input[cursor] <= 0x3f)
            {
                cursor++;
            }
            int parameterEnd = cursor;
            while (cursor < input.Length && input[cursor] >= 0x20 && input[cursor] <= 0x2f)
            {
                cursor++;
            }
            if (cursor >= input.Length)
            {
                break;
            }

            byte final = input[cursor];
            int sequenceEnd = cursor + 1;
            byte[] replacement = RewriteHostCsi(input, parameterStart, parameterEnd, cursor, final);
            if (replacement == null)
            {
                AppendBytes(output, input, offset, sequenceEnd - offset);
            }
            else if (replacement.Length > 0)
            {
                output.AddRange(replacement);
            }
            offset = sequenceEnd;
        }

        if (offset < input.Length)
        {
            int pending = input.Length - offset;
            this.pendingHostOutput = new byte[pending];
            Buffer.BlockCopy(input, offset, this.pendingHostOutput, 0, pending);
        }
        else
        {
            this.pendingHostOutput = new byte[0];
        }

        return output.ToArray();
    }

    private byte[] RewriteHostCsi(byte[] buffer, int parameterStart, int parameterEnd, int finalIndex, byte final)
    {
        if (IsDa1Query(buffer, parameterStart, parameterEnd, finalIndex, final))
        {
            AnswerDa1Query();
            return new byte[0];
        }

        if (this.preserveScrollback && final == (byte)'J')
        {
            if (CsiParamsContain(buffer, parameterStart, parameterEnd, 3))
            {
                return new byte[0];
            }
            if (CsiParamsContain(buffer, parameterStart, parameterEnd, 2))
            {
                return HostClearDisplayAction;
            }
            if (CsiParamsEmpty(buffer, parameterStart, parameterEnd) || CsiParamsContain(buffer, parameterStart, parameterEnd, 0))
            {
                return HostClearFromCursorAction;
            }
        }

        if (this.filterAlternateScreen &&
            (final == (byte)'h' || final == (byte)'l') &&
            parameterStart < parameterEnd &&
            buffer[parameterStart] == (byte)'?')
        {
            return RewritePrivateModeCsi(buffer, parameterStart, parameterEnd, finalIndex, final);
        }

        if ((final == (byte)'H' || final == (byte)'f' || final == (byte)'d') && parameterEnd == finalIndex)
        {
            return ClampCursorRowCsi(buffer, parameterStart, parameterEnd, final);
        }

        return null;
    }

    private byte[] ClampCursorRowCsi(byte[] buffer, int parameterStart, int parameterEnd, byte final)
    {
        // The passthrough ConPTY forwards absolute cursor rows verbatim, but
        // the child screen is --reserve rows shorter than the host console, so
        // an unclamped row (the common ESC[999;1H bottom-of-screen idiom) would
        // land on the reserved status row. The in-box conhost used to clamp
        // this while re-rendering; do the same here.
        if (parameterStart >= parameterEnd)
        {
            return null;
        }
        byte first = buffer[parameterStart];
        if (!((first >= (byte)'0' && first <= (byte)'9') || first == (byte)';'))
        {
            return null;
        }

        int maxRow = ChildRows(this.currentRows);
        string parameters = Encoding.ASCII.GetString(buffer, parameterStart, parameterEnd - parameterStart);
        string[] parts = parameters.Split(';');
        int row;
        if (parts[0].Length == 0 || !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out row) || row <= maxRow)
        {
            return null;
        }

        parts[0] = maxRow.ToString(CultureInfo.InvariantCulture);
        string rewritten = "\x1b[" + string.Join(";", parts) + ((char)final);
        return Encoding.ASCII.GetBytes(rewritten);
    }

    private static byte[] RewritePrivateModeCsi(byte[] buffer, int parameterStart, int parameterEnd, int finalIndex, byte final)
    {
        string parameters = Encoding.ASCII.GetString(buffer, parameterStart + 1, parameterEnd - parameterStart - 1);
        string[] parts = parameters.Split(';');
        System.Collections.Generic.List<string> kept = new System.Collections.Generic.List<string>(parts.Length);
        bool removed = false;
        int i;
        for (i = 0; i < parts.Length; i++)
        {
            string part = parts[i];
            if (IsAlternateScreenMode(part))
            {
                removed = true;
            }
            else if (part.Length > 0)
            {
                kept.Add(part);
            }
        }

        if (!removed)
        {
            return null;
        }
        if (kept.Count == 0)
        {
            return new byte[0];
        }

        StringBuilder builder = new StringBuilder();
        builder.Append("\u001b[?");
        for (i = 0; i < kept.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(';');
            }
            builder.Append(kept[i]);
        }
        if (parameterEnd < finalIndex)
        {
            builder.Append(Encoding.ASCII.GetString(buffer, parameterEnd, finalIndex - parameterEnd));
        }
        builder.Append((char)final);
        return Encoding.ASCII.GetBytes(builder.ToString());
    }

    private static bool IsAlternateScreenMode(string part)
    {
        int colon = part.IndexOf(':');
        if (colon >= 0)
        {
            part = part.Substring(0, colon);
        }
        return part == "47" || part == "1047" || part == "1048" || part == "1049";
    }

    private static bool CsiParamsContain(byte[] buffer, int start, int end, int target)
    {
        int value = 0;
        bool haveValue = false;
        int i;
        for (i = start; i <= end; i++)
        {
            byte b = i < end ? buffer[i] : (byte)';';
            if (b >= (byte)'0' && b <= (byte)'9')
            {
                haveValue = true;
                value = (value * 10) + (b - (byte)'0');
            }
            else
            {
                if (haveValue && value == target)
                {
                    return true;
                }
                value = 0;
                haveValue = false;
            }
        }
        return false;
    }

    private static bool IsDa1Query(byte[] buffer, int parameterStart, int parameterEnd, int finalIndex, byte final)
    {
        // Plain ESC[c or ESC[0c only. DA2 (ESC[>c) and DA1 responses
        // (ESC[?...c) carry prefix parameter bytes and must pass through.
        if (final != (byte)'c' || parameterEnd != finalIndex)
        {
            return false;
        }
        if (parameterStart == parameterEnd)
        {
            return true;
        }
        return (parameterEnd - parameterStart) == 1 && buffer[parameterStart] == (byte)'0';
    }

    private void AnswerDa1Query()
    {
        this.da1QueryAnswered = true;
        if (this.conptyInWrite == IntPtr.Zero)
        {
            return;
        }
        lock (this.conptyInputWriteLock)
        {
            WriteAll(this.conptyInWrite, Da1Response, Da1Response.Length);
        }
    }

    private static bool CsiParamsEmpty(byte[] buffer, int start, int end)
    {
        int i;
        for (i = start; i < end; i++)
        {
            byte b = buffer[i];
            if (b >= (byte)'0' && b <= (byte)'9')
            {
                return false;
            }
        }
        return true;
    }

    private static void AppendBytes(System.Collections.Generic.List<byte> output, byte[] input, int offset, int count)
    {
        int i;
        for (i = 0; i < count; i++)
        {
            output.Add(input[offset + i]);
        }
    }

    private static bool ScanForClear(byte[] buffer, int count)
    {
        int i;
        for (i = 0; i < count; i++)
        {
            if (buffer[i] != 27)
            {
                continue;
            }
            if (i + 1 < count && buffer[i + 1] == (byte)'c')
            {
                return true;
            }
            if (i + 2 < count && buffer[i + 1] == (byte)'[' && buffer[i + 2] == (byte)'J')
            {
                return true;
            }
            if (i + 3 < count && buffer[i + 1] == (byte)'[' && buffer[i + 2] == (byte)'0' && buffer[i + 3] == (byte)'J')
            {
                return true;
            }
            if (i + 3 < count && buffer[i + 1] == (byte)'[' && (buffer[i + 2] == (byte)'2' || buffer[i + 2] == (byte)'3') && buffer[i + 3] == (byte)'J')
            {
                return true;
            }
            if (i + 7 < count &&
                buffer[i + 1] == (byte)'[' &&
                buffer[i + 2] == (byte)'?' &&
                buffer[i + 3] == (byte)'1' &&
                buffer[i + 4] == (byte)'0' &&
                buffer[i + 5] == (byte)'4' &&
                buffer[i + 6] == (byte)'9' &&
                (buffer[i + 7] == (byte)'h' || buffer[i + 7] == (byte)'l'))
            {
                return true;
            }
        }
        return false;
    }

    private static int ScanForWin32InputMode(byte[] buffer, int count)
    {
        int mode = 0;
        int i;
        for (i = 0; i < count; i++)
        {
            if (buffer[i] != 27)
            {
                continue;
            }
            if (i + 7 < count &&
                buffer[i + 1] == (byte)'[' &&
                buffer[i + 2] == (byte)'?' &&
                buffer[i + 3] == (byte)'9' &&
                buffer[i + 4] == (byte)'0' &&
                buffer[i + 5] == (byte)'0' &&
                buffer[i + 6] == (byte)'1' &&
                (buffer[i + 7] == (byte)'h' || buffer[i + 7] == (byte)'l'))
            {
                mode = buffer[i + 7] == (byte)'h' ? 1 : -1;
            }
        }
        return mode;
    }

    private static int ScanVtState(int state, byte[] buffer, int count)
    {
        int i;
        for (i = 0; i < count; i++)
        {
            byte b = buffer[i];
            if (state == VT_STATE_GROUND)
            {
                if (b == 27)
                {
                    state = VT_STATE_ESC;
                }
            }
            else if (state == VT_STATE_ESC)
            {
                state = VtEscTransition(b);
            }
            else if (state == VT_STATE_CSI)
            {
                if (b >= 0x40 && b <= 0x7e)
                {
                    state = VT_STATE_GROUND;
                }
            }
            else if (state == VT_STATE_OSC)
            {
                if (b == 7)
                {
                    state = VT_STATE_GROUND;
                }
                else if (b == 27)
                {
                    state = VT_STATE_OSC_ESC;
                }
            }
            else if (state == VT_STATE_DCS)
            {
                if (b == 7)
                {
                    state = VT_STATE_GROUND;
                }
                else if (b == 27)
                {
                    state = VT_STATE_DCS_ESC;
                }
            }
            else if (state == VT_STATE_OSC_ESC)
            {
                if (b == (byte)'\\')
                {
                    state = VT_STATE_GROUND;
                }
                else
                {
                    state = VtEscTransition(b);
                }
            }
            else if (state == VT_STATE_DCS_ESC)
            {
                if (b == (byte)'\\')
                {
                    state = VT_STATE_GROUND;
                }
                else
                {
                    state = VtEscTransition(b);
                }
            }
            else
            {
                state = VT_STATE_GROUND;
            }
        }
        return state;
    }

    private static bool ScanForVisibleText(int state, byte[] buffer, int count)
    {
        int i;
        for (i = 0; i < count; i++)
        {
            byte b = buffer[i];
            if (state == VT_STATE_GROUND)
            {
                if (b == 27)
                {
                    state = VT_STATE_ESC;
                }
                else if (b > 0x20 && b != 0x7f)
                {
                    return true;
                }
            }
            else if (state == VT_STATE_ESC)
            {
                state = VtEscTransition(b);
            }
            else if (state == VT_STATE_CSI)
            {
                if (b >= 0x40 && b <= 0x7e)
                {
                    state = VT_STATE_GROUND;
                }
            }
            else if (state == VT_STATE_OSC)
            {
                if (b == 7)
                {
                    state = VT_STATE_GROUND;
                }
                else if (b == 27)
                {
                    state = VT_STATE_OSC_ESC;
                }
            }
            else if (state == VT_STATE_DCS)
            {
                if (b == 7)
                {
                    state = VT_STATE_GROUND;
                }
                else if (b == 27)
                {
                    state = VT_STATE_DCS_ESC;
                }
            }
            else if (state == VT_STATE_OSC_ESC)
            {
                if (b == (byte)'\\')
                {
                    state = VT_STATE_GROUND;
                }
                else
                {
                    state = VtEscTransition(b);
                }
            }
            else if (state == VT_STATE_DCS_ESC)
            {
                if (b == (byte)'\\')
                {
                    state = VT_STATE_GROUND;
                }
                else
                {
                    state = VtEscTransition(b);
                }
            }
            else
            {
                state = VT_STATE_GROUND;
            }
        }
        return false;
    }

    private static int VtEscTransition(byte b)
    {
        if (b == (byte)'[')
        {
            return VT_STATE_CSI;
        }
        if (b == (byte)']')
        {
            return VT_STATE_OSC;
        }
        if (b == (byte)'P' || b == (byte)'X' || b == (byte)'^' || b == (byte)'_')
        {
            return VT_STATE_DCS;
        }
        return VT_STATE_GROUND;
    }

    private bool CanPaintWithVtStateLocked(long nowMs)
    {
        if (this.outputVtState == VT_STATE_GROUND)
        {
            return true;
        }
        return nowMs - this.outputVtStateChangedMs >= 2000;
    }

    private bool WriteHostOutput(byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int displayClear = IndexOfBytes(buffer, offset, count, HostClearDisplayAction);
            int cursorClear = IndexOfBytes(buffer, offset, count, HostClearFromCursorAction);
            int marker = -1;
            byte[] action = null;
            if (displayClear >= 0 && (cursorClear < 0 || displayClear < cursorClear))
            {
                marker = displayClear;
                action = HostClearDisplayAction;
            }
            else if (cursorClear >= 0)
            {
                marker = cursorClear;
                action = HostClearFromCursorAction;
            }

            if (marker < 0)
            {
                return WriteSlice(this.hStdOut, buffer, offset, count - offset);
            }

            if (marker > offset && !WriteSlice(this.hStdOut, buffer, offset, marker - offset))
            {
                return false;
            }

            if (action == HostClearDisplayAction)
            {
                ClearVisibleConsoleWindow();
            }
            else
            {
                ClearConsoleFromCursorToBottom();
            }
            offset = marker + action.Length;
        }
        return true;
    }

    private static int IndexOfBytes(byte[] buffer, int offset, int count, byte[] needle)
    {
        int end = count - needle.Length;
        int i;
        for (i = offset; i <= end; i++)
        {
            int j;
            for (j = 0; j < needle.Length; j++)
            {
                if (buffer[i + j] != needle[j])
                {
                    break;
                }
            }
            if (j == needle.Length)
            {
                return i;
            }
        }
        return -1;
    }

    private static bool WriteSlice(IntPtr handle, byte[] buffer, int offset, int count)
    {
        if (count <= 0)
        {
            return true;
        }
        byte[] slice = new byte[count];
        Buffer.BlockCopy(buffer, offset, slice, 0, count);
        return WriteAll(handle, slice, count);
    }

    private bool ClearVisibleConsoleWindow()
    {
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(this.hStdOut, out info))
        {
            return false;
        }

        int width = Math.Max(1, info.srWindow.Right - info.srWindow.Left + 1);
        short y;
        for (y = info.srWindow.Top; y <= info.srWindow.Bottom; y++)
        {
            ClearConsoleRange(info, info.srWindow.Left, y, width);
        }
        return true;
    }

    private bool ClearConsoleFromCursorToBottom()
    {
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(this.hStdOut, out info))
        {
            return false;
        }

        int left = info.srWindow.Left;
        int right = info.srWindow.Right;
        int width = Math.Max(1, right - left + 1);
        int cursorX = Math.Max(left, Math.Min(right, info.dwCursorPosition.X));
        int cursorY = Math.Max(info.srWindow.Top, Math.Min(info.srWindow.Bottom, info.dwCursorPosition.Y));

        ClearConsoleRange(info, (short)cursorX, (short)cursorY, right - cursorX + 1);
        short y;
        for (y = (short)(cursorY + 1); y <= info.srWindow.Bottom; y++)
        {
            ClearConsoleRange(info, (short)left, y, width);
        }
        return true;
    }

    private bool ClearConsoleRange(CONSOLE_SCREEN_BUFFER_INFO info, short x, short y, int length)
    {
        COORD origin = new COORD();
        origin.X = x;
        origin.Y = y;
        uint written;
        bool ok = FillConsoleOutputCharacterW(this.hStdOut, ' ', (uint)Math.Max(0, length), origin, out written);
        uint attrWritten;
        FillConsoleOutputAttribute(this.hStdOut, (ushort)info.wAttributes, (uint)Math.Max(0, length), origin, out attrWritten);
        return ok;
    }

    private static bool WriteAll(IntPtr handle, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int remaining = count - offset;
            byte[] toWrite;
            if (offset == 0)
            {
                toWrite = buffer;
            }
            else
            {
                toWrite = new byte[remaining];
                Buffer.BlockCopy(buffer, offset, toWrite, 0, remaining);
            }

            int written;
            bool ok = WriteFile(handle, toWrite, remaining, out written, IntPtr.Zero);
            if (!ok || written <= 0)
            {
                return false;
            }
            offset += written;
        }
        return true;
    }

    private void ClearStatusRow()
    {
        if (!this.outputConfigured || this.hStdOut == IntPtr.Zero)
        {
            return;
        }

        lock (this.consoleLock)
        {
            WriteStatusRowPayload("\u001b[0m\r\u001b[1G\u001b[2K\u001b[0m");
        }
    }

    private void Cleanup()
    {
        lock (this.cleanupLock)
        {
            if (this.cleanupStarted)
            {
                return;
            }
            this.cleanupStarted = true;
            this.stopping = true;
        }

        if (this.fetchEvent != null)
        {
            lock (this.fetchLock)
            {
                this.fetchStop = true;
            }
            this.fetchEvent.Set();
        }

        if (this.hPseudoConsole != IntPtr.Zero)
        {
            this.closePseudoConsoleProvider(this.hPseudoConsole);
            this.hPseudoConsole = IntPtr.Zero;
        }

        CloseHandleRef(ref this.conptyInRead);
        CloseHandleRef(ref this.conptyInWrite);
        CloseHandleRef(ref this.conptyOutRead);
        CloseHandleRef(ref this.conptyOutWrite);

        JoinThread(this.inputThread, 500);
        JoinThread(this.outputThread, 500);
        JoinThread(this.statusThread, 2000);

        RestoreHostScrollRegion();
        ClearStatusRow();

        if (this.consoleStateSaved)
        {
            SetConsoleMode(this.hStdIn, this.originalInputMode);
            SetConsoleMode(this.hStdOut, this.originalOutputMode);
            SetConsoleCP(this.originalConsoleCP);
            SetConsoleOutputCP(this.originalConsoleOutputCP);
        }

        if (this.ctrlHandlerInstalled)
        {
            SetConsoleCtrlHandler(CtrlDelegate, false);
            this.ctrlHandlerInstalled = false;
        }

        if (activeInstance == this)
        {
            activeInstance = null;
        }

        CloseHandleRef(ref this.childProcessHandle);

        if (this.attributeList != IntPtr.Zero)
        {
            DeleteProcThreadAttributeList(this.attributeList);
            Marshal.FreeHGlobal(this.attributeList);
            this.attributeList = IntPtr.Zero;
        }

        if (this.fetchEvent != null)
        {
            this.fetchEvent.Close();
            this.fetchEvent = null;
        }

        if (this.conptyProviderLibrary != IntPtr.Zero)
        {
            FreeLibrary(this.conptyProviderLibrary);
            this.conptyProviderLibrary = IntPtr.Zero;
        }
    }

    private static void JoinThread(Thread thread, int milliseconds)
    {
        if (thread == null)
        {
            return;
        }
        try
        {
            thread.Join(milliseconds);
        }
        catch (ThreadStateException)
        {
        }
    }

    private static void CloseHandleRef(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }

    private static bool ConsoleCtrlHandler(uint ctrlType)
    {
        if (ctrlType == CTRL_C_EVENT || ctrlType == CTRL_BREAK_EVENT)
        {
            return true;
        }
        if (ctrlType == CTRL_CLOSE_EVENT)
        {
            RowPty instance = activeInstance;
            if (instance != null)
            {
                instance.Cleanup();
            }
            return false;
        }
        return false;
    }

    private sealed class Options
    {
        public double IntervalSeconds;
        public int ReserveRows;
        public string StatusCommand;
        public int SettleMs;
        public string[] ChildArgs;
    }

    private sealed class OutputReaderState
    {
        public string Text = "";
    }

    private sealed class UsageException : Exception
    {
        public UsageException(string message)
            : base(message)
        {
        }
    }

    private delegate bool ConsoleCtrlDelegate(uint ctrlType);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int CreatePseudoConsoleDelegate(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int ResizePseudoConsoleDelegate(IntPtr hPC, COORD size);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ClosePseudoConsoleDelegate(IntPtr hPC);

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SMALL_RECT
    {
        public short Left;
        public short Top;
        public short Right;
        public short Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CONSOLE_SCREEN_BUFFER_INFO
    {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public short wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct KEY_EVENT_RECORD
    {
        public int bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUT_RECORD
    {
        [FieldOffset(0)]
        public ushort EventType;
        [FieldOffset(4)]
        public KEY_EVENT_RECORD KeyEvent;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);

    [DllImport("kernel32.dll")]
    private static extern uint GetConsoleCP();

    [DllImport("kernel32.dll")]
    private static extern uint GetConsoleOutputCP();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCP(uint wCodePageID);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleOutputCP(uint wCodePageID);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate handlerRoutine, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleScreenBufferInfo(IntPtr hConsoleOutput, out CONSOLE_SCREEN_BUFFER_INFO lpConsoleScreenBufferInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCursorPosition(IntPtr hConsoleOutput, COORD dwCursorPosition);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool FillConsoleOutputCharacterW(IntPtr hConsoleOutput, char cCharacter, uint nLength, COORD dwWriteCoord, out uint lpNumberOfCharsWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FillConsoleOutputAttribute(IntPtr hConsoleOutput, ushort wAttribute, uint nLength, COORD dwWriteCoord, out uint lpNumberOfAttrsWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, int nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToRead, out int lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ReadConsoleInputW(IntPtr hConsoleInput, [Out] INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToWrite, out int lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern short VkKeyScanW(char ch);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "CreatePseudoConsole")]
    private static extern int KernelCreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", EntryPoint = "ClosePseudoConsole")]
    private static extern void KernelClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", EntryPoint = "ResizePseudoConsole")]
    private static extern int KernelResizePseudoConsole(IntPtr hPC, COORD size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true, EntryPoint = "LoadLibraryW")]
    private static extern IntPtr LoadLibraryW(string lpFileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true, EntryPoint = "GetProcAddress")]
    private static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr hModule);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
}
