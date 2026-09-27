#!/usr/bin/env python3
"""Draws the README's figures.

The figures are generated, not hand-drawn, so the set stays consistent and can be
regenerated whenever the claims in the text change. Only Pillow and two open
fonts are needed.

    pip install pillow
    # The two families used below are OFL licensed. Fetch four Shantell Sans
    # weights and two Space Mono weights from Google Fonts into one folder:
    python3 - <<'PY'
    import re, urllib.request, pathlib
    out = pathlib.Path("/tmp/recur-docs/fonts"); out.mkdir(parents=True, exist_ok=True)
    css = urllib.request.urlopen("https://fonts.googleapis.com/css2?family=Shantell+Sans:wght@400;500;700;800").read().decode()
    for weight, url in re.findall(r"font-weight: (\\d+);\\s*src: url\\(([^)]+)\\)", css):
        (out / f"ShantellSans-{weight}.ttf").write_bytes(urllib.request.urlopen(url).read())
    for name in ("Regular", "Bold"):
        url = f"https://raw.githubusercontent.com/google/fonts/main/ofl/spacemono/SpaceMono-{name}.ttf"
        (out / f"SpaceMono-{name}.ttf").write_bytes(urllib.request.urlopen(url).read())
    PY

    FONT_DIR=/tmp/recur-docs/fonts python3 docs/figures/figures.py

Layout is flow based on purpose. Each drawing measures its own text, so a reworded
paragraph grows its box instead of spilling out of it, and the canvas is cropped
to the content it actually holds. The frame (mark, numbered tag, rule, headline,
subtitle) is what makes the set read as one document.
"""

import math
import os
import random

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = os.environ.get("FONT_DIR", "/tmp/recur-docs/fonts")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# The palette: warm paper, navy ink, one peach highlight. Nothing else, so the
# figures sit next to each other without fighting.
PAPER = (247, 243, 232)
INK = (54, 58, 92)
INK_SOFT = (90, 94, 126)
MUTED = (126, 130, 154)
PEACH = (246, 214, 158)
PEACH_LIGHT = (251, 238, 214)
GREEN = (58, 122, 74)
WHITE = (255, 255, 255)

FONTS = {}
MEASURE = ImageDraw.Draw(Image.new("RGB", (1, 1)))


def font(name, size):
    key = (name, size)
    if key not in FONTS:
        FONTS[key] = ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    return FONTS[key]


def hand(size, weight=500):
    """Shantell Sans, the handwritten family the whole document is set in."""
    return font(f"ShantellSans-{weight}.ttf", size)


def mono(size, weight="Regular"):
    """Space Mono, used only for tags and code-shaped labels."""
    return font(f"SpaceMono-{weight}.ttf", size)


def wrap(text, f, max_width, tracking=0):
    """Word wrap by measured width, which is what keeps copy off the edges."""
    words, lines, current = str(text).split(), [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        width = sum(MEASURE.textlength(ch, font=f) + tracking for ch in trial)
        if current and width > max_width:
            lines.append(current)
            current = word
        else:
            current = trial
    if current:
        lines.append(current)
    return lines or [""]


def line_height(size, gap=7):
    return size * 1.32 + gap


def block_height(text, size, weight, max_width, gap=7):
    """The height a wrapped paragraph will occupy, so boxes can be sized to it."""
    lines = wrap(text, hand(size, weight), max_width)
    return len(lines) * line_height(size, gap) - gap


class Sketch:
    """A figure's canvas, plus the few primitives every drawing needs.

    Strokes are jittered a little on purpose: a perfectly straight line reads as
    a diagram, a slightly wobbly one reads as a drawing of one.
    """

    def __init__(self, width, height, tag, title, subtitle=None, seed=1):
        self.w = width
        self.h = height
        self.random = random.Random(seed)
        self.image = Image.new("RGB", (width, height), PAPER)
        self.d = ImageDraw.Draw(self.image)
        self.margin = 84
        self._bottom = 0
        self._header(tag)
        self.content_top = self._title(title, subtitle) + 34

    def track(self, y):
        if y > self._bottom:
            self._bottom = y
        return y

    # ---------------------------------------------------------------- header

    def _header(self, tag):
        self._mark(self.margin, 62)
        if tag:
            self._tag(tag)
        self.rule(self.margin, self.w - self.margin, 146, width=3)

    def _mark(self, x, y):
        """A small navy monogram, then the wordmark, in the top left corner."""
        size = 34
        self.round_box(x, y, size, size, radius=9, outline=INK, width=3, fill=None)
        for i, dy in enumerate((9, 15, 21)):
            wobble = [3, 12, 21, 27] if i % 2 == 0 else [3, 10, 19, 27]
            points = [(x + px, y + dy + self.random.uniform(-0.6, 0.6)) for px in wobble]
            self.d.line(points, fill=INK, width=2)
        self.text(x + size + 14, y + size / 2, "Recur", hand(30, 800), INK, anchor="lm")

    def _tag(self, tag):
        label = tag.upper()
        f = mono(18, "Bold")
        tw = self.tracked_width(label, f, 3)
        pad = 18
        box_w, box_h = tw + pad * 2, 38
        x, y = self.w - self.margin - box_w, 62
        self.d.rectangle([x, y, x + box_w, y + box_h], fill=PEACH, outline=INK, width=2)
        self.tracked_text(x + pad, y + box_h / 2, label, f, INK, 3, anchor="lm")

    def _title(self, title, subtitle):
        y = 214
        for line in title:
            self.text(self.margin, y, line, hand(62, 800), INK)
            y += 82
        if subtitle:
            y += 8
            for line in wrap(subtitle, hand(29, 400), self.w - self.margin * 2):
                self.text(self.margin, y, line, hand(29, 400), INK_SOFT)
                y += 44
        return y

    # ---------------------------------------------------------------- shapes

    def rule(self, x1, x2, y, width=2, colour=INK):
        span = x2 - x1
        points = [(x1 + span * t, y + self.random.uniform(-0.9, 0.9)) for t in (0, 0.25, 0.5, 0.75, 1)]
        # A gap in the rule, like a pencil that skipped, is what the reference
        # frames have and what stops it reading as a browser border.
        self.d.line(points[:3], fill=colour, width=width)
        self.d.line(points[3:], fill=colour, width=width)
        return self.track(y + 3)

    def _path(self, box, radius, jitter):
        """Points around a rounded rectangle, nudged so the edge reads as drawn."""
        x, y, w, h = box
        r = min(radius, w / 2, h / 2)
        points = []
        corners = [
            (x + r, y, 180, 270),
            (x + w - r, y + r, 270, 360),
            (x + w - r, y + h - r, 0, 90),
            (x + r, y + h - r, 90, 180),
        ]
        joiners = [(x + w - r, y), (x + w, y + h - r), (x + r, y + h)]
        for i, (cx, cy, start, end) in enumerate(corners):
            for step in range(9):
                angle = math.radians(start + (end - start) * step / 8)
                points.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
            if i < 3:
                points.append(joiners[i])
        if jitter:
            points = [(px + self.random.uniform(-jitter, jitter), py + self.random.uniform(-jitter, jitter)) for px, py in points]
        return points

    def round_box(self, x, y, w, h, radius=16, fill=None, outline=INK, width=3, jitter=1.1):
        points = self._path((x, y, w, h), radius, jitter)
        if fill:
            self.d.polygon(points, fill=fill)
        self.d.line(points + [points[0]], fill=outline, width=width, joint="curve")
        self.track(y + h)
        return (x, y, w, h)

    def panel(self, x, y, w, h, fill=WHITE, radius=22, outline=INK, width=3):
        """A card with a soft shadow, used for the main drawing containers."""
        self.d.rounded_rectangle([x + 5, y + 7, x + w + 5, y + h + 7], radius=radius, fill=(232, 226, 210))
        return self.round_box(x, y, w, h, radius=radius, fill=fill, outline=outline, width=width)

    def band(self, x, y, w, h, text, fill=PEACH_LIGHT, size=25, weight=500, pad=26):
        """A full-width note strip carrying one sentence."""
        self.round_box(x, y, w, h, radius=14, fill=fill, outline=INK, width=3)
        self.sentence(x + pad, y + h / 2, text, size, weight, w - pad * 2, anchor="lm")
        return y + h

    def arrow(self, x1, y1, x2, y2, label=None, width=3, colour=INK, both=False, curve=0.0):
        if curve:
            mid = ((x1 + x2) / 2, (y1 + y2) / 2 + curve)
            points = [
                ((1 - t) ** 2 * x1 + 2 * (1 - t) * t * mid[0] + t ** 2 * x2, (1 - t) ** 2 * y1 + 2 * (1 - t) * t * mid[1] + t ** 2 * y2)
                for t in [i / 12 for i in range(13)]
            ]
        else:
            points = [(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t) for t in [i / 8 for i in range(9)]]
        points = [(px + self.random.uniform(-0.5, 0.5), py + self.random.uniform(-0.5, 0.5)) for px, py in points]
        self.d.line(points, fill=colour, width=width)
        self._head(points[-2], (x2, y2), colour, width)
        if both:
            self._head(points[1], (x1, y1), colour, width)
        if label:
            self.text((x1 + x2) / 2, (y1 + y2) / 2 - 20, label, hand(21, 500), INK_SOFT, anchor="mm")
        self.track(max(y1, y2) + 6)

    def _head(self, src, tip, colour, width):
        angle = math.atan2(tip[1] - src[1], tip[0] - src[0])
        size = 15
        for spread in (math.radians(150), math.radians(-150)):
            self.d.line(
                [(tip[0], tip[1]), (tip[0] + size * math.cos(angle + spread), tip[1] + size * math.sin(angle + spread))],
                fill=colour,
                width=width,
            )

    # ---------------------------------------------------------------- text

    def text(self, x, y, value, f, fill=INK, anchor="la"):
        self.d.text((x, y), value, font=f, fill=fill, anchor=anchor)
        bottom = y + (f.size * 0.8 if anchor in ("mm", "lm", "rm") else f.size * 1.25)
        return self.track(bottom)

    def tracked_width(self, value, f, tracking=0):
        return sum(self.d.textlength(ch, font=f) + tracking for ch in value) - tracking

    def tracked_text(self, x, y, value, f, fill=INK, tracking=3, anchor="la"):
        cursor = x
        for ch in value:
            self.d.text((cursor, y), ch, font=f, fill=fill, anchor=anchor)
            cursor += self.d.textlength(ch, font=f) + tracking
        return self.track(y + f.size * (0.8 if anchor in ("mm", "lm", "rm") else 1.25))

    def caps(self, x, y, value, size=20, fill=INK, anchor="la", tracking=2):
        return self.tracked_text(x, y, value.upper(), mono(size, "Bold"), fill, tracking, anchor)

    def sentence(self, x, y, text, size=22, weight=500, max_width=520, anchor="la", fill=INK, gap=7):
        """A wrapped paragraph. Returns the y just past its last line."""
        f = hand(size, weight)
        lines = wrap(text, f, max_width)
        step = line_height(size, gap)
        top = y - (step * len(lines) - gap) / 2 if anchor == "lm" else y
        for i, line in enumerate(lines):
            self.d.text((x, top + i * step), line, font=f, fill=fill)
        return self.track(top + step * len(lines))

    def mono_block(self, x, y, text, size=19, max_width=520, fill=INK, gap=6):
        f = mono(size)
        step = line_height(size, gap)
        row = 0
        for raw in str(text).split("\n"):
            for line in wrap(raw, f, max_width):
                self.tracked_text(x, y + row * step, line, f, fill, 0)
                row += 1
        return self.track(y + row * step)

    # ---------------------------------------------------------------- output

    def save(self, name):
        bottom = int(min(self.h, math.ceil(self._bottom + 76)))
        if self._bottom + 40 > self.h:
            print(f"!! {name}: content ran {int(self._bottom - self.h)}px past the canvas")
        self.image.crop((0, 0, self.w, bottom)).save(os.path.join(OUT_DIR, name), "PNG", optimize=True)
        print("wrote", name, f"({self.w}x{bottom})")
