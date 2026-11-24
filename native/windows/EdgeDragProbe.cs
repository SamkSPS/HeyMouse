using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;

// Standalone probe for the Explorer side of a future cross-machine drag.
// It is intentionally active only while testing, not during normal mouse use.
sealed class EdgeDragProbe : Form
{
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Timer expiry = new Timer { Interval = 30000 };

    EdgeDragProbe(string edge)
    {
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
        FormClosed += (_, __) => expiry.Dispose();
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
            if (e.Data == null || !e.Data.GetDataPresent(DataFormats.FileDrop, false)) return;
            var paths = e.Data.GetData(DataFormats.FileDrop, false) as string[];
            if (paths == null || paths.Length != 1) return;
            var item = new FileInfo(paths[0]);
            if (!item.Exists) return;
            Console.WriteLine(json.Serialize(new
            {
                type = "file-drag-enter",
                name = item.Name,
                size = item.Length,
                x = e.X,
                y = e.Y
            }));
            Console.Out.Flush();
        }
        catch (IOException error) { Console.Error.WriteLine(error.Message); }
        catch (UnauthorizedAccessException error) { Console.Error.WriteLine(error.Message); }
        catch (System.Runtime.InteropServices.ExternalException error) { Console.Error.WriteLine(error.Message); }
    }

    [STAThread]
    static int Main(string[] args)
    {
        string edge = args.Length == 1 ? args[0] : "";
        if (edge != "left" && edge != "right" && edge != "top" && edge != "bottom")
        {
            Console.Error.WriteLine("EdgeDragProbe.exe left|right|top|bottom");
            return 2;
        }
        Application.EnableVisualStyles();
        using (var probe = new EdgeDragProbe(edge))
            Application.Run(probe);
        return 0;
    }
}
