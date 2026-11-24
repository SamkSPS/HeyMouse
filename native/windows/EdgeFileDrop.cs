using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Keep the OLE target hittable during the press, but only highlight a file hover.
sealed class EdgeFileDrop : Form
{
    const double IdleOpacity = 1.0 / 255;
    readonly Timer timer = new Timer { Interval = 35 };
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly string edge;
    DateTime hideAfter;
    Point? pressStart;
    bool dragging;

    EdgeFileDrop(string edge)
    {
        this.edge = edge;
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.FromArgb(190, 238, 100);
        Opacity = IdleOpacity;
        AllowDrop = true;
        DragEnter += Highlight;
        DragOver += Highlight;
        DragLeave += (_, __) => Opacity = IdleOpacity;
        DragDrop += Drop;
        timer.Tick += (_, __) => RefreshVisibility();
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams settings = base.CreateParams;
            settings.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            return settings;
        }
    }

    void RefreshVisibility()
    {
        bool held = (GetAsyncKeyState(0x01) & 0x8000) != 0;
        if (held)
        {
            Point cursor = Cursor.Position;
            if (!pressStart.HasValue) pressStart = cursor;
            Size threshold = SystemInformation.DragSize;
            dragging |= Math.Abs(cursor.X - pressStart.Value.X) >= Math.Max(2, threshold.Width / 2) ||
                        Math.Abs(cursor.Y - pressStart.Value.Y) >= Math.Max(2, threshold.Height / 2);
            hideAfter = DateTime.UtcNow.AddMilliseconds(160);
            Rectangle display = Screen.FromPoint(cursor).Bounds;
            if (dragging && !Visible && IsNearEdge(cursor, display))
            {
                const int thickness = 12;
                switch (edge)
                {
                    case "left": Bounds = new Rectangle(display.Left, display.Top, thickness, display.Height); break;
                    case "right": Bounds = new Rectangle(display.Right - thickness, display.Top, thickness, display.Height); break;
                    case "top": Bounds = new Rectangle(display.Left, display.Top, display.Width, thickness); break;
                    default: Bounds = new Rectangle(display.Left, display.Bottom - thickness, display.Width, thickness); break;
                }
                Opacity = IdleOpacity;
                Show();
            }
        }
        else
        {
            pressStart = null;
            dragging = false;
            if (Visible && DateTime.UtcNow >= hideAfter) Hide();
        }
    }

    bool IsNearEdge(Point cursor, Rectangle display)
    {
        const int activationDistance = 28;
        switch (edge)
        {
            case "left": return cursor.X - display.Left < activationDistance;
            case "right": return display.Right - 1 - cursor.X < activationDistance;
            case "top": return cursor.Y - display.Top < activationDistance;
            default: return display.Bottom - 1 - cursor.Y < activationDistance;
        }
    }

    static string[] Files(DragEventArgs e)
    {
        try
        {
            return e.Data == null ? null : e.Data.GetData(DataFormats.FileDrop, false) as string[];
        }
        catch (ExternalException) { return null; }
    }

    void Highlight(object sender, DragEventArgs e)
    {
        var files = Files(e);
        bool copy = files != null && files.Length == 1 && (e.AllowedEffect & DragDropEffects.Copy) != 0;
        e.Effect = copy ? DragDropEffects.Copy : DragDropEffects.None;
        Opacity = copy ? 0.9 : IdleOpacity;
    }

    void Drop(object sender, DragEventArgs e)
    {
        e.Effect = DragDropEffects.None;
        var files = Files(e);
        if (files == null || files.Length != 1 || !File.Exists(files[0]) ||
            (e.AllowedEffect & DragDropEffects.Copy) == 0) return;
        Console.WriteLine(json.Serialize(new { path = files[0] }));
        Console.Out.Flush();
        e.Effect = DragDropEffects.Copy;
        Hide();
    }

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int key);

    [STAThread]
    static int Main(string[] args)
    {
        string edge = args.Length == 1 ? args[0] : "";
        if (edge != "left" && edge != "right" && edge != "top" && edge != "bottom") return 2;
        Application.EnableVisualStyles();
        using (var target = new EdgeFileDrop(edge))
        {
            // The event loop starts without ever activating or showing the form.
            target.timer.Start();
            Application.Run();
            target.timer.Dispose();
        }
        return 0;
    }
}
