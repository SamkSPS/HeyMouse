using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A narrow OLE drop target, visible only while the left button is held.
sealed class EdgeFileDrop : Form
{
    readonly Timer timer = new Timer { Interval = 35 };
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly string edge;
    DateTime hideAfter;

    EdgeFileDrop(string edge)
    {
        this.edge = edge;
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.FromArgb(190, 238, 100);
        Opacity = 0.65;
        AllowDrop = true;
        DragEnter += Highlight;
        DragOver += Highlight;
        DragLeave += (_, __) => Opacity = 0.65;
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
            hideAfter = DateTime.UtcNow.AddMilliseconds(160);
            if (!Visible)
            {
                Rectangle display = Screen.FromPoint(Cursor.Position).Bounds;
                const int thickness = 12;
                switch (edge)
                {
                    case "left": Bounds = new Rectangle(display.Left, display.Top, thickness, display.Height); break;
                    case "right": Bounds = new Rectangle(display.Right - thickness, display.Top, thickness, display.Height); break;
                    case "top": Bounds = new Rectangle(display.Left, display.Top, display.Width, thickness); break;
                    default: Bounds = new Rectangle(display.Left, display.Bottom - thickness, display.Width, thickness); break;
                }
                Show();
            }
        }
        else if (Visible && DateTime.UtcNow >= hideAfter)
        {
            Hide();
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
        Opacity = copy ? 1 : 0.65;
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
