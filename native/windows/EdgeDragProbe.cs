using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

// Standalone probe for the Explorer side of a future cross-machine drag.
// It is intentionally active only while testing, not during normal mouse use.
sealed class EdgeDragProbe : Form
{
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Timer expiry = new Timer { Interval = 30000 };
    readonly Timer motionTick = new Timer { Interval = 16 };
    readonly bool trackGesture;
    bool tracking;
    int dx;
    int dy;

    EdgeDragProbe(string edge, bool trackGesture)
    {
        this.trackGesture = trackGesture;
        Rectangle display = Screen.FromPoint(Cursor.Position).Bounds;
        const int thickness = 16;
        switch (edge)
        {
            case "left":
                Bounds = new Rectangle(display.Left, display.Top, thickness, display.Height);
                break;
            case "right":
                Bounds = new Rectangle(display.Right - thickness, display.Top, thickness, display.Height);
                break;
            case "top":
                Bounds = new Rectangle(display.Left, display.Top, display.Width, thickness);
                break;
            default:
                Bounds = new Rectangle(display.Left, display.Bottom - thickness, display.Width, thickness);
                break;
        }
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.YellowGreen;
        AllowDrop = true;
        DragEnter += OnFileDragEntered;
        DragOver += (_, e) => e.Effect = DragDropEffects.None;
        Shown += (_, __) => expiry.Start();
        expiry.Tick += (_, __) => Close();
        motionTick.Tick += (_, __) => FlushGesture();
        FormClosed += (_, __) => {
            if (tracking) EndGesture("file-drag-cancelled");
            motionTick.Dispose();
            expiry.Dispose();
        };
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams settings = base.CreateParams;
            settings.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            return settings;
        }
    }

    void OnFileDragEntered(object sender, DragEventArgs e)
    {
        // Observe the drag without executing a local copy or move on release.
        e.Effect = DragDropEffects.None;
        try
        {
            if (tracking || e.Data == null || !e.Data.GetDataPresent(DataFormats.FileDrop, false)) return;
            var paths = e.Data.GetData(DataFormats.FileDrop, false) as string[];
            if (paths == null || paths.Length != 1) return;
            var item = new FileInfo(paths[0]);
            if (!item.Exists) return;
            Emit(new
            {
                type = "file-drag-enter",
                name = item.Name,
                path = trackGesture ? item.FullName : null,
                size = item.Length,
                x = e.X,
                y = e.Y
            });
            if (trackGesture)
            {
                // Register just for this gesture. RIDEV_INPUTSINK lets us see
                // physical relative motion after Explorer hits the desktop edge.
                var device = new RawDevice { Page = 1, Usage = 2, Flags = 0x100, Target = Handle };
                if (!RegisterRawInputDevices(new[] { device }, 1, (uint)Marshal.SizeOf(typeof(RawDevice))))
                {
                    Emit(new { type = "file-drag-cancelled" });
                    return;
                }
                tracking = true;
                motionTick.Start();
            }
        }
        catch (IOException error) { Console.Error.WriteLine(error.Message); }
        catch (UnauthorizedAccessException error) { Console.Error.WriteLine(error.Message); }
        catch (System.Runtime.InteropServices.ExternalException error) { Console.Error.WriteLine(error.Message); }
    }

    void Emit(object value)
    {
        Console.WriteLine(json.Serialize(value));
        Console.Out.Flush();
    }

    void FlushGesture()
    {
        if (!tracking) return;
        if ((GetAsyncKeyState(0x1b) & 0x8000) != 0) { EndGesture("file-drag-cancelled"); return; }
        if ((GetAsyncKeyState(0x01) & 0x8000) == 0) { EndGesture("file-drag-released"); return; }
        FlushMotion();
    }

    void FlushMotion()
    {
        if (dx != 0 || dy != 0) Emit(new { type = "file-drag-move", dx, dy });
        dx = dy = 0;
    }

    void EndGesture(string reason)
    {
        if (!tracking) return;
        if (reason == "file-drag-released") FlushMotion();
        dx = dy = 0;
        tracking = false;
        motionTick.Stop();
        var device = new RawDevice { Page = 1, Usage = 2, Flags = 1 };
        RegisterRawInputDevices(new[] { device }, 1, (uint)Marshal.SizeOf(typeof(RawDevice)));
        Emit(new { type = reason });
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x00ff && tracking)
        {
            uint headerSize = (uint)Marshal.SizeOf(typeof(RawHeader));
            uint size = 0;
            if (GetRawInputData(m.LParam, 0x10000003, IntPtr.Zero, ref size, headerSize) == 0 &&
                size >= headerSize + 24 && size <= 4096)
            {
                IntPtr data = Marshal.AllocHGlobal((int)size);
                try
                {
                    if (GetRawInputData(m.LParam, 0x10000003, data, ref size, headerSize) == size &&
                        Marshal.ReadInt32(data) == 0)
                    {
                        int offset = (int)headerSize;
                        if ((Marshal.ReadInt16(data, offset) & 1) == 0)
                        {
                            dx += Marshal.ReadInt32(data, offset + 12);
                            dy += Marshal.ReadInt32(data, offset + 16);
                        }
                    }
                }
                finally { Marshal.FreeHGlobal(data); }
            }
        }
        base.WndProc(ref m);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RawDevice { public ushort Page, Usage; public uint Flags; public IntPtr Target; }
    [StructLayout(LayoutKind.Sequential)]
    struct RawHeader { public uint Type, Size; public IntPtr Device, Param; }
    [DllImport("user32.dll")]
    static extern bool RegisterRawInputDevices(RawDevice[] devices, uint count, uint size);
    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr input, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int key);

    [STAThread]
    static int Main(string[] args)
    {
        string edge = args.Length > 0 ? args[0] : "";
        bool track = args.Length == 2 && args[1] == "--track";
        if ((edge != "left" && edge != "right" && edge != "top" && edge != "bottom") ||
            (args.Length != 1 && !track))
        {
            Console.Error.WriteLine("EdgeDragProbe.exe left|right|top|bottom [--track]");
            return 2;
        }
        Application.EnableVisualStyles();
        using (var probe = new EdgeDragProbe(edge, track))
            Application.Run(probe);
        return 0;
    }
}
