// Hand-drawn controls in Spoilaint's look (warm dark cards, amber accent), matching the setup page.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

namespace Spoilaint
{
    static class Theme
    {
        public static readonly Color Bg = Hex("#120D09");
        public static readonly Color Card = Hex("#1A130D");
        public static readonly Color CardHi = Hex("#231A12");
        public static readonly Color Line = Hex("#3A2A1C");
        public static readonly Color Text = Hex("#F3EDE4");
        public static readonly Color Muted = Hex("#B3A79A");
        public static readonly Color Faint = Hex("#7D7266");
        public static readonly Color Accent = Hex("#FFB23F");
        public static readonly Color Ink = Hex("#1E1406");
        public static readonly Color Good = Hex("#5FD892");
        public static readonly Color Warn = Hex("#FF8A65");
        public static float Scale = 1f;
        public static int D(float px) { return (int)Math.Round(px * Scale); }

        public static readonly string FontName = PickFont();
        static string PickFont()
        {
            using (var fonts = new InstalledFontCollection())
                foreach (var f in fonts.Families)
                    if (f.Name == "Segoe UI Variable Text") return f.Name;
            return "Segoe UI";
        }
        public static Font F(float pt, FontStyle st = FontStyle.Regular) { return new Font(FontName, pt, st, GraphicsUnit.Point); }
        public static readonly Font Body = F(9.75f);
        public static readonly Font BodyBold = F(9.75f, FontStyle.Bold);
        public static readonly Font Small = F(8.5f);
        public static readonly Font SmallBold = F(8.5f, FontStyle.Bold);
        public static readonly Font Title = F(15f, FontStyle.Bold);
        public static readonly Font Heading = F(8.25f, FontStyle.Bold);

        public static Color Hex(string h)
        {
            h = h.TrimStart('#');
            return Color.FromArgb(Convert.ToInt32(h.Substring(0, 2), 16), Convert.ToInt32(h.Substring(2, 2), 16), Convert.ToInt32(h.Substring(4, 2), 16));
        }
        public static Color Mix(Color a, Color b, float t)
        {
            return Color.FromArgb((int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));
        }
        public static GraphicsPath Round(RectangleF r, float rad)
        {
            var p = new GraphicsPath();
            float d = Math.Min(rad * 2, Math.Min(r.Width, r.Height));
            if (d <= 0) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
        public static void Smooth(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        }
        public static void DrawText(Graphics g, string s, Font f, Color c, Rectangle r, TextFormatFlags extra = 0)
        {
            TextRenderer.DrawText(g, s, f, r, c, TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | extra);
        }
    }

    // Base: double-buffered, paints its parent's background colour.
    class Drawn : Control
    {
        public Drawn()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Theme.Card;
            ForeColor = Theme.Text;
        }
        protected bool hover, down;
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
    }

    // Rounded card that holds other controls.
    class Card : Panel
    {
        public Card()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Card;
            Padding = new Padding(Theme.D(18));
        }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.Bg);
            Theme.Smooth(g);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            using (var path = Theme.Round(r, Theme.D(14)))
            using (var b = new SolidBrush(Theme.Card))
            using (var p = new Pen(Theme.Line, 1))
            {
                g.FillPath(b, path);
                g.DrawPath(p, path);
            }
        }
    }

    class TextLine : Drawn
    {
        public Font TextFont = Theme.Body;
        public Color Colour = Theme.Text;
        public bool Wrap;
        public TextLine(string text, Font f, Color c, bool wrap = false) { Text = text; TextFont = f; Colour = c; Wrap = wrap; }
        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }
        public int Measure(int width)
        {
            var flags = TextFormatFlags.NoPadding | (Wrap ? TextFormatFlags.WordBreak : TextFormatFlags.SingleLine);
            return TextRenderer.MeasureText(Text ?? "", TextFont, new Size(width, 10000), flags).Height;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            Theme.DrawText(e.Graphics, Text ?? "", TextFont, Colour, ClientRectangle, Wrap ? TextFormatFlags.WordBreak : TextFormatFlags.SingleLine);
        }
    }

    class Btn : Drawn
    {
        public bool Primary;
        public Btn(string text, bool primary) { Text = text; Primary = primary; Cursor = Cursors.Hand; Font = Theme.BodyBold; Height = Theme.D(34); }
        public int Natural() { return TextRenderer.MeasureText(Text, Font).Width + Theme.D(28); }
        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            Color fill = Primary ? (down ? Theme.Mix(Theme.Accent, Theme.Ink, 0.15f) : hover ? Theme.Mix(Theme.Accent, Color.White, 0.15f) : Theme.Accent)
                                 : (down ? Theme.Line : hover ? Theme.CardHi : Theme.Card);
            using (var path = Theme.Round(r, Theme.D(10)))
            using (var b = new SolidBrush(fill))
            {
                g.FillPath(b, path);
                if (!Primary) using (var p = new Pen(Theme.Line)) g.DrawPath(p, path);
            }
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, Primary ? Theme.Ink : Theme.Text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }

    class LinkText : Drawn
    {
        public LinkText(string text) { Text = text; Cursor = Cursors.Hand; Font = Theme.SmallBold; }
        public int Natural() { return TextRenderer.MeasureText(Text, Font).Width + 2; }
        protected override void OnPaint(PaintEventArgs e)
        {
            Theme.DrawText(e.Graphics, Text, Font, hover ? Theme.Mix(Theme.Accent, Color.White, 0.25f) : Theme.Accent, ClientRectangle, TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }
    }

    class Toggle : Drawn
    {
        bool on;
        public event EventHandler Changed;
        public bool On { get { return on; } set { on = value; Invalidate(); } }
        public Toggle() { Size = new Size(Theme.D(40), Theme.D(22)); Cursor = Cursors.Hand; }
        protected override void OnClick(EventArgs e) { on = !on; Invalidate(); if (Changed != null) Changed(this, e); base.OnClick(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            using (var path = Theme.Round(r, r.Height / 2))
            using (var b = new SolidBrush(on ? Theme.Accent : Theme.Line))
                g.FillPath(b, path);
            float k = Height - Theme.D(6);
            float x = on ? Width - k - Theme.D(3) : Theme.D(3);
            using (var b = new SolidBrush(on ? Theme.Ink : Theme.Muted))
                g.FillEllipse(b, x, Theme.D(3), k, k);
        }
    }

    // Row of options, one selected.
    class Segmented : Drawn
    {
        public string[] Options;
        int sel, hot = -1;
        public event EventHandler Changed;
        public int Selected { get { return sel; } set { sel = value; Invalidate(); } }
        public Segmented(params string[] options) { Options = options; Height = Theme.D(34); Font = Theme.SmallBold; Cursor = Cursors.Hand; }
        int At(int x) { return Math.Max(0, Math.Min(Options.Length - 1, x * Options.Length / Math.Max(1, Width))); }
        protected override void OnMouseMove(MouseEventArgs e) { int h = At(e.X); if (h != hot) { hot = h; Invalidate(); } base.OnMouseMove(e); }
        protected override void OnMouseLeave(EventArgs e) { hot = -1; base.OnMouseLeave(e); }
        protected override void OnMouseClick(MouseEventArgs e)
        {
            int i = At(e.X);
            if (i != sel) { sel = i; Invalidate(); if (Changed != null) Changed(this, e); }
            base.OnMouseClick(e);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            using (var path = Theme.Round(r, Theme.D(10)))
            using (var b = new SolidBrush(Theme.Bg))
            using (var p = new Pen(Theme.Line))
            { g.FillPath(b, path); g.DrawPath(p, path); }
            float w = (Width - Theme.D(6)) / (float)Options.Length;
            for (int i = 0; i < Options.Length; i++)
            {
                var cell = new RectangleF(Theme.D(3) + i * w, Theme.D(3), w, Height - Theme.D(6));
                if (i == sel || i == hot)
                    using (var path = Theme.Round(cell, Theme.D(8)))
                    using (var b = new SolidBrush(i == sel ? Theme.Accent : Theme.CardHi))
                        g.FillPath(b, path);
                TextRenderer.DrawText(g, Options[i], Font, Rectangle.Round(cell), i == sel ? Theme.Ink : Theme.Text,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
            }
        }
    }

    // Colour dots for the "newest word" colour.
    class Swatches : Drawn
    {
        public string[] Keys; public Color[] Colours;
        int sel;
        public event EventHandler Changed;
        public int Selected { get { return sel; } set { sel = value; Invalidate(); } }
        public Swatches(string[] keys, Color[] colours) { Keys = keys; Colours = colours; Height = Theme.D(30); Width = Theme.D(36) * keys.Length; Cursor = Cursors.Hand; }
        protected override void OnMouseClick(MouseEventArgs e)
        {
            int i = Math.Min(Keys.Length - 1, e.X / Theme.D(36));
            if (i != sel) { sel = i; Invalidate(); if (Changed != null) Changed(this, e); }
            base.OnMouseClick(e);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            for (int i = 0; i < Keys.Length; i++)
            {
                float x = i * Theme.D(36) + Theme.D(3), y = Theme.D(3), s = Theme.D(24);
                if (i == sel) using (var p = new Pen(Theme.Text, Theme.D(2))) g.DrawEllipse(p, x - Theme.D(2), y - Theme.D(2), s + Theme.D(4), s + Theme.D(4));
                using (var b = new SolidBrush(Colours[i])) g.FillEllipse(b, x + Theme.D(2), y + Theme.D(2), s - Theme.D(4), s - Theme.D(4));
            }
        }
    }

    class Slider : Drawn
    {
        public int Min, Max, Step, Value;
        public event EventHandler Changed;
        bool drag;
        public Slider(int min, int max, int step, int value) { Min = min; Max = max; Step = step; Value = value; Height = Theme.D(26); Cursor = Cursors.Hand; }
        float Knob { get { return Theme.D(9); } }
        float XOf(int v) { return Knob + (Width - 2 * Knob) * (v - Min) / (float)(Max - Min); }
        void SetFromX(int x)
        {
            float t = (x - Knob) / Math.Max(1f, Width - 2 * Knob);
            int v = Min + (int)Math.Round(Math.Max(0, Math.Min(1, t)) * (Max - Min) / Step) * Step;
            if (v != Value) { Value = v; Invalidate(); if (Changed != null) Changed(this, EventArgs.Empty); }
        }
        protected override void OnMouseDown(MouseEventArgs e) { drag = true; SetFromX(e.X); base.OnMouseDown(e); }
        protected override void OnMouseMove(MouseEventArgs e) { if (drag) SetFromX(e.X); base.OnMouseMove(e); }
        protected override void OnMouseUp(MouseEventArgs e) { drag = false; base.OnMouseUp(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            float cy = Height / 2f, h = Theme.D(4);
            using (var b = new SolidBrush(Theme.Line)) g.FillRectangle(b, Knob, cy - h / 2, Width - 2 * Knob, h);
            float zero = XOf(Math.Max(Min, Math.Min(Max, 0))), x = XOf(Value);
            using (var b = new SolidBrush(Theme.Accent)) g.FillRectangle(b, Math.Min(zero, x), cy - h / 2, Math.Abs(x - zero), h);
            using (var b = new SolidBrush(Theme.Muted)) g.FillEllipse(b, zero - Theme.D(2), cy - Theme.D(2), Theme.D(4), Theme.D(4));
            using (var b = new SolidBrush(hover || drag ? Theme.Mix(Theme.Accent, Color.White, 0.2f) : Theme.Accent))
                g.FillEllipse(b, x - Knob, cy - Knob, Knob * 2, Knob * 2);
        }
    }

    class Bar : Drawn
    {
        float value = -1; int phase;
        readonly Timer anim = new Timer { Interval = 40 };
        public Bar()
        {
            Height = Theme.D(8);
            anim.Tick += (s, e) => { phase = (phase + 3) % 200; Invalidate(); };
        }
        public float Value
        {
            get { return value; }
            set { this.value = value; anim.Enabled = value < 0 && Visible; Invalidate(); }
        }
        protected override void OnVisibleChanged(EventArgs e) { anim.Enabled = value < 0 && Visible; base.OnVisibleChanged(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var r = new RectangleF(0, 0, Width, Height);
            using (var path = Theme.Round(r, Height / 2f)) using (var b = new SolidBrush(Theme.Line)) g.FillPath(b, path);
            RectangleF f;
            if (value < 0) { float w = Width * 0.3f; f = new RectangleF((Width + w) * phase / 200f - w, 0, w, Height); }
            else f = new RectangleF(0, 0, Math.Max(Height, Width * value), Height);
            g.SetClip(r);
            using (var path = Theme.Round(f, Height / 2f)) using (var b = new SolidBrush(Theme.Accent)) g.FillPath(b, path);
        }
        protected override void Dispose(bool disposing) { if (disposing) anim.Dispose(); base.Dispose(disposing); }
    }

    // A numbered setup step: circle (number or tick), title and a line of text.
    class StepMark : Drawn
    {
        public string Label; public bool Done; public bool Problem; public bool Muted;
        public StepMark() { Size = new Size(Theme.D(28), Theme.D(28)); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            var r = new RectangleF(1, 1, Width - 2, Height - 2);
            Color fill = Done ? Theme.Mix(Theme.Good, Theme.Card, 0.8f) : Problem ? Theme.Mix(Theme.Warn, Theme.Card, 0.8f) : Muted ? Theme.Line : Theme.Accent;
            using (var b = new SolidBrush(fill)) g.FillEllipse(b, r);
            if (Done)
            {
                using (var p = new Pen(Theme.Good, Theme.D(2.2f)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    g.DrawLines(p, new[] { new PointF(Width * 0.3f, Height * 0.52f), new PointF(Width * 0.45f, Height * 0.67f), new PointF(Width * 0.72f, Height * 0.36f) });
            }
            else
                TextRenderer.DrawText(g, Problem ? "!" : Label, Theme.BodyBold, ClientRectangle, Problem ? Theme.Warn : Muted ? Theme.Muted : Theme.Ink,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }

    // Thin scrollbar drawn in the theme; drag to scroll.
    class ScrollThumb : Drawn
    {
        public event Action<int> Dragged;
        int lastY; bool drag;
        public ScrollThumb() { Cursor = Cursors.Default; }
        protected override void OnMouseDown(MouseEventArgs e) { drag = true; lastY = Cursor.Position.Y; base.OnMouseDown(e); }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (drag) { int y = Cursor.Position.Y; if (Dragged != null) Dragged(y - lastY); lastY = y; }
            base.OnMouseMove(e);
        }
        protected override void OnMouseUp(MouseEventArgs e) { drag = false; base.OnMouseUp(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            float w = hover || drag ? Theme.D(6) : Theme.D(4);
            var r = new RectangleF(Width - w - Theme.D(2), Theme.D(2), w, Height - Theme.D(4));
            using (var path = Theme.Round(r, w / 2)) using (var b = new SolidBrush(hover || drag ? Theme.Muted : Theme.Line)) g.FillPath(b, path);
        }
    }

    // Recently synced films.
    class RecentList : Drawn
    {
        public List<RecentItem> Items = new List<RecentItem>();
        public int Max = 4;
        public int RowH { get { return Theme.D(44); } }
        public int Rows { get { return Math.Min(Max, Items.Count); } }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Theme.Smooth(g);
            for (int i = 0; i < Rows; i++)
            {
                var it = Items[i];
                int y = i * RowH;
                if (i > 0) using (var p = new Pen(Theme.Line)) g.DrawLine(p, 0, y, Width, y);
                using (var b = new SolidBrush(it.Ok ? Theme.Good : Theme.Warn)) g.FillEllipse(b, 0, y + Theme.D(12), Theme.D(7), Theme.D(7));
                int tx = Theme.D(16);
                string when = Ago(it.When);
                int ww = TextRenderer.MeasureText(when, Theme.Small).Width;
                Theme.DrawText(g, it.Title, Theme.BodyBold, Theme.Text, new Rectangle(tx, y + Theme.D(6), Width - tx - ww - Theme.D(10), Theme.D(18)), TextFormatFlags.SingleLine);
                Theme.DrawText(g, when, Theme.Small, Theme.Faint, new Rectangle(Width - ww, y + Theme.D(7), ww, Theme.D(16)), TextFormatFlags.SingleLine);
                Theme.DrawText(g, it.Detail, Theme.Small, Theme.Muted, new Rectangle(tx, y + Theme.D(24), Width - tx, Theme.D(16)), TextFormatFlags.SingleLine);
            }
        }
        public static string Ago(DateTime t)
        {
            var d = DateTime.Now - t;
            if (d.TotalSeconds < 60) return "just now";
            if (d.TotalMinutes < 60) return (int)d.TotalMinutes + " min ago";
            if (t.Date == DateTime.Today) return "today " + t.ToString("HH:mm");
            if (t.Date == DateTime.Today.AddDays(-1)) return "yesterday";
            return t.ToString("d MMM");
        }
    }
}
