// "Add to your browser": a small always-on-top guide that sits in the corner while the viewer adds the
// extension, so they never have to switch windows or copy anything by hand.
//   1. One button opens chrome://extensions (or brave:// / edge://) in the chosen browser and puts the
//      extension folder on the clipboard at the same time.
//   2-3. Developer mode, Load unpacked, Ctrl+V, Enter (or drag the folder tile onto the page).
//   4. The guide watches the browser's profile and ticks itself off when the extension shows up.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace Spoilaint
{
    class GuideForm : Form
    {
        public event Action Added;
        readonly List<Browser> browsers = Browsers.Installed();
        Browser cur;
        bool opened, success, wasAdded, requireOurs, opening;
        string foundAt;

        TextLine title, sub;
        Segmented picker;
        Panel steps, done;
        StepMark m1, m2, m3, m4;
        TextLine t1, t2, t3, t4, d1, d2, d3, d4;
        Btn open1;
        FolderTile tile;
        TextLine tileHint;
        Bar wait;
        LinkText manual, close;
        // success / already-added view
        BigCheck check;
        TextLine okTitle, okText;
        Btn okDone, okOpen;
        LinkText okOther, okSwitch;
        // no browser found
        TextLine none;
        Btn getChrome;
        readonly Timer poll = new Timer { Interval = 1500 };

        public GuideForm(string want)
        {
            Text = "Add Spoilaint to your browser";
            BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Body;
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false; MinimizeBox = true;
            StartPosition = FormStartPosition.Manual; ShowInTaskbar = true; TopMost = true;
            Icon = AppIcon.Get(); AutoScaleMode = AutoScaleMode.None;

            var logo = new LogoMark { Size = new Size(Theme.D(30), Theme.D(30)), BackColor = Theme.Bg, Name = "logo" };
            title = new TextLine("Add Spoilaint to your browser", Theme.F(12.5f, FontStyle.Bold), Theme.Text) { BackColor = Theme.Bg };
            sub = new TextLine("About a minute. This window stays on top, so you can follow along without switching.", Theme.Small, Theme.Muted, true) { BackColor = Theme.Bg };
            Controls.AddRange(new Control[] { logo, title, sub });

            picker = new Segmented(browsers.Select(b => b.Name).ToArray()) { BackColor = Theme.Bg };
            picker.Changed += (s, e) => Pick(browsers[picker.Selected]);
            Controls.Add(picker);

            // Steps
            steps = new Card();
            m1 = new StepMark { Label = "1" }; m2 = new StepMark { Label = "2" }; m3 = new StepMark { Label = "3" }; m4 = new StepMark { Label = "4" };
            t1 = T(""); d1 = D("");
            open1 = new Btn("", true);
            open1.Click += (s, e) => OpenPage();
            t2 = T("Turn on Developer mode"); d2 = D("The switch at the top right of the extensions page.");
            t3 = T("Click Load unpacked, then paste"); d3 = D("The folder is already on your clipboard: in the window that opens, press Ctrl+V, then click Select Folder.");
            tile = new FolderTile(Browsers.ExtensionDir);
            tileHint = D("Or drag this folder onto the extensions page. Click it to copy it again.");
            t4 = T("Spoilaint shows up"); d4 = D("");
            wait = new Bar();
            steps.Controls.AddRange(new Control[] { m1, t1, d1, open1, m2, t2, d2, m3, t3, d3, tile, tileHint, m4, t4, d4, wait });
            Controls.Add(steps);

            // Done
            done = new Card();
            check = new BigCheck();
            okTitle = new TextLine("", Theme.F(12.5f, FontStyle.Bold), Theme.Text);
            okText = new TextLine("", Theme.Body, Theme.Muted, true);
            okDone = new Btn("Done", true); okDone.Click += (s, e) => Close();
            okOpen = new Btn("", false); okOpen.Click += (s, e) => OpenPage();
            okOther = new LinkText("Add it to another browser");
            okOther.Click += (s, e) =>
            {
                var next = browsers.FirstOrDefault(b => b != cur && !Browsers.HasSpoilaint(b)) ?? browsers.FirstOrDefault(b => b != cur);
                if (next == null) return;
                picker.Selected = browsers.IndexOf(next);
                Pick(next);
            };
            okSwitch = new LinkText("Switch to the installed copy");
            okSwitch.Click += (s, e) => { requireOurs = true; wasAdded = false; success = false; opened = false; ShowSteps(); };
            done.Controls.AddRange(new Control[] { check, okTitle, okText, okDone, okOpen, okOther, okSwitch });
            Controls.Add(done);

            none = new TextLine("Spoilaint's extension works in Chrome, Brave and Edge, and none of them is installed. Install one, then come back here.", Theme.Body, Theme.Muted, true) { BackColor = Theme.Bg };
            getChrome = new Btn("Get Chrome", true); getChrome.Click += (s, e) => Tools.Open("https://www.google.com/chrome/");
            Controls.AddRange(new Control[] { none, getChrome });

            manual = new LinkText("I've added it") { BackColor = Theme.Bg };
            manual.Click += (s, e) => Succeed(true);
            close = new LinkText("Later") { BackColor = Theme.Bg };
            close.Click += (s, e) => Close();
            Controls.AddRange(new Control[] { manual, close });

            poll.Tick += (s, e) => Check();
            poll.Start();

            Browser start = browsers.FirstOrDefault(b => b.Key == want)
                         ?? browsers.FirstOrDefault(b => b.Key == Browsers.DefaultKey())
                         ?? browsers.FirstOrDefault();
            ClientSize = new Size(Theme.D(392), Theme.D(560));
            if (start != null) { picker.Selected = browsers.IndexOf(start); Pick(start); }
            else LayoutAll();
        }

        TextLine T(string s) { return new TextLine(s, Theme.BodyBold, Theme.Text); }
        TextLine D(string s) { return new TextLine(s, Theme.Small, Theme.Muted, true); }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Native.DarkTitle(Handle, Theme.Bg); }
        protected override void OnFormClosed(FormClosedEventArgs e) { poll.Stop(); base.OnFormClosed(e); }

        void Pick(Browser b)
        {
            cur = b; opened = false; success = false;
            requireOurs = false;
            foundAt = Browsers.FindSpoilaint(b);
            wasAdded = foundAt != null;
            if (wasAdded) ShowDone(); else ShowSteps();
        }

        void ShowSteps()
        {
            success = false;
            open1.Text = "Open " + cur.Name + " extensions";
            t1.Text = "Open " + cur.Name + "'s extensions page";
            d1.Text = "Opens it in " + cur.Name + " and copies the Spoilaint folder for step 3.";
            d4.Text = "This guide ticks itself off a few seconds after " + cur.Name + " adds it.";
            d2.Text = requireOurs ? "Remove the old Spoilaint card first, then make sure the Developer mode switch (top right) is on."
                                  : "The switch at the top right of the extensions page.";
            UpdateMarks();
            LayoutAll();
        }

        void UpdateMarks()
        {
            m1.Done = opened;
            m2.Muted = m3.Muted = m4.Muted = !opened;
            m4.Done = false;
            foreach (var m in new[] { m1, m2, m3, m4 }) m.Invalidate();
            foreach (var t in new[] { t2, t3, t4 }) { t.Colour = opened ? Theme.Text : Theme.Muted; t.Invalidate(); }
            open1.Primary = !opened; open1.Text = opened ? "Open it again" : "Open " + cur.Name + " extensions"; open1.Invalidate();
            tile.Highlight = opened; tile.Invalidate();
        }

        void OpenPage()
        {
            if (cur == null || opening) return;
            tile.Copy();
            var b = cur;
            opening = true;
            if (!success) { opened = true; UpdateMarks(); }
            d1.Text = "Opening " + b.Name + "...";
            LayoutAll();
            new System.Threading.Thread(() =>
            {
                bool ok = Browsers.OpenExtensionsPage(b);
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        opening = false;
                        d1.Text = ok ? "Opened in " + b.Name + ". The Spoilaint folder is on your clipboard for step 3."
                                     : b.Name + " didn't come to the front in time. Click into its address bar and type " + b.ExtensionsUrl.TrimEnd('/') + ", then press Enter.";
                        LayoutAll();
                        TopMost = false; TopMost = true; // the browser took focus; stay visible on top of it
                    }));
                }
                catch { }
            }) { IsBackground = true }.Start();
        }

        void Check()
        {
            if (cur == null || success || !Visible) return;
            string at = Browsers.FindSpoilaint(cur);
            if (at != null && (!requireOurs || Browsers.SamePath(at, Browsers.ExtensionDir))) Succeed(false);
        }

        void Succeed(bool manualTick)
        {
            success = true; wasAdded = false;
            if (Added != null) Added();
            if (!manualTick) System.Media.SystemSounds.Asterisk.Play();
            ShowDone();
            Activate();
        }

        void ShowDone()
        {
            if (wasAdded)
            {
                bool ours = Browsers.SamePath(foundAt, Browsers.ExtensionDir);
                okTitle.Text = "Spoilaint is already in " + cur.Name;
                okText.Text = ours
                    ? "Just updated Spoilaint? " + cur.Name + " picks up the new version the next time it starts. To use it now, open the extensions page and click the reload arrow on Spoilaint's card."
                    : "It's loaded from " + foundAt + ", so installing a new version won't update it. To use the installed copy: click Remove on Spoilaint's card in " + cur.Name + ", then switch below.";
                okOpen.Text = "Open " + cur.Name + " extensions";
                okSwitch.Visible = !ours;
            }
            else
            {
                okTitle.Text = "Added to " + cur.Name;
                okText.Text = "One more thing: pin it. Click the puzzle piece in " + cur.Name + "'s toolbar, then the pin next to Spoilaint. Then play anything with subtitles on: on Netflix, Prime or Hotstar, click Spoilaint and press Sync to speech.";
                okOpen.Text = "";
                okSwitch.Visible = false;
            }
            LayoutAll();
        }

        void LayoutAll()
        {
            // Note: Control.Visible reads false until the window is shown, so layout works from these flags.
            SuspendLayout();
            int pad = Theme.D(18), w = Theme.D(392) - pad * 2, y = pad;
            Controls["logo"].Location = new Point(pad, y + Theme.D(2));
            int tx = pad + Theme.D(42);
            title.SetBounds(tx, y, w - Theme.D(42), Theme.D(24));
            int sh = sub.Measure(w - Theme.D(42));
            sub.SetBounds(tx, y + Theme.D(26), w - Theme.D(42), sh);
            y += Math.Max(Theme.D(34), Theme.D(26) + sh) + Theme.D(16);

            bool any = browsers.Count > 0;
            bool showPicker = any && browsers.Count > 1;
            bool showDone = any && (success || wasAdded);
            bool showSteps = any && !showDone;
            none.Visible = getChrome.Visible = !any;
            picker.Visible = showPicker;
            steps.Visible = showSteps;
            done.Visible = showDone;
            manual.Visible = showSteps;
            close.Visible = !showDone;

            if (!any)
            {
                int nh = none.Measure(w); none.SetBounds(pad, y, w, nh); y += nh + Theme.D(14);
                getChrome.SetBounds(pad, y, getChrome.Natural(), Theme.D(34)); y += Theme.D(34) + Theme.D(16);
            }
            if (showPicker) { picker.SetBounds(pad, y, w, Theme.D(34)); y += Theme.D(34) + Theme.D(12); }
            if (showSteps) { LayoutSteps(w); steps.SetBounds(pad, y, w, steps.Height); y += steps.Height + Theme.D(12); }
            if (showDone) { LayoutDone(w); done.SetBounds(pad, y, w, done.Height); y += done.Height + Theme.D(12); }
            if (!showDone)
            {
                if (showSteps) manual.SetBounds(pad + Theme.D(4), y, manual.Natural(), Theme.D(20));
                int cw = close.Natural(); close.SetBounds(pad + w - cw - Theme.D(4), y, cw, Theme.D(20));
                y += Theme.D(20);
            }
            y += pad - Theme.D(4);
            int keepBottom = Bottom;
            ClientSize = new Size(Theme.D(392), y);
            PlaceCorner(keepBottom);
            ResumeLayout();
            Invalidate(true);
        }

        void LayoutSteps(int w)
        {
            int p = steps.Padding.Left, iw = w - steps.Padding.Horizontal, y = p;
            int tx = p + Theme.D(40), tw = iw - Theme.D(40);
            y = Step(m1, t1, d1, y, p, tx, tw);
            open1.SetBounds(tx, y, Math.Max(open1.Natural(), Theme.D(140)), Theme.D(34)); y += Theme.D(34) + Theme.D(16);
            y = Step(m2, t2, d2, y, p, tx, tw) + Theme.D(6);
            y = Step(m3, t3, d3, y, p, tx, tw);
            tile.SetBounds(tx, y, tw, Theme.D(46)); y += Theme.D(46) + Theme.D(6);
            int hh = tileHint.Measure(tw); tileHint.SetBounds(tx, y, tw, hh); y += hh + Theme.D(16);
            y = Step(m4, t4, d4, y, p, tx, tw);
            wait.Visible = opened;
            if (opened) { wait.SetBounds(tx, y, tw, Theme.D(6)); wait.Value = -1; y += Theme.D(6) + Theme.D(4); }
            steps.Height = y - Theme.D(10) + p;
        }

        int Step(StepMark mark, TextLine t, TextLine d, int y, int p, int tx, int tw)
        {
            mark.Location = new Point(p, y);
            t.SetBounds(tx, y + Theme.D(4), tw, Theme.D(20));
            int h = d.Measure(tw);
            d.SetBounds(tx, y + Theme.D(26), tw, h);
            return y + Theme.D(26) + h + Theme.D(10);
        }

        void LayoutDone(int w)
        {
            int p = done.Padding.Left, iw = w - done.Padding.Horizontal, y = p;
            check.SetBounds(p, y, Theme.D(44), Theme.D(44));
            okTitle.SetBounds(p + Theme.D(56), y + Theme.D(10), iw - Theme.D(56), Theme.D(24));
            y += Theme.D(44) + Theme.D(14);
            int h = okText.Measure(iw); okText.SetBounds(p, y, iw, h); y += h + Theme.D(16);
            int x = p;
            okDone.SetBounds(x, y, Math.Max(okDone.Natural(), Theme.D(88)), Theme.D(34)); x += okDone.Width + Theme.D(8);
            bool openBtn = okOpen.Text != "";
            okOpen.Visible = openBtn;
            if (openBtn) okOpen.SetBounds(x, y, okOpen.Natural(), Theme.D(34));
            y += Theme.D(34);
            bool sw = wasAdded && !Browsers.SamePath(foundAt, Browsers.ExtensionDir);
            okSwitch.Visible = sw;
            if (sw) { y += Theme.D(14); okSwitch.SetBounds(p, y, okSwitch.Natural(), Theme.D(18)); y += Theme.D(18); }
            bool other = browsers.Count > 1;
            okOther.Visible = other;
            if (other) { y += Theme.D(sw ? 8 : 14); okOther.SetBounds(p, y, okOther.Natural(), Theme.D(18)); y += Theme.D(18); }
            done.Height = y + p;
        }

        // Bottom-right corner, clear of the extensions page's own controls (Developer mode is top right,
        // Load unpacked top left) and of the folder window (centre).
        bool placed;
        void PlaceCorner(int keepBottom)
        {
            var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
            if (!placed) { Location = new Point(wa.Right - Width - Theme.D(16), wa.Bottom - Height - Theme.D(16)); placed = true; return; }
            // keep the bottom edge where it was when the height changes
            int bottom = Math.Min(keepBottom, wa.Bottom - Theme.D(16));
            Location = new Point(Left, Math.Max(wa.Top, bottom - Height));
        }
        protected override void OnShown(EventArgs e) { base.OnShown(e); placed = false; PlaceCorner(Bottom); }
    }

    // The extension folder as a tile: click to copy the path, drag it onto the extensions page to load it.
    class FolderTile : Drawn
    {
        readonly string path;
        public bool Highlight;
        string flash; readonly Timer reset = new Timer { Interval = 1600 };
        Point downAt; bool dragging;
        public FolderTile(string path)
        {
            this.path = path; Cursor = Cursors.Hand;
            reset.Tick += (s, e) => { flash = null; reset.Stop(); Invalidate(); };
        }
        public void Copy()
        {
            try { Clipboard.SetDataObject(path, true, 6, 120); flash = "Copied"; }
            catch { flash = "Couldn't copy"; }
            reset.Stop(); reset.Start(); Invalidate();
        }
        protected override void OnMouseDown(MouseEventArgs e) { downAt = e.Location; dragging = false; base.OnMouseDown(e); }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (e.Button != MouseButtons.Left || dragging) return;
            var dz = SystemInformation.DragSize;
            if (Math.Abs(e.X - downAt.X) < dz.Width && Math.Abs(e.Y - downAt.Y) < dz.Height) return;
            dragging = true;
            var data = new DataObject();
            data.SetData(DataFormats.FileDrop, new[] { path });
            data.SetText(path);
            try { DoDragDrop(data, DragDropEffects.Copy | DragDropEffects.Link); } catch { }
            down = false; Invalidate();
        }
        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!dragging && e.Button == MouseButtons.Left && ClientRectangle.Contains(e.Location)) Copy();
            dragging = false;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            Color edge = Highlight ? Theme.Accent : Theme.Line;
            using (var path0 = Theme.Round(r, Theme.D(10)))
            using (var b = new SolidBrush(hover ? Theme.CardHi : Theme.Bg))
            using (var p = new Pen(edge, Highlight ? Theme.D(1.5f) : 1) { DashStyle = DashStyle.Dash })
            { g.FillPath(b, path0); g.DrawPath(p, path0); }
            // folder glyph
            float fx = Theme.D(12), fy = Height / 2f - Theme.D(8), fw = Theme.D(22), fh = Theme.D(16);
            using (var b = new SolidBrush(Theme.Mix(Theme.Accent, Theme.Bg, 0.25f)))
            {
                g.FillRectangle(b, fx, fy, fw * 0.45f, Theme.D(4));
                using (var body = Theme.Round(new RectangleF(fx, fy + Theme.D(3), fw, fh - Theme.D(3)), Theme.D(2))) g.FillPath(b, body);
            }
            string right = flash ?? "Copy";
            int rw = TextRenderer.MeasureText(right, Theme.SmallBold).Width;
            int tx = Theme.D(44), tw = Width - tx - rw - Theme.D(24);
            Theme.DrawText(g, "extension", Theme.BodyBold, Theme.Text, new Rectangle(tx, Theme.D(6), tw, Theme.D(18)), TextFormatFlags.SingleLine);
            TextRenderer.DrawText(g, path, Theme.Small, new Rectangle(tx, Theme.D(24), tw, Theme.D(16)), Theme.Muted,
                TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.PathEllipsis);
            Theme.DrawText(g, right, Theme.SmallBold, flash == "Copied" ? Theme.Good : Theme.Accent,
                new Rectangle(Width - rw - Theme.D(14), 0, rw + 2, Height), TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }
        protected override void Dispose(bool disposing) { if (disposing) reset.Dispose(); base.Dispose(disposing); }
    }

    class BigCheck : Drawn
    {
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            using (var b = new SolidBrush(Theme.Mix(Theme.Good, Theme.Card, 0.78f))) g.FillEllipse(b, 1, 1, Width - 2, Height - 2);
            using (var p = new Pen(Theme.Good, Theme.D(3)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                g.DrawLines(p, new[] { new PointF(Width * 0.3f, Height * 0.52f), new PointF(Width * 0.45f, Height * 0.67f), new PointF(Width * 0.72f, Height * 0.36f) });
        }
    }
}
