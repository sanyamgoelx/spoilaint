using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace Spoilaint
{
    class MainForm : Form, IMessageFilter
    {
        readonly JobRunner runner;
        readonly NotifyIcon tray;
        readonly Ini app = new Ini(Paths.AppIni);
        List<RecentItem> recent = RecentStore.Load();
        readonly Dictionary<string, DateTime> justSynced = new Dictionary<string, DateTime>();
        public bool Quitting;
        public static string Version = "0.8.1";

        // controls
        Panel viewport, scroll;
        ScrollThumb thumb;
        int offset, contentH;
        TextLine status;
        Card setupCard, activityCard, vlcCard;
        StepMark vlcMark, extMark;
        TextLine vlcTitle, vlcText, extTitle, extText;
        Btn vlcFix, extHow;
        LinkText extAgain, extDone;
        TextLine actTitle, actPhase, actIdle, actRecentHead;
        Bar actBar;
        RecentList recentList;
        Segmented style, size;
        Slider delay;
        TextLine delayValue;
        Swatches colours;
        Toggle highlight, box, autostart, notify;
        readonly List<Control[]> settingRows = new List<Control[]>();
        TextLine footer;
        LinkText openLog, support;

        static readonly string[] ThemeKeys = { "amber", "dark", "indigo", "green" };
        static readonly int[] Sizes = { 52, 64, 78 };

        public MainForm(JobRunner runner)
        {
            this.runner = runner;
            Text = "Spoilaint";
            BackColor = Theme.Bg;
            ForeColor = Theme.Text;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = true;
            Font = Theme.Body;
            Icon = AppIcon.Get();
            AutoScaleMode = AutoScaleMode.None;

            // Own scrolling (thin themed bar + mouse wheel) instead of the light system scrollbar.
            viewport = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Bg };
            Controls.Add(viewport);
            scroll = new Panel { BackColor = Theme.Bg };
            viewport.Controls.Add(scroll);
            thumb = new ScrollThumb { BackColor = Theme.Bg };
            thumb.Dragged += dy => ScrollTo(offset + (int)(dy * (float)contentH / Math.Max(1, viewport.ClientSize.Height)));
            viewport.Controls.Add(thumb);
            thumb.BringToFront();
            viewport.Resize += (s, e) => DoLayout();
            Application.AddMessageFilter(this);
            BuildHeader();
            BuildSetup();
            BuildActivity();
            BuildSettings();
            BuildFooter();
            LoadSettings();

            tray = new NotifyIcon { Icon = AppIcon.Get(), Text = "Spoilaint", Visible = true, ContextMenuStrip = BuildMenu() };
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ToggleWindow(); };
            tray.BalloonTipClicked += (s, e) => ShowWindow();

            runner.Changed += j => UI(() => UpdateActivity());
            runner.Finished += (j, ok, msg) => UI(() => OnFinished(j, ok, msg));
            runner.ResultArrived += r => UI(() => OnResult(r));

            var refresh = new System.Windows.Forms.Timer { Interval = 5000 };
            refresh.Tick += (s, e) => { RefreshSetup(); recentList.Invalidate(); };
            refresh.Start();

            ClientSize = new Size(Theme.D(460), Theme.D(640));
            DoLayout();
            Place();
        }

        void UI(Action a) { try { if (IsHandleCreated) BeginInvoke(a); } catch { } }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.DarkTitle(Handle, Theme.Bg);
        }

        // ------------------------------------------------------------------ building
        Control header;
        void BuildHeader()
        {
            var logo = new LogoMark { Size = new Size(Theme.D(34), Theme.D(34)), BackColor = Theme.Bg };
            var name = new TextLine("Spoilaint", Theme.Title, Theme.Text) { BackColor = Theme.Bg };
            status = new TextLine("", Theme.Small, Theme.Muted) { BackColor = Theme.Bg };
            header = new Panel { BackColor = Theme.Bg };
            header.Controls.AddRange(new Control[] { logo, name, status });
            header.Layout += (s, e) =>
            {
                logo.Location = new Point(0, Theme.D(4));
                name.SetBounds(Theme.D(46), Theme.D(2), header.Width - Theme.D(46), Theme.D(26));
                status.SetBounds(Theme.D(46), Theme.D(27), header.Width - Theme.D(46), Theme.D(16));
            };
            scroll.Controls.Add(header);
        }

        void BuildSetup()
        {
            setupCard = new Card();
            vlcMark = new StepMark { Label = "1" };
            vlcTitle = new TextLine("VLC", Theme.BodyBold, Theme.Text);
            vlcText = new TextLine("", Theme.Small, Theme.Muted, true);
            vlcFix = new Btn("Set up VLC", true);
            vlcFix.Click += (s, e) =>
            {
                if (!VlcCheck.Installed()) { Tools.Open("https://www.videolan.org/vlc/"); return; }
                vlcFix.Text = "Setting up...";
                new Thread(() => { VlcCheck.Configure(); UI(RefreshSetup); }) { IsBackground = true }.Start();
            };
            extMark = new StepMark { Label = "2" };
            extTitle = new TextLine("Browser extension", Theme.BodyBold, Theme.Text);
            extText = new TextLine("", Theme.Small, Theme.Muted, true);
            extHow = new Btn("Add to browser", true);
            extHow.Click += (s, e) => ShowGuide(null);
            extDone = new LinkText("I've already added it");
            extDone.Click += (s, e) => { app.Set("extensionDone", "1"); app.Save(); RefreshSetup(); };
            extAgain = new LinkText("Add to another browser");
            extAgain.Click += (s, e) => ShowGuide(null);
            setupCard.Controls.AddRange(new Control[] { vlcMark, vlcTitle, vlcText, vlcFix, extMark, extTitle, extText, extHow, extDone, extAgain });
            scroll.Controls.Add(setupCard);
            RefreshSetup();
        }

        void BuildActivity()
        {
            activityCard = new Card();
            actTitle = new TextLine("", Theme.BodyBold, Theme.Text);
            actPhase = new TextLine("", Theme.Small, Theme.Muted);
            actBar = new Bar();
            actIdle = new TextLine("Nothing to sync right now. Open a film with subtitles in VLC: the words show as they're spoken straight away, and the first time, Spoilaint listens to the dialogue here to match them exactly.", Theme.Small, Theme.Muted, true);
            actRecentHead = new TextLine("RECENT", Theme.Heading, Theme.Faint);
            recentList = new RecentList { Items = recent };
            activityCard.Controls.AddRange(new Control[] { actTitle, actPhase, actBar, actIdle, actRecentHead, recentList });
            scroll.Controls.Add(activityCard);
        }

        void BuildSettings()
        {
            vlcCard = new Card();
            style = new Segmented("Word by word", "3 words", "Normal");
            size = new Segmented("S", "M", "L");
            delay = new Slider(-500, 1500, 100, 0);
            delayValue = new TextLine("", Theme.SmallBold, Theme.Accent);
            colours = new Swatches(ThemeKeys, ThemeKeys.Select(k => Theme.Hex(k == "amber" ? "#FFB23F" : k == "dark" ? "#E4E0D9" : k == "indigo" ? "#8C9BFF" : "#5FD892")).ToArray());
            highlight = new Toggle();
            box = new Toggle();
            style.Changed += (s, e) => SaveSettings();
            size.Changed += (s, e) => SaveSettings();
            delay.Changed += (s, e) => { ShowDelay(); SaveSettings(); };
            colours.Changed += (s, e) => SaveSettings();
            highlight.Changed += (s, e) => SaveSettings();
            box.Changed += (s, e) => SaveSettings();
            AddRow("Style", style);
            AddRow("Delay", delay, delayValue);
            AddRow("Size", size);
            AddRow("Newest word colour", colours);
            AddRow("Colour the newest word", highlight);
            AddRow("Dark box behind text", box);
            vlcCard.Controls.Add(new TextLine("VLC SUBTITLES", Theme.Heading, Theme.Faint) { Name = "head" });
            vlcCard.Controls.Add(new TextLine("Changes apply to the next film you open. The browser extension has its own settings in its menu.", Theme.Small, Theme.Faint, true) { Name = "note" });
            scroll.Controls.Add(vlcCard);
        }

        void AddRow(string label, params Control[] ctrls)
        {
            var l = new TextLine(label, Theme.Body, Theme.Text);
            vlcCard.Controls.Add(l);
            foreach (var c in ctrls) vlcCard.Controls.Add(c);
            var row = new Control[ctrls.Length + 1];
            row[0] = l; Array.Copy(ctrls, 0, row, 1, ctrls.Length);
            settingRows.Add(row);
        }

        Card appCard;
        TextLine autoLabel, notifyLabel;
        void BuildFooter()
        {
            appCard = new Card();
            autoLabel = new TextLine("Start with Windows", Theme.Body, Theme.Text);
            notifyLabel = new TextLine("Tell me when a film is synced", Theme.Body, Theme.Text);
            autostart = new Toggle { On = Autostart.Enabled };
            autostart.Changed += (s, e) => { Autostart.Enabled = autostart.On; UpdateMenuChecks(); };
            notify = new Toggle { On = app.GetBool("notify", true) };
            notify.Changed += (s, e) => { app.Set("notify", notify.On ? "1" : "0"); app.Save(); };
            appCard.Controls.AddRange(new Control[] { autoLabel, autostart, notifyLabel, notify });
            scroll.Controls.Add(appCard);
            footer = new TextLine("Spoilaint " + Version, Theme.Small, Theme.Faint) { BackColor = Theme.Bg };
            openLog = new LinkText("Open VLC log") { BackColor = Theme.Bg };
            support = new LinkText("\u2615 Support") { BackColor = Theme.Bg };
            support.Click += (s, e) => OpenSupport();
            scroll.Controls.Add(support);
            openLog.Click += (s, e) => { if (File.Exists(Paths.VlcLog)) Tools.Open(Paths.VlcLog); };
            scroll.Controls.Add(footer);
            scroll.Controls.Add(openLog);
        }

        ContextMenuStrip menu;
        ToolStripMenuItem menuStatus, menuAuto;
        ContextMenuStrip BuildMenu()
        {
            menu = new ContextMenuStrip { Renderer = new DarkMenu(), ShowImageMargin = false, ShowCheckMargin = true, Font = Theme.Body };
            var open = new ToolStripMenuItem("Open Spoilaint", null, (s, e) => ShowWindow()) { Font = Theme.BodyBold };
            menuStatus = new ToolStripMenuItem("Ready") { Enabled = false };
            var ext = new ToolStripMenuItem("Add to your browser", null, (s, e) => ShowGuide(null));
            var sup = new ToolStripMenuItem("Support Spoilaint", null, (s, e) => OpenSupport());
            var log = new ToolStripMenuItem("Open VLC log", null, (s, e) => { if (File.Exists(Paths.VlcLog)) Tools.Open(Paths.VlcLog); });
            menuAuto = new ToolStripMenuItem("Start with Windows", null, (s, e) => { Autostart.Enabled = !Autostart.Enabled; autostart.On = Autostart.Enabled; UpdateMenuChecks(); });
            var quit = new ToolStripMenuItem("Quit", null, (s, e) => Quit());
            menu.Items.AddRange(new ToolStripItem[] { open, menuStatus, new ToolStripSeparator(), ext, log, menuAuto, sup, new ToolStripSeparator(), quit });
            menu.Opening += (s, e) => UpdateMenuChecks();
            return menu;
        }
        void UpdateMenuChecks() { if (menuAuto != null) menuAuto.Checked = Autostart.Enabled; }

        // ------------------------------------------------------------------ layout
        void DoLayout()
        {
            if (scroll == null || setupCard == null || activityCard == null || vlcCard == null || appCard == null || footer == null) return;
            int pad = Theme.D(18), w = viewport.ClientSize.Width - pad * 2;
            int y = pad, y0 = 0;
            header.SetBounds(pad, y, w, Theme.D(46)); y += Theme.D(46) + Theme.D(14);
            LayoutSetup(w); setupCard.SetBounds(pad, y, w, setupCard.Height); y += setupCard.Height + Theme.D(12);
            LayoutActivity(w); activityCard.SetBounds(pad, y, w, activityCard.Height); y += activityCard.Height + Theme.D(12);
            LayoutSettings(w); vlcCard.SetBounds(pad, y, w, vlcCard.Height); y += vlcCard.Height + Theme.D(12);
            LayoutApp(w); appCard.SetBounds(pad, y, w, appCard.Height); y += appCard.Height + Theme.D(10);
            footer.SetBounds(pad + Theme.D(4), y, w / 2, Theme.D(18));
            int lw = openLog.Natural(); openLog.SetBounds(pad + w - lw - Theme.D(4), y, lw, Theme.D(18));
            int sw = support.Natural(); support.SetBounds(pad + w - lw - sw - Theme.D(20), y, sw, Theme.D(18));
            y += Theme.D(18) + pad;
            contentH = y - y0;
            ScrollTo(offset);
        }

        void ScrollTo(int o)
        {
            int vh = viewport.ClientSize.Height;
            offset = Math.Max(0, Math.Min(Math.Max(0, contentH - vh), o));
            scroll.SetBounds(0, -offset, viewport.ClientSize.Width, Math.Max(contentH, vh));
            bool need = contentH > vh + 1;
            thumb.Visible = need;
            if (need)
            {
                int th = Math.Max(Theme.D(40), vh * vh / contentH);
                int ty = (int)((vh - th) * (offset / (float)Math.Max(1, contentH - vh)));
                thumb.SetBounds(viewport.ClientSize.Width - Theme.D(10), ty, Theme.D(10), th);
            }
        }

        public bool PreFilterMessage(ref Message m)
        {
            if (m.Msg != 0x020A || !Visible) return false; // WM_MOUSEWHEEL
            var pt = Cursor.Position;
            if (!RectangleToScreen(ClientRectangle).Contains(pt)) return false;
            int delta = (short)((m.WParam.ToInt64() >> 16) & 0xFFFF);
            ScrollTo(offset - delta * Theme.D(70) / 120);
            return true;
        }

        int Inner(Card c, int w) { return w - c.Padding.Horizontal; }

        void LayoutSetup(int w)
        {
            int p = setupCard.Padding.Left, iw = Inner(setupCard, w), y = p;
            int tx = p + Theme.D(40), tw = iw - Theme.D(40);
            y = LayoutStep(vlcMark, vlcTitle, vlcText, y, p, tx, tw);
            if (vlcFix.Visible) { vlcFix.SetBounds(tx, y, vlcFix.Natural(), Theme.D(34)); y += Theme.D(34) + Theme.D(6); }
            y += Theme.D(12);
            y = LayoutStep(extMark, extTitle, extText, y, p, tx, tw);
            if (extHow.Visible)
            {
                extHow.SetBounds(tx, y, extHow.Natural(), Theme.D(34));
                extDone.SetBounds(tx + extHow.Natural() + Theme.D(14), y + Theme.D(8), extDone.Natural(), Theme.D(18));
                y += Theme.D(34);
            }
            else { extAgain.SetBounds(tx, y - Theme.D(2), extAgain.Natural(), Theme.D(18)); y += Theme.D(16); }
            setupCard.Height = y + p;
        }

        int LayoutStep(StepMark mark, TextLine title, TextLine text, int y, int p, int tx, int tw)
        {
            mark.Location = new Point(p, y);
            title.SetBounds(tx, y + Theme.D(4), tw, Theme.D(20));
            int th = text.Measure(tw);
            text.SetBounds(tx, y + Theme.D(26), tw, th);
            return y + Theme.D(26) + th + Theme.D(10);
        }

        void LayoutActivity(int w)
        {
            int p = activityCard.Padding.Left, iw = Inner(activityCard, w), y = p;
            var j = runner.Current;
            bool busy = j != null;
            actTitle.Visible = actPhase.Visible = actBar.Visible = busy;
            actIdle.Visible = !busy;
            if (busy)
            {
                actTitle.SetBounds(p, y, iw, Theme.D(20)); y += Theme.D(22);
                actPhase.SetBounds(p, y, iw, Theme.D(16)); y += Theme.D(24);
                actBar.SetBounds(p, y, iw, Theme.D(8)); y += Theme.D(8);
            }
            else
            {
                int h = actIdle.Measure(iw);
                actIdle.SetBounds(p, y, iw, h); y += h;
            }
            bool any = recent.Count > 0;
            actRecentHead.Visible = recentList.Visible = any;
            if (any)
            {
                y += Theme.D(18);
                actRecentHead.SetBounds(p, y, iw, Theme.D(14)); y += Theme.D(20);
                recentList.Items = recent;
                recentList.SetBounds(p, y, iw, recentList.Rows * recentList.RowH); y += recentList.Height - Theme.D(4);
                recentList.Invalidate();
            }
            activityCard.Height = y + p;
        }

        void LayoutSettings(int w)
        {
            int p = vlcCard.Padding.Left, iw = Inner(vlcCard, w), y = p;
            vlcCard.Controls["head"].SetBounds(p, y, iw, Theme.D(14)); y += Theme.D(26);
            int labelW = Theme.D(108), cx = p + labelW, cw = iw - labelW;
            foreach (var row in settingRows)
            {
                var c = row[1];
                int h = Math.Max(Theme.D(26), c.Height);
                int lw = (c is Toggle || c is Swatches) ? iw - c.Width - Theme.D(8) : labelW - Theme.D(8);
                row[0].SetBounds(p, y + (h - Theme.D(20)) / 2, lw, Theme.D(20));
                if (c is Toggle) c.Location = new Point(p + iw - c.Width, y + (h - c.Height) / 2);
                else if (c is Swatches) c.Location = new Point(p + iw - c.Width, y + (h - c.Height) / 2);
                else if (row.Length > 2) { c.SetBounds(cx, y, cw - Theme.D(64), c.Height); row[2].SetBounds(p + iw - Theme.D(58), y + (h - Theme.D(18)) / 2, Theme.D(58), Theme.D(18)); }
                else c.SetBounds(cx, y, cw, c.Height);
                y += h + Theme.D(12);
            }
            var note = (TextLine)vlcCard.Controls["note"];
            int nh = note.Measure(iw);
            note.SetBounds(p, y, iw, nh); y += nh;
            vlcCard.Height = y + p;
        }

        void LayoutApp(int w)
        {
            int p = appCard.Padding.Left, iw = Inner(appCard, w), y = p;
            foreach (var pair in new[] { new Control[] { autoLabel, autostart }, new Control[] { notifyLabel, notify } })
            {
                pair[0].SetBounds(p, y + Theme.D(2), iw - Theme.D(60), Theme.D(20));
                pair[1].Location = new Point(p + iw - pair[1].Width, y);
                y += Theme.D(34);
            }
            appCard.Height = y - Theme.D(12) + p;
        }

        protected override void OnResize(EventArgs e) { base.OnResize(e); DoLayout(); }

        void Place()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            int h = Math.Min(Theme.D(760), wa.Height - Theme.D(24));
            ClientSize = new Size(ClientSize.Width, h - (Height - ClientSize.Height));
            Location = new Point(wa.Right - Width - Theme.D(12), wa.Bottom - Height - Theme.D(12));
        }

        // ------------------------------------------------------------------ state
        void RefreshSetup()
        {
            bool installed = VlcCheck.Installed(), ok = VlcCheck.Configured();
            vlcMark.Done = ok && installed; vlcMark.Problem = !ok || !installed; vlcMark.Invalidate();
            if (!installed)
            {
                vlcText.Text = "VLC isn't installed yet. Install it and Spoilaint turns on by itself.";
                vlcFix.Text = "Get VLC"; vlcFix.Visible = true;
            }
            else if (!ok)
            {
                vlcText.Text = "VLC's automatic mode is off, so subtitles won't reveal word by word.";
                vlcFix.Text = "Set up VLC"; vlcFix.Visible = true;
            }
            else
            {
                vlcText.Text = "Ready. Open any film in VLC and the subtitles appear word by word.";
                vlcFix.Visible = false;
            }
            string seen = Browsers.AddedIn();
            if (seen != null && !app.GetBool("extensionDone", false)) { app.Set("extensionDone", "1"); app.Save(); }
            bool ext = seen != null || app.GetBool("extensionDone", false);
            extMark.Done = ext; extMark.Invalidate();
            extText.Text = seen != null ? "Added to " + seen + ". Works on Netflix, Prime, Hotstar, SonyLIV, YouTube and more."
                         : ext ? "Added. Works on Netflix, Prime, Hotstar, SonyLIV, YouTube and more."
                               : "For Netflix, Prime, Hotstar, SonyLIV, YouTube and more. Browsers only let you add it yourself; a guide walks you through it in about a minute.";
            extHow.Visible = extDone.Visible = !ext;
            extAgain.Visible = ext;
            UpdateStatus();
            DoLayout();
            setupCard.Invalidate();
        }

        void UpdateStatus()
        {
            var j = runner.Current;
            string s;
            if (j != null) s = "Syncing " + j.Title + (j.Progress >= 0 ? " · " + (int)(j.Progress * 100) + "%" : "");
            else if (!VlcCheck.Configured()) s = "VLC needs setting up";
            else s = "Running in the background · ready";
            status.Text = s;
            if (menuStatus != null) menuStatus.Text = s.Length > 60 ? s.Substring(0, 57) + "..." : s;
            string tip = j != null ? "Spoilaint: syncing " + (j.Progress >= 0 ? (int)(j.Progress * 100) + "%" : "") : "Spoilaint";
            if (tray != null) tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
        }

        void UpdateActivity()
        {
            var j = runner.Current;
            if (j != null)
            {
                actTitle.Text = j.Title;
                string left = j.SecondsLeft > 0 ? (j.SecondsLeft < 60 ? " · about " + Math.Max(1, (int)j.SecondsLeft) + " s left" : " · about " + (int)Math.Ceiling(j.SecondsLeft / 60) + " min left") : "";
                actPhase.Text = j.Phase + (j.Progress >= 0 && j.Progress < 1 ? " · " + (int)(j.Progress * 100) + "%" + left : "");
                actBar.Value = j.Progress;
            }
            UpdateStatus();
            DoLayout();
        }

        void OnFinished(Job j, bool ok, string msg)
        {
            if (j.Task == "extract") return;
            AddRecent(j.Base, j.Title, ok, ok ? "Synced to speech · " + msg : "Couldn't sync: " + msg + ". Using the estimate.");
            if (ok) justSynced[j.Base] = DateTime.Now;
            if (notify.On && ok)
                tray.ShowBalloonTip(5000, "Synced to speech", j.Title + ": words now appear exactly when they're spoken.", ToolTipIcon.None);
            UpdateActivity();
        }

        void OnResult(Result r)
        {
            string detail = r.Count > 0 ? string.Format("{0} of {1} lines matched to speech", r.Synced, r.Count) : "Synced to speech";
            var existing = recent.FirstOrDefault(x => x.Base == r.Base);
            if (existing != null && (DateTime.Now - existing.When).TotalHours < 12)
            {
                existing.Detail = detail; existing.Ok = r.Synced > 0;
                recent.Remove(existing); recent.Insert(0, existing);
                existing.When = DateTime.Now;
                RecentStore.Save(recent);
            }
            else AddRecent(r.Base, r.Title ?? r.Base, r.Synced > 0, detail);
            DoLayout();
        }

        void AddRecent(string b, string title, bool ok, string detail)
        {
            recent.RemoveAll(x => x.Base == b);
            recent.Insert(0, new RecentItem { Base = b, Title = title, Ok = ok, Detail = detail, When = DateTime.Now });
            if (recent.Count > 20) recent.RemoveRange(20, recent.Count - 20);
            RecentStore.Save(recent);
            DoLayout();
        }

        // ------------------------------------------------------------------ VLC settings
        bool loading;
        void LoadSettings()
        {
            loading = true;
            var ini = new Ini(Paths.VlcIni);
            string m = ini.Get("mode", "word");
            style.Selected = m == "chunk" ? 1 : m == "off" ? 2 : 0;
            delay.Value = Math.Max(-500, Math.Min(1500, ini.GetInt("lag", 0)));
            int sz = ini.GetInt("size", 64);
            size.Selected = sz < 58 ? 0 : sz > 71 ? 2 : 1;
            int ti = Array.IndexOf(ThemeKeys, ini.Get("theme", "amber"));
            colours.Selected = ti < 0 ? 0 : ti;
            highlight.On = ini.GetBool("highlight", true);
            box.On = ini.GetBool("box", false);
            ShowDelay();
            loading = false;
        }

        void SaveSettings()
        {
            if (loading) return;
            var ini = new Ini(Paths.VlcIni);
            ini.Set("mode", new[] { "word", "chunk", "off" }[style.Selected]);
            ini.Set("lag", delay.Value.ToString());
            ini.Set("size", Sizes[size.Selected].ToString());
            ini.Set("theme", ThemeKeys[colours.Selected]);
            ini.Set("highlight", highlight.On ? "1" : "0");
            ini.Set("box", box.On ? "1" : "0");
            ini.Save();
        }

        void ShowDelay()
        {
            int v = delay.Value;
            delayValue.Text = v == 0 ? "On time" : (v > 0 ? "+" : "−") + (Math.Abs(v) / 1000.0).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " s";
            delayValue.Invalidate();
        }

        // ------------------------------------------------------------------ window
        public void ShowWindow()
        {
            if (!Visible) { Place(); Show(); }
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            RefreshSetup();
            Activate();
        }
        void ToggleWindow() { if (Visible && WindowState != FormWindowState.Minimized) Hide(); else ShowWindow(); }

        // Sponsors / UPI page, shipped inside the extension folder (opens in the default browser).
        void OpenSupport()
        {
            string page = Path.Combine(Paths.AppDir, "extension", "support.html");
            Tools.Open(File.Exists(page) ? page : "https://github.com/sponsors/sanyamgoelx");
        }

        GuideForm guide;
        public void ShowGuide(string browser)
        {
            if (guide != null && !guide.IsDisposed) { guide.Close(); }
            guide = new GuideForm(browser);
            guide.Added += () => { app.Set("extensionDone", "1"); app.Save(); RefreshSetup(); };
            guide.FormClosed += (s, e) => { guide = null; RefreshSetup(); };
            guide.Show();
            guide.Activate();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!Quitting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                if (!app.GetBool("trayHint", false))
                {
                    app.Set("trayHint", "1"); app.Save();
                    tray.ShowBalloonTip(5000, "Spoilaint is still running", "It syncs films you open in VLC. Click the Spoilaint icon by the clock to open it again.", ToolTipIcon.None);
                }
                return;
            }
            base.OnFormClosing(e);
        }

        public void Quit()
        {
            Quitting = true;
            tray.Visible = false;
            runner.Stop();
            Application.Exit();
        }

        protected override void SetVisibleCore(bool value)
        {
            if (StartHidden && !IsHandleCreated) { CreateHandle(); value = false; }
            base.SetVisibleCore(value);
        }
        public bool StartHidden;
    }

    class LogoMark : Control
    {
        public LogoMark() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var img = AppIcon.Logo();
            if (img != null) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g.DrawImage(img, 0, 0, Width, Height); return; }
            using (var b = new SolidBrush(Theme.Accent)) g.FillEllipse(b, 0, 0, Width - 1, Height - 1);
        }
    }

    static class AppIcon
    {
        static Icon icon;
        static Image logo;
        public static Image Logo()
        {
            if (logo != null) return logo;
            try { var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png"); if (s != null) logo = Image.FromStream(s); } catch { }
            return logo;
        }
        public static Icon Get()
        {
            if (icon != null) return icon;
            try
            {
                var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("spoilaint.ico");
                if (s != null) icon = new Icon(s);
            }
            catch { }
            if (icon == null) try { icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            return icon;
        }
    }

    class DarkMenu : ToolStripProfessionalRenderer
    {
        public DarkMenu() : base(new DarkColors()) { RoundedEdges = false; }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? Theme.Text : Theme.Muted;
            base.OnRenderItemText(e);
        }
        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var r = e.ImageRectangle;
            using (var p = new Pen(Theme.Accent, Theme.D(2)))
                g.DrawLines(p, new[] { new PointF(r.Left + r.Width * 0.2f, r.Top + r.Height * 0.5f), new PointF(r.Left + r.Width * 0.42f, r.Top + r.Height * 0.72f), new PointF(r.Left + r.Width * 0.8f, r.Top + r.Height * 0.3f) });
        }
    }
    class DarkColors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground { get { return Theme.Card; } }
        public override Color MenuBorder { get { return Theme.Line; } }
        public override Color MenuItemBorder { get { return Theme.CardHi; } }
        public override Color MenuItemSelected { get { return Theme.CardHi; } }
        public override Color MenuItemSelectedGradientBegin { get { return Theme.CardHi; } }
        public override Color MenuItemSelectedGradientEnd { get { return Theme.CardHi; } }
        public override Color SeparatorDark { get { return Theme.Line; } }
        public override Color SeparatorLight { get { return Theme.Card; } }
        public override Color ImageMarginGradientBegin { get { return Theme.Card; } }
        public override Color ImageMarginGradientMiddle { get { return Theme.Card; } }
        public override Color ImageMarginGradientEnd { get { return Theme.Card; } }
        public override Color CheckBackground { get { return Theme.Card; } }
        public override Color CheckSelectedBackground { get { return Theme.CardHi; } }
        public override Color CheckPressedBackground { get { return Theme.CardHi; } }
    }

    static class Native
    {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int processId);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr w, IntPtr l);
        // Lets a borderless window be dragged like a title bar.
        public static void DragWindow(IntPtr hwnd)
        {
            try { ReleaseCapture(); SendMessage(hwnd, 0xA1, (IntPtr)2, IntPtr.Zero); } catch { } // WM_NCLBUTTONDOWN, HTCAPTION
        }
        // Windows 11 rounded corners for a borderless window (no effect on Windows 10).
        public static void RoundCorners(IntPtr hwnd)
        {
            try { int round = 2; DwmSetWindowAttribute(hwnd, 33, ref round, 4); } catch { }
        }
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int max);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

        // INPUT for 64-bit Windows: type, then the union at offset 8 (MOUSEINPUT is its largest member: 40 bytes total).
        [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Explicit)] struct INPUT
        {
            [FieldOffset(0)] public uint type;
            [FieldOffset(8)] public MOUSEINPUT mi;
            [FieldOffset(8)] public KEYBDINPUT ki;
        }
        const uint KEYUP = 0x2, UNICODE = 0x4;
        static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = 1 }; i.ki.vk = vk; i.ki.scan = scan; i.ki.flags = flags; return i; }
        static void Send(params INPUT[] keys) { try { SendInput((uint)keys.Length, keys, Marshal.SizeOf(typeof(INPUT))); } catch { } }

        // A Chromium browser window (class Chrome_WidgetWin_1) of the given process, e.g. "brave".
        public static bool IsBrowserWindow(IntPtr hwnd, string process)
        {
            try
            {
                var cls = new System.Text.StringBuilder(64);
                GetClassName(hwnd, cls, 64);
                if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return false;
                uint pid; GetWindowThreadProcessId(hwnd, out pid);
                using (var p = System.Diagnostics.Process.GetProcessById((int)pid))
                    return string.Equals(p.ProcessName, process, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }
        // modifier (0 for none) + key, pressed and released
        public static void KeyCombo(ushort mod, ushort vk)
        {
            if (mod != 0) Send(Key(mod, 0, 0), Key(vk, 0, 0), Key(vk, 0, KEYUP), Key(mod, 0, KEYUP));
            else Send(Key(vk, 0, 0), Key(vk, 0, KEYUP));
        }
        // Types text as characters (independent of the keyboard layout).
        public static void TypeText(string text)
        {
            var list = new List<INPUT>();
            foreach (char c in text) { list.Add(Key(0, c, UNICODE)); list.Add(Key(0, c, UNICODE | KEYUP)); }
            Send(list.ToArray());
        }
        public static void DarkTitle(IntPtr hwnd, Color caption)
        {
            try
            {
                int on = 1;
                if (DwmSetWindowAttribute(hwnd, 20, ref on, 4) != 0) DwmSetWindowAttribute(hwnd, 19, ref on, 4);
                int c = caption.R | (caption.G << 8) | (caption.B << 16);
                DwmSetWindowAttribute(hwnd, 35, ref c, 4); // Windows 11 caption colour
            }
            catch { }
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--setup")
            {
                try { Native.SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var g = Graphics.FromHwnd(IntPtr.Zero)) Theme.Scale = g.DpiX / 96f;
                SetupForm.Run(args);
                return;
            }
            bool background = args.Any(a => a == "--background");
            // --add-extension [chrome|brave|edge], or spoilaint://add-extension/<browser> from the setup page
            string guideFor = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--add-extension") guideFor = i + 1 < args.Length && !args[i + 1].StartsWith("-") ? args[i + 1] : "";
                else if (args[i].StartsWith("spoilaint:", StringComparison.OrdinalIgnoreCase))
                {
                    var parts = args[i].Substring(10).Trim('/').Split('/');
                    if (parts[0].Equals("add-extension", StringComparison.OrdinalIgnoreCase)) guideFor = parts.Length > 1 ? parts[1].ToLowerInvariant() : "";
                    else background = false;
                }
            }
            var guideEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\SpoilaintGuide");
            bool created;
            var mutex = new Mutex(true, "Local\\SpoilaintTray", out created);
            var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\SpoilaintShow");
            var quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\SpoilaintQuit");
            if (!created)
            {
                if (args.Any(a => a == "--quit")) { quitEvent.Set(); return; } // the installer closing us cleanly
                // already running: let it come to the front (Windows only allows that if we pass it on) and show it
                try { Native.AllowSetForegroundWindow(-1); } catch { }
                if (guideFor != null)
                {
                    try { Directory.CreateDirectory(Paths.Data); File.WriteAllText(Path.Combine(Paths.Data, "guide.req"), guideFor); } catch { }
                    guideEvent.Set();
                }
                else if (!background) showEvent.Set();
                return;
            }
            if (args.Any(a => a == "--quit")) return;
            try { Native.SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) Theme.Scale = g.DpiX / 96f;

            var runner = new JobRunner();
            var form = new MainForm(runner) { StartHidden = background || guideFor != null };
            runner.Start();
            var listener = new Thread(() =>
            {
                while (true) { showEvent.WaitOne(); try { form.BeginInvoke((Action)form.ShowWindow); } catch { } }
            }) { IsBackground = true };
            listener.Start();
            new Thread(() =>
            {
                quitEvent.WaitOne();
                try { form.BeginInvoke((Action)form.Quit); } catch { }
            }) { IsBackground = true }.Start();
            new Thread(() =>
            {
                while (true)
                {
                    guideEvent.WaitOne();
                    string want = "";
                    try { var f = Path.Combine(Paths.Data, "guide.req"); want = File.ReadAllText(f).Trim(); File.Delete(f); } catch { }
                    try { form.BeginInvoke((Action)(() => form.ShowGuide(want))); } catch { }
                }
            }) { IsBackground = true }.Start();
            if (guideFor != null)
            {
                EventHandler once = null;
                once = (s, e) => { Application.Idle -= once; form.ShowGuide(guideFor); };
                Application.Idle += once;
            }
            Application.Run(form);
            GC.KeepAlive(mutex);
        }
    }
}
