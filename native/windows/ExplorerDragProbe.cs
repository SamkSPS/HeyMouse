using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

// Explorer selects the destination through a native OLE file-copy drag.
// This probe starts on a local mouse gesture using an already local file.
sealed class ExplorerDragProbe : Form
{
    readonly string source;
    Point? start;

    ExplorerDragProbe(string file)
    {
        source = file;
        Text = "HeyMouse · teste de arraste no Explorer";
        ClientSize = new Size(400, 116);
        StartPosition = FormStartPosition.CenterScreen;
        TopMost = true;
        var label = new Label {
            Text = "Arraste para uma pasta do Explorer\r\n" + Path.GetFileName(file),
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Padding = new Padding(12)
        };
        label.MouseDown += (_, e) => {
            if (e.Button == MouseButtons.Left) start = e.Location;
        };
        label.MouseUp += (_, __) => start = null;
        label.MouseMove += (_, e) => {
            if (!start.HasValue || e.Button != MouseButtons.Left) return;
            var distance = SystemInformation.DragSize;
            if (Math.Abs(e.X - start.Value.X) < distance.Width / 2 &&
                Math.Abs(e.Y - start.Value.Y) < distance.Height / 2) return;
            start = null;
            var data = new DataObject(DataFormats.FileDrop, new[] { source });
            var result = label.DoDragDrop(data, DragDropEffects.Copy);
            Console.WriteLine(result == DragDropEffects.Copy ? "explorer-drop-accepted" : "explorer-drag-cancelled");
        };
        Controls.Add(label);
    }

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length != 1 || !File.Exists(args[0]))
        {
            Console.Error.WriteLine("Uso: ExplorerDragProbe.exe caminho-do-arquivo");
            return 2;
        }
        Application.EnableVisualStyles();
        using (var probe = new ExplorerDragProbe(Path.GetFullPath(args[0])))
            Application.Run(probe);
        return 0;
    }
}
