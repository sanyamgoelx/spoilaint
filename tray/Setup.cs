// The installer's window. The NSIS installer runs silently and drives this window through files in its
// temporary folder, so setup looks like the rest of Spoilaint instead of a grey wizard:
//   Spoilaint-setup.exe --setup <dir> <version> [update] [installdir]
//   window -> NSIS : <dir>\ui.ready  <dir>\go (Install clicked)  <dir>\cancel (closed before installing)
//   NSIS -> window : <dir>\progress  "percent|text"         <dir>\done    "ok|vlcrunning|novlc|vlcerror" flags, or "failed|message"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Spoilaint
{
    class SetupForm : Form
    {
        enum Stage { Welcome, Installing, Done, Failed }
        Stage stage = Stage.Welcome;
        readonly string dir, version, installDir;
        readonly bool update;
        bool vlcRunning, noVlc, vlcError, extAdded;
        string failMsg = "";
        float progress; string step = "Getting ready";

        DemoPanel demo;
        TextLine title, body, foot, stepText;
        Bar bar;
        Btn primary, secondary;
        LinkText vlcLink;
        BigCheck check;
        CloseButton closeX;
        readonly Timer poll = new Timer { Interval = 120 };

        public SetupForm(string dir, string version, bool update, string installDir)
        {
            this.dir = dir; this.version = version; this.update = update; this.installDir = installDir;
            Text = "Spoilaint Setup";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Body;
            Icon = AppIcon.Get(); AutoScaleMode = AutoScaleMode.None; ShowInTaskbar = true;
            ClientSize = new Size(Theme.D(640), Theme.D(456));
            DoubleBuffered = true;

            var logo = new LogoMark { Size = new Size(Theme.D(26), Theme.D(26)), BackColor = Theme.Bg, Name = "logo" };
            var name = new TextLine("Spoilaint", Theme.F(11f, FontStyle.Bold), Theme.Text) { BackColor = Theme.Bg, Name = "name" };
            var ver = new TextLine("v" + version, Theme.Small, Theme.Faint) { BackColor = Theme.Bg, Name = "ver" };
            closeX = new CloseButton { BackColor = Theme.Bg };
            closeX.Click += (s, e) => Close();
            demo = new DemoPanel();
            title = new TextLine("", Theme.F(17f, FontStyle.Bold), Theme.Text) { BackColor = Theme.Bg };
            body = new TextLine("", Theme.Body, Theme.Muted, true) { BackColor = Theme.Bg };
            stepText = new TextLine("", Theme.Small, Theme.Muted) { BackColor = Theme.Bg };
            bar = new Bar { BackColor = Theme.Bg };
            foot = new TextLine("", Theme.Small, Theme.Faint, true) { BackColor = Theme.Bg };
            primary = new Btn("", true) { BackColor = Theme.Bg, Height = Theme.D(40) };
            secondary = new Btn("", false) { BackColor = Theme.Bg, Height = Theme.D(40) };
            vlcLink = new LinkText("Get VLC") { BackColor = Theme.Bg };
            vlcLink.Click += (s, e) => Tools.Open("https://www.videolan.org/vlc/");
            check = new BigCheck { BackColor = Theme.Bg };
            primary.Click += (s, e) => OnPrimary();
            secondary.Click += (s, e) => OnSecondary();
            Controls.AddRange(new Control[] { logo, name, ver, closeX, demo, title, body, stepText, bar, foot, primary, secondary, vlcLink, check });

            // Drag the window by any empty part of it (it has no title bar).
            foreach (Control c in new Control[] { this, demo, title, body, foot, stepText, check, name, ver, logo })
                c.MouseDown += (s, e) => { if (e.Button == MouseButtons.Left) Native.DragWindow(Handle); };

            poll.Tick += (s, e) => Poll();
            AcceptButton = null;
            KeyPreview = true;
            KeyDown += (s, e) => { if (e.KeyCode == Keys.Escape) Close(); if (e.KeyCode == Keys.Enter && primary.Visible) OnPrimary(); };
            Show(Stage.Welcome);
        }

        protected override void OnShown(EventArgs e) { base.OnShown(e); Signal("ui.ready"); Activate(); }

        protected override CreateParams CreateParams
        {
            get { var cp = base.CreateParams; cp.ClassStyle |= 0x20000; /* CS_DROPSHADOW */ return cp; }
        }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.DarkTitle(Handle, Theme.Bg);
            Native.RoundCorners(Handle);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            // hairline border (Windows 10 has no rounded corners or border on a borderless window)
            using (var p = new Pen(Theme.Line)) e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
        }

        void Show(Stage s)
        {
            stage = s;
            switch (s)
            {
                case Stage.Welcome:
                    title.Text = update ? "Update Spoilaint to " + version : "Subtitles that keep up, never run ahead.";
                    body.Text = update
                        ? "Brings the latest timing and fixes. Your settings and synced films stay as they are."
                        : "Sets up VLC to reveal subtitles word by word as they're spoken, and adds a small extension for Netflix, Prime, Hotstar and YouTube. Everything runs on this PC.";
                    foot.Text = "Installs to " + Shorten(installDir) + "  ·  about 250 MB  ·  no admin needed";
                    primary.Text = update ? "Update" : "Install";
                    secondary.Text = "Cancel";
                    break;
                case Stage.Installing:
                    title.Text = update ? "Updating…" : "Installing…";
                    body.Text = "";
                    foot.Text = "";
                    primary.Text = ""; secondary.Text = "";
                    poll.Start();
                    break;
                case Stage.Done:
                    poll.Stop();
                    extAdded = Browsers.AddedIn() != null;
                    title.Text = update ? "Updated to " + version : "You're set";
                    var lines = new List<string>();
                    if (noVlc) lines.Add("VLC isn't installed yet. Install it and Spoilaint turns on by itself.");
                    else if (vlcRunning) lines.Add("VLC is open: close and reopen it, then play any film with subtitles.");
                    else if (vlcError) lines.Add("Couldn't turn on VLC's automatic mode. Open Spoilaint from the Start menu to fix it.");
                    else lines.Add("VLC is ready: open any film with subtitles and the words appear as they're spoken.");
                    if (!extAdded) lines.Add("Last step: add the extension to Chrome, Brave or Edge for Netflix, Prime, Hotstar and YouTube. A small guide does the fiddly parts, about a minute.");
                    else lines.Add("The browser extension picks up this version the next time your browser starts.");
                    body.Text = string.Join("\n\n", lines.ToArray());
                    primary.Text = extAdded ? "Done" : "Add to my browser";
                    secondary.Text = extAdded ? "" : "Later";
                    foot.Text = "Spoilaint lives by the clock and in the Start menu.";
                    break;
                case Stage.Failed:
                    poll.Stop();
                    title.Text = "Setup didn't finish";
                    body.Text = (failMsg.Length > 0 ? failMsg + "\n\n" : "") + "Nothing you had is broken. Close this and run the installer again; if it keeps happening, restart the PC first.";
                    primary.Text = "Close"; secondary.Text = "";
                    foot.Text = "";
                    break;
            }
            DoLayout();
        }

        void DoLayout()
        {
            SuspendLayout();
            int pad = Theme.D(28), w = ClientSize.Width - pad * 2, y = Theme.D(20);
            Controls["logo"].Location = new Point(pad, y);
            Controls["name"].SetBounds(pad + Theme.D(34), y + Theme.D(3), Theme.D(92), Theme.D(20));
            Controls["ver"].SetBounds(pad + Theme.D(128), y + Theme.D(6), Theme.D(90), Theme.D(16));
            closeX.SetBounds(ClientSize.Width - Theme.D(48), Theme.D(12), Theme.D(36), Theme.D(36));
            closeX.Visible = stage != Stage.Installing;
            y += Theme.D(42);

            bool done = stage == Stage.Done || stage == Stage.Failed;
            demo.Visible = !done;
            check.Visible = stage == Stage.Done;
            if (!done) { demo.SetBounds(pad, y, w, Theme.D(150)); y += Theme.D(150) + Theme.D(22); }
            else if (stage == Stage.Done) { check.SetBounds(pad, y + Theme.D(6), Theme.D(52), Theme.D(52)); y += Theme.D(74); }
            else y += Theme.D(10);

            title.SetBounds(pad, y, w, Theme.D(34)); y += Theme.D(40);
            int bh = body.Text.Length > 0 ? body.Measure(w) : 0;
            body.SetBounds(pad, y, w, bh); body.Visible = bh > 0; y += bh;

            bool installing = stage == Stage.Installing;
            stepText.Visible = bar.Visible = installing;
            if (installing)
            {
                stepText.SetBounds(pad, y + Theme.D(2), w, Theme.D(18));
                bar.SetBounds(pad, y + Theme.D(28), w, Theme.D(8));
            }
            bool link = stage == Stage.Done && noVlc;
            vlcLink.Visible = link;
            if (link) vlcLink.SetBounds(pad, y + Theme.D(10), vlcLink.Natural(), Theme.D(20));

            // bottom bar
            int by = ClientSize.Height - pad - Theme.D(40);
            int x = ClientSize.Width - pad;
            bool hasP = primary.Text != "", hasS = secondary.Text != "";
            primary.Visible = hasP; secondary.Visible = hasS;
            if (hasP) { int pw = Math.Max(primary.Natural() + Theme.D(12), Theme.D(110)); x -= pw; primary.SetBounds(x, by, pw, Theme.D(40)); x -= Theme.D(10); }
            if (hasS) { int sw = Math.Max(secondary.Natural() + Theme.D(8), Theme.D(90)); x -= sw; secondary.SetBounds(x, by, sw, Theme.D(40)); x -= Theme.D(10); }
            int fw = x - pad - Theme.D(10);
            bool hasF = foot.Text != "" && fw > Theme.D(80);
            foot.Visible = hasF;
            if (hasF) { int fh = foot.Measure(fw); foot.SetBounds(pad, by + (Theme.D(40) - fh) / 2, fw, fh); }
            ResumeLayout();
            Invalidate(true);
        }

        static string Shorten(string p)
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                if (!string.IsNullOrEmpty(home) && p.StartsWith(home, StringComparison.OrdinalIgnoreCase)) return "%USERPROFILE%" + p.Substring(home.Length);
            }
            catch { }
            return p;
        }

        void OnPrimary()
        {
            switch (stage)
            {
                case Stage.Welcome:
                    Signal("go");
                    Show(Stage.Installing);
                    break;
                case Stage.Done:
                    if (!extAdded) Launch("--add-extension");
                    Close();
                    break;
                case Stage.Failed:
                    Close();
                    break;
            }
        }
        void OnSecondary()
        {
            Close();
        }

        void Launch(string args)
        {
            try
            {
                string exe = Path.Combine(installDir, "Spoilaint.exe");
                try { Native.AllowSetForegroundWindow(-1); } catch { }
                if (File.Exists(exe)) Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false });
            }
            catch { }
        }

        void Signal(string name)
        {
            try { File.WriteAllText(Path.Combine(dir, name), "1"); } catch { }
        }

        void Poll()
        {
            try
            {
                // The installer is gone without saying it finished (it removes its folder on exit): judge by the result.
                if (!Directory.Exists(dir))
                {
                    if (File.Exists(Path.Combine(installDir, "Spoilaint.exe")) && File.Exists(Path.Combine(installDir, "Uninstall Spoilaint.exe"))) { bar.Value = 1; Show(Stage.Done); }
                    else { failMsg = "The installer stopped before it finished."; Show(Stage.Failed); }
                    return;
                }
                string pf = Path.Combine(dir, "progress");
                if (File.Exists(pf))
                {
                    var t = File.ReadAllText(pf).Trim();
                    int bar0 = t.IndexOf('|');
                    float pc;
                    if (bar0 > 0 && float.TryParse(t.Substring(0, bar0), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out pc))
                    {
                        progress = Math.Max(progress, pc / 100f);
                        step = t.Substring(bar0 + 1);
                    }
                }
                string df = Path.Combine(dir, "done");
                if (File.Exists(df))
                {
                    var t = File.ReadAllText(df).Trim();
                    if (t.StartsWith("failed")) { failMsg = t.Length > 7 ? t.Substring(7) : ""; Show(Stage.Failed); return; }
                    vlcRunning = t.Contains("vlcrunning"); noVlc = t.Contains("novlc"); vlcError = t.Contains("vlcerror");
                    bar.Value = 1; stepText.Text = "Done";
                    Show(Stage.Done);
                    return;
                }
            }
            catch { }
            bar.Value = Math.Max(0.02f, progress);
            stepText.Text = step + "  ·  " + (int)(progress * 100) + "%";
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (stage == Stage.Installing) { e.Cancel = true; return; } // can't stop halfway
            if (stage == Stage.Welcome) Signal("cancel");
            base.OnFormClosing(e);
        }
        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            poll.Stop();
            base.OnFormClosed(e);
            // This copy lives in %TEMP%: remove it once we've exited.
            try
            {
                string me = Application.ExecutablePath;
                if (me.IndexOf("Temp", StringComparison.OrdinalIgnoreCase) >= 0 && Path.DirectorySeparatorChar == '\\')
                    Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & del /q \"" + me + "\"")
                    { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
            }
            catch { }
        }

        public static void Run(string[] args)
        {
            // --setup <dir> <version> [update|new] <installdir>
            string d = args.Length > 1 ? args[1] : Path.GetTempPath();
            string v = args.Length > 2 ? args[2] : MainForm.Version;
            bool up = args.Length > 3 && args[3] == "update";
            string inst = args.Length > 4 ? args[4] : Paths.Data;
            Application.Run(new SetupForm(d, v, up, inst));
        }
    }

    // A dark "screen" with a subtitle line revealing word by word, newest word in amber: what Spoilaint does.
    class DemoPanel : Drawn
    {
        static readonly string[] Lines =
        {
            "I know who took the money.",
            "It was never your brother... it was me.",
            "Then why did you come back?",
            "Because the boat leaves tonight, and you're on it."
        };
        readonly Timer tick = new Timer { Interval = 33 };
        int line; string[] words; float[] shownAt; int next; DateTime start; double nextAt, endAt;
        readonly Font font = Theme.F(16f, FontStyle.Bold);

        public DemoPanel()
        {
            BackColor = Theme.Bg;
            tick.Tick += (s, e) => Step();
            Begin();
            tick.Start();
        }
        void Begin()
        {
            words = Lines[line % Lines.Length].Split(' ');
            shownAt = new float[words.Length];
            for (int i = 0; i < shownAt.Length; i++) shownAt[i] = -1;
            next = 0; start = DateTime.Now; nextAt = 300; endAt = -1;
        }
        double Now { get { return (DateTime.Now - start).TotalMilliseconds; } }
        void Step()
        {
            double t = Now;
            if (next < words.Length && t >= nextAt)
            {
                shownAt[next] = (float)t;
                string w = words[next];
                nextAt = t + 170 + Math.Min(10, w.Length) * 24 + (w.EndsWith(".") || w.EndsWith(",") || w.EndsWith("?") ? 360 : 0);
                next++;
                if (next == words.Length) endAt = t + 1500;
            }
            else if (endAt > 0 && t >= endAt) { line++; Begin(); }
            Invalidate();
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            using (var path = Theme.Round(r, Theme.D(14)))
            {
                using (var b = new LinearGradientBrush(new PointF(0, 0), new PointF(0, Height), Theme.Hex("#2A2119"), Theme.Hex("#0D0906")))
                    g.FillPath(b, path);
                g.SetClip(path);
                using (var glow = new GraphicsPath())
                {
                    glow.AddEllipse(Width * 0.45f, -Height * 0.4f, Width * 0.55f, Height * 1.1f);
                    using (var pb = new PathGradientBrush(glow) { CenterColor = Color.FromArgb(40, 255, 178, 63), SurroundColors = new[] { Color.FromArgb(0, 255, 178, 63) } })
                        g.FillPath(pb, glow);
                }
                g.ResetClip();
                using (var p = new Pen(Theme.Line)) g.DrawPath(p, path);
            }
            if (words == null) return;
            // lay out the words on one centred line (they always fit at this size)
            float space = g.MeasureString("a a", font).Width - g.MeasureString("aa", font).Width;
            var sizes = words.Select(w => g.MeasureString(w, font, PointF.Empty, StringFormat.GenericTypographic)).ToArray();
            float total = sizes.Sum(s => s.Width) + space * (words.Length - 1);
            float x = (Width - total) / 2, y = Height - Theme.D(26) - sizes[0].Height;
            double now = Now;
            int newest = next - 1;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            for (int i = 0; i < words.Length; i++)
            {
                if (shownAt[i] >= 0)
                {
                    float a = (float)Math.Min(1, (now - shownAt[i]) / 120.0);
                    float lift = (1 - a) * Theme.D(3);
                    Color c = (i == newest && endAt < 0) ? Theme.Accent : Theme.Text;
                    if (i == newest && endAt > 0) c = Theme.Mix(Theme.Accent, Theme.Text, (float)Math.Min(1, (now - (endAt - 1500)) / 320.0));
                    using (var sb = new SolidBrush(Color.FromArgb((int)(200 * a), 0, 0, 0)))
                        g.DrawString(words[i], font, sb, x + 1, y + lift + 2, StringFormat.GenericTypographic);
                    using (var b = new SolidBrush(Color.FromArgb((int)(255 * a), c)))
                        g.DrawString(words[i], font, b, x, y + lift, StringFormat.GenericTypographic);
                }
                x += sizes[i].Width + space;
            }
        }
        protected override void Dispose(bool disposing) { if (disposing) { tick.Dispose(); font.Dispose(); } base.Dispose(disposing); }
    }

    class CloseButton : Drawn
    {
        public CloseButton() { Cursor = Cursors.Hand; }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            if (hover) using (var b = new SolidBrush(Theme.CardHi)) using (var p = Theme.Round(new RectangleF(0, 0, Width - 1, Height - 1), Theme.D(8))) g.FillPath(b, p);
            float c = Width / 2f, k = Theme.D(5);
            using (var p = new Pen(hover ? Theme.Text : Theme.Muted, Theme.D(1.6f)) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                g.DrawLine(p, c - k, Height / 2f - k, c + k, Height / 2f + k);
                g.DrawLine(p, c + k, Height / 2f - k, c - k, Height / 2f + k);
            }
        }
    }
}
