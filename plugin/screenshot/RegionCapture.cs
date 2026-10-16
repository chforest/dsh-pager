using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal sealed class RegionCapture : Form {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder data, int bytes, out int needed);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", SetLastError = true)] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsProcessDPIAware();
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr window, int index);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    bool NativeTopmost() { return ((IntPtr.Size == 8 ? GetWindowLongPtr64(Handle, -20).ToInt64() : GetWindowLong32(Handle, -20)) & 8) != 0; }
    string HitBits() {
        StringBuilder bits = new StringBuilder();
        foreach (Screen screen in Screen.AllScreens) {
            Rectangle r = Rectangle.Intersect(screen.Bounds, Bounds);
            if (r.Width < 8 || r.Height < 8) continue;
            foreach (Point p in new Point[] { new Point(r.Left + r.Width / 4, r.Top + r.Height / 4), new Point(r.Left + r.Width / 2, r.Top + r.Height / 2), new Point(r.Left + r.Width * 3 / 4, r.Top + r.Height * 3 / 4) })
                bits.Append(GetAncestor(WindowFromPoint(p), 2) == Handle ? '1' : '0');
        }
        return bits.ToString();
    }
    static string ObjectName(IntPtr obj) {
        if (obj == IntPtr.Zero) return "unavailable";
        StringBuilder name = new StringBuilder(256); int needed;
        if (!GetUserObjectInformation(obj, 2, name, name.Capacity * 2, out needed)) return "unavailable";
        string value = name.ToString();
        foreach (char c in value) if (!Char.IsLetterOrDigit(c) && c != '_' && c != '-' && c != '.') return "other";
        return value;
    }
    static void Diagnostic(string value) {
        // Lifecycle/geometry only. Never log pixels, text from screen or image paths.
        try {
            string file = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "status.log");
            if (File.Exists(file) && new FileInfo(file).Length > 262144) return;
            File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " pid=" + Process.GetCurrentProcess().Id + " " + value + Environment.NewLine);
        } catch { }
    }
    void WindowDiagnostic(string phase) {
        IntPtr hwnd = IsHandleCreated ? Handle : IntPtr.Zero;
        int cloaked = -1, cloakResult = hwnd == IntPtr.Zero ? -1 : DwmGetWindowAttribute(hwnd, 14, out cloaked, 4);
        uint dpi = hwnd == IntPtr.Zero ? 0 : GetDpiForWindow(hwnd);
        Diagnostic(phase + " bounds=" + Bounds + " client=" + ClientRectangle + " handle=" + hwnd.ToInt64().ToString("x") + " managedVisible=" + Visible + " nativeVisible=" + (hwnd != IntPtr.Zero && IsWindowVisible(hwnd)) + " foregroundSelf=" + (hwnd != IntPtr.Zero && GetForegroundWindow() == hwnd) + " cloaked=" + cloaked + " cloakResult=" + cloakResult + " dpi=" + dpi + " dpiAware=" + IsProcessDPIAware() + " topmost=" + (hwnd != IntPtr.Zero && NativeTopmost()) + " hitSelf=" + (hwnd == IntPtr.Zero ? "none" : HitBits()));
    }
    readonly Bitmap frozen;
    readonly Timer deadline = new Timer();
    readonly Timer settle = new Timer();
    readonly Button confirm = new Button();
    Point origin;
    Rectangle selection;
    bool dragging;
    bool painted;
    public Bitmap Result;
    public bool ActivationFailed;

    public RegionCapture(Bitmap screen, Rectangle bounds) {
        frozen = screen;
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = bounds;
        TopMost = true;
        ShowInTaskbar = false;
        KeyPreview = true;
        Cursor = Cursors.Cross;
        DoubleBuffered = true;
        Text = "DSH 框选截图";
        confirm.Text = "确认 (Enter)";
        confirm.Size = new Size(120, 36);
        confirm.Visible = false;
        confirm.Click += delegate { Confirm(); };
        Controls.Add(confirm);
        deadline.Interval = 90000; deadline.Tick += delegate { WindowDiagnostic("TIMEOUT"); Close(); }; deadline.Start();
        HandleCreated += delegate { WindowDiagnostic("HANDLE_CREATED"); };
        VisibleChanged += delegate { WindowDiagnostic("VISIBLE_CHANGED"); };
        Activated += delegate { WindowDiagnostic("ACTIVATED"); };
        Deactivate += delegate { WindowDiagnostic("DEACTIVATED"); };
        FormClosing += delegate { WindowDiagnostic("CLOSING"); };
        settle.Interval = 150;
        settle.Tick += delegate { settle.Stop(); SettleTopmost(); };
        Load += delegate { WindowDiagnostic("LOAD"); };
        Shown += delegate {
            WindowDiagnostic("SHOWN_BEFORE_ACTIVATE");
            ShowWindow(Handle, 5);
            bool positioned = SetWindowPos(Handle, new IntPtr(-1), bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x0040);
            BringToFront(); Activate(); Focus();
            bool activated = SetForegroundWindow(Handle);
            // One user-requested focus bridge on the already validated local
            // Default desktop. No keys, foreign window manipulation or retry loop.
            if (!activated && GetForegroundWindow() != Handle) {
                uint foregroundProcess;
                uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundProcess);
                uint ownThread = GetCurrentThreadId();
                bool attached = false;
                try {
                    if (foregroundThread != 0 && foregroundThread != ownThread) attached = AttachThreadInput(ownThread, foregroundThread, true);
                    Diagnostic("FOCUS_BRIDGE attached=" + attached);
                    if (attached) {
                        activated = SetForegroundWindow(Handle);
                        SetFocus(Handle);
                    }
                } finally {
                    if (attached) {
                        bool detached = AttachThreadInput(ownThread, foregroundThread, false);
                        Diagnostic("FOCUS_BRIDGE detached=" + detached);
                        if (!detached) ActivationFailed = true;
                    }
                }
            }
            Diagnostic("ACTIVATE setWindowPos=" + positioned + " setForeground=" + activated);
            // Activation can reorder windows. Final placement must follow it.
            positioned = SetWindowPos(Handle, new IntPtr(-1), bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x0050) && positioned;
            WindowDiagnostic("SHOWN_AFTER_ACTIVATE");
            int cloaked;
            int hr = DwmGetWindowAttribute(Handle, 14, out cloaked, 4);
            if (ActivationFailed || !positioned || !IsWindowVisible(Handle) || hr != 0 || cloaked != 0 || GetForegroundWindow() != Handle) {
                Console.Error.WriteLine("REGION_CAPTURE:ACTIVATION_FAILED");
                Diagnostic("ACTIVATION_FAILED"); ActivationFailed = true; Close(); return;
            }
            Console.Error.WriteLine("REGION_CAPTURE:SHOWN");
        };
        Diagnostic("CONSTRUCTED requestedBounds=" + bounds + " actualBounds=" + Bounds);
    }
    void SettleTopmost() {
        if (IsDisposed || Disposing) return;
        WindowDiagnostic("SETTLE_BEFORE");
        IntPtr input = OpenInputDesktop(0, false, 1);
        string inputName = ObjectName(input);
        if (input != IntPtr.Zero) CloseDesktop(input);
        if (WTSGetActiveConsoleSessionId() != (uint)Process.GetCurrentProcess().SessionId || !String.Equals(inputName, "Default", StringComparison.OrdinalIgnoreCase)) {
            ActivationFailed = true; Console.Error.WriteLine("REGION_CAPTURE:ACTIVATION_FAILED"); Close(); return;
        }
        // One delayed correction of our own window, never a periodic focus loop.
        bool positioned = SetWindowPos(Handle, new IntPtr(-1), Left, Top, Width, Height, 0x0050);
        if (GetForegroundWindow() != Handle) {
            uint processId;
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out processId), ownThread = GetCurrentThreadId();
            bool attached = false;
            try {
                if (foregroundThread != 0 && foregroundThread != ownThread) attached = AttachThreadInput(ownThread, foregroundThread, true);
                Diagnostic("SETTLE_FOCUS attached=" + attached);
                if (attached) { SetForegroundWindow(Handle); SetFocus(Handle); }
            } finally {
                if (attached) { bool detached = AttachThreadInput(ownThread, foregroundThread, false); Diagnostic("SETTLE_FOCUS detached=" + detached); if (!detached) ActivationFailed = true; }
            }
        }
        positioned = SetWindowPos(Handle, new IntPtr(-1), Left, Top, Width, Height, 0x0050) && positioned;
        WindowDiagnostic("SETTLED");
        string hits = HitBits();
        int cloaked;
        if (ActivationFailed || !positioned || !NativeTopmost() || !IsWindowVisible(Handle) || DwmGetWindowAttribute(Handle, 14, out cloaked, 4) != 0 || cloaked != 0 || hits.Length == 0 || hits.IndexOf('0') >= 0) {
            ActivationFailed = true; Diagnostic("SETTLE_FAILED"); Console.Error.WriteLine("REGION_CAPTURE:ACTIVATION_FAILED"); Close();
        }
    }
    static Rectangle Normalized(Point a, Point b, Size bounds) {
        int left = Math.Max(0, Math.Min(a.X, b.X)), top = Math.Max(0, Math.Min(a.Y, b.Y));
        int right = Math.Min(bounds.Width, Math.Max(a.X, b.X)), bottom = Math.Min(bounds.Height, Math.Max(a.Y, b.Y));
        return Rectangle.FromLTRB(left, top, Math.Max(left, right), Math.Max(top, bottom));
    }
    protected override void OnMouseDown(MouseEventArgs e) {
        base.OnMouseDown(e);
        if (e.Button == MouseButtons.Right) { Diagnostic("RIGHT_CANCEL"); Close(); return; }
        if (e.Button != MouseButtons.Left) return;
        Diagnostic("DRAG_START");
        confirm.Visible = false;
        origin = e.Location; selection = Rectangle.Empty; dragging = true; Capture = true; Invalidate();
    }
    protected override void OnMouseMove(MouseEventArgs e) {
        base.OnMouseMove(e);
        if (dragging) { selection = Normalized(origin, e.Location, frozen.Size); Invalidate(); }
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        base.OnMouseUp(e);
        if (!dragging || e.Button != MouseButtons.Left) return;
        Diagnostic("DRAG_END");
        selection = Normalized(origin, e.Location, frozen.Size); dragging = false; Capture = false;
        if (selection.Width >= 2 && selection.Height >= 2) {
            int x = Math.Max(0, Math.Min(ClientSize.Width - 125, selection.Right - 125));
            int y = Math.Max(0, Math.Min(ClientSize.Height - 42, selection.Bottom + 5));
            confirm.Location = new Point(x, y);
            confirm.Visible = true;
        }
        Invalidate();
    }
    protected override void OnKeyDown(KeyEventArgs e) {
        if (e.KeyCode == Keys.Escape) { e.Handled = true; Close(); }
        else if (e.KeyCode == Keys.Enter) { e.Handled = true; Confirm(); }
        base.OnKeyDown(e);
    }
    void Confirm() {
        if (dragging || selection.Width < 2 || selection.Height < 2) return;
        Console.Error.WriteLine("REGION_CAPTURE:CONFIRMED");
        Diagnostic("CONFIRMED");
        Result = frozen.Clone(selection, PixelFormat.Format32bppArgb); Close();
    }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.DrawImageUnscaled(frozen, 0, 0);
        using (Brush shade = new SolidBrush(Color.FromArgb(115, 0, 0, 0))) e.Graphics.FillRectangle(shade, ClientRectangle);
        if (selection.Width > 0 && selection.Height > 0) {
            e.Graphics.DrawImage(frozen, selection, selection, GraphicsUnit.Pixel);
            using (Pen border = new Pen(Color.FromArgb(40, 190, 255), 2)) e.Graphics.DrawRectangle(border, selection);
        }
        using (Font font = new Font("Microsoft YaHei UI", 12))
        using (Brush background = new SolidBrush(Color.FromArgb(220, 30, 30, 30))) {
            // Position instructions on the monitor under the pointer, not a gap between displays.
            Point pointer = PointToClient(Cursor.Position);
            Rectangle monitor = Screen.FromPoint(Cursor.Position).Bounds;
            int x = Math.Max(12, monitor.Left - Left + 16), y = Math.Max(12, monitor.Top - Top + 16);
            e.Graphics.FillRectangle(background, x, y, 580, 38);
            e.Graphics.DrawString("拖动选择范围，确认后加入草稿 · Esc / 右键取消", font, Brushes.White, x + 10, y + 8);
        }
        base.OnPaint(e);
        if (!painted) {
            painted = true; Diagnostic("PAINTED");
            settle.Start();
        }
    }
    protected override void Dispose(bool disposing) {
        if (disposing) { deadline.Dispose(); settle.Dispose(); }
        base.Dispose(disposing);
    }
    static byte[] Encode(Bitmap image) {
        using (MemoryStream stream = new MemoryStream()) { image.Save(stream, ImageFormat.Png); return stream.ToArray(); }
    }
    static void SelfTest() {
        Rectangle r = Normalized(new Point(7, 8), new Point(-3, 2), new Size(10, 10));
        if (r != new Rectangle(0, 2, 7, 6)) throw new Exception("rectangle clipping failed");
        using (Bitmap source = new Bitmap(10, 10)) {
            source.SetPixel(3, 4, Color.Red);
            using (Bitmap clip = source.Clone(new Rectangle(3, 4, 2, 3), PixelFormat.Format32bppArgb)) {
                byte[] bytes = Encode(clip);
                if (clip.GetPixel(0, 0).ToArgb() != Color.Red.ToArgb() || bytes[0] != 137 || bytes[1] != 80) throw new Exception("crop encoding failed");
                Console.WriteLine("{\"ok\":true,\"syntheticOnly\":true,\"width\":2,\"height\":3}");
            }
        }
    }
    [STAThread] static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--self-test") { SelfTest(); return 0; }
            if (args.Length != 1 || args[0] != "--capture") throw new Exception("explicit capture argument required");
            Console.Error.WriteLine("REGION_CAPTURE:START");
            uint activeConsole = WTSGetActiveConsoleSessionId();
            Diagnostic("START session=" + Process.GetCurrentProcess().SessionId + " activeConsole=" + activeConsole);
            if (activeConsole != (uint)Process.GetCurrentProcess().SessionId) throw new Exception("not active console session");
            // Establish DPI awareness before any SystemInformation/WinForms call.
            bool dpiSet = false;
            try { dpiSet = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { dpiSet = SetProcessDPIAware(); }
            Diagnostic("DPI set=" + dpiSet + " aware=" + IsProcessDPIAware());
            if (!dpiSet && !IsProcessDPIAware()) throw new Exception("cannot establish DPI awareness");
            if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0 || SystemInformation.TerminalServerSession) throw new Exception("local interactive desktop required");
            IntPtr input = OpenInputDesktop(0, false, 1);
            int inputError = input == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            string inputName = ObjectName(input), ownName = ObjectName(GetThreadDesktop(GetCurrentThreadId())), station = ObjectName(GetProcessWindowStation());
            if (input != IntPtr.Zero) CloseDesktop(input);
            Diagnostic("DESKTOP station=" + station + " own=" + ownName + " input=" + inputName + " inputOpenError=" + inputError);
            if (!String.Equals(inputName, "Default", StringComparison.OrdinalIgnoreCase) || !String.Equals(ownName, "Default", StringComparison.OrdinalIgnoreCase) || !String.Equals(station, "WinSta0", StringComparison.OrdinalIgnoreCase)) throw new Exception("interactive default desktop unavailable");
            Application.EnableVisualStyles();
            Rectangle bounds = SystemInformation.VirtualScreen;
            Diagnostic("VIRTUAL_SCREEN bounds=" + bounds);
            if (bounds.Width < 2 || bounds.Height < 2 || bounds.Width > 16384 || bounds.Height > 16384 || (long)bounds.Width * bounds.Height > 80000000) throw new Exception("desktop dimensions exceed capture limit");
            // Freeze before displaying our window. Nothing is written to clipboard or disk.
            using (Bitmap frozen = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb)) {
                using (Graphics graphics = Graphics.FromImage(frozen)) graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
                Console.Error.WriteLine("REGION_CAPTURE:FROZEN");
                Diagnostic("FROZEN");
                using (RegionCapture overlay = new RegionCapture(frozen, bounds)) {
                    Application.Run(overlay);
                    if (overlay.ActivationFailed) throw new Exception("capture window activation blocked");
                    if (overlay.Result == null) { Console.Error.WriteLine("REGION_CAPTURE:CANCELLED"); Console.WriteLine("{\"cancelled\":true}"); return 0; }
                    using (Bitmap result = overlay.Result) {
                        byte[] data = Encode(result);
                        if (data.Length > 32 * 1024 * 1024) throw new Exception("selected image exceeds 32 MB");
                        Console.WriteLine("{\"mime\":\"image/png\",\"width\":" + result.Width + ",\"height\":" + result.Height + ",\"data\":\"" + Convert.ToBase64String(data) + "\"}");
                    }
                }
            }
            return 0;
        } catch (Exception e) { Diagnostic("ERROR type=" + e.GetType().Name); Console.Error.WriteLine("REGION_CAPTURE:ERROR"); return 1; }
    }
}
