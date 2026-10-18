#!/usr/bin/env python3
"""Draws the README's figures.

The figures are generated rather than hand-drawn, so the set stays consistent
and can be regenerated whenever the text changes. Pillow and two OFL fonts are
the only requirements.

    pip install pillow
    python3 - <<'PY'
    import pathlib, urllib.request
    out = pathlib.Path("/tmp/recur-docs/fonts")
    out.mkdir(parents=True, exist_ok=True)
    base = "https://raw.githubusercontent.com/google/fonts/main/ofl/"
    files = {
        "ShantellSans.ttf": "shantellsans/ShantellSans%5BBNCE,INFM,SPAC,wght%5D.ttf",
        "SpaceMono-Regular.ttf": "spacemono/SpaceMono-Regular.ttf",
        "SpaceMono-Bold.ttf": "spacemono/SpaceMono-Bold.ttf",
    }
    for name, path in files.items():
        (out / name).write_bytes(urllib.request.urlopen(base + path).read())
    PY

    FONT_DIR=/tmp/recur-docs/fonts python3 docs/figures/figures.py

Everything is drawn at twice the final size and downsampled once, which is what
keeps 2px rules and curved corners free of stair-stepping at the size the images
are actually read at. Layout is flow based: a box is sized from the text it
holds, so rewording a paragraph grows its box instead of crowding its edges.
"""

import math
import os

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = os.environ.get("FONT_DIR", "/tmp/recur-docs/fonts")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# Final image width. Everything below is expressed in final pixels; the canvas
# doubles them while drawing and resolves them back down on save.
W = 1400

# Drawing happens at this multiple of the final size, so a half-pixel detail
# still lands on the pixel grid once the image is reduced.
SS = 2

MARGIN = 72
GUTTER = 40

# Warm paper, navy ink, one peach accent. No gradients and no shadows, so the
# eight figures sit next to each other without fighting.
PAPER = (248, 244, 234)
INK = (52, 56, 88)
INK_SOFT = (84, 88, 118)
MUTED = (124, 128, 152)
LINE = (223, 214, 194)
PEACH = (246, 213, 156)
PEACH_LIGHT = (252, 240, 216)
GREEN = (52, 118, 78)
WHITE = (255, 255, 255)


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


_FONTS = {}


def _load(kind, size, weight):
    """A font at drawing size, with the variable axes pinned to a clean setting."""
    key = (kind, size, weight)
    if key not in _FONTS:
        path = os.path.join(FONT_DIR, "ShantellSans.ttf" if kind == "hand" else f"SpaceMono-{weight}.ttf")
        f = ImageFont.truetype(path, int(round(size * SS)))
        if kind == "hand":
            # Axes order: Weight, Informality, Bounce, Spacing. Bounce and
            # informality stay at zero, so the letterforms are even.
            f.set_variation_by_axes([weight, 0, 0, 0])
        _FONTS[key] = f
    return _FONTS[key]


class Face:
    """A text style: family, size, weight, colour, optional letter tracking."""

    def __init__(self, kind, size, weight=400, colour=INK, tracking=0.0, line=None):
        self.kind = kind
        self.size = size
        self.weight = weight
        self.colour = colour
        self.tracking = tracking
        self.line = line if line is not None else round(size * 1.46)
        self.f = _load(kind, size, weight)
        ascent, descent = self.f.getmetrics()
        self.ascent = ascent / SS
        self.descent = descent / SS
        self.cap = -self.f.getbbox("Hd", anchor="ls")[1] / SS

    def width(self, text):
        if not self.tracking:
            return self.f.getlength(text) / SS
        return (sum(self.f.getlength(ch) for ch in text) + self.tracking * (len(text) - 1) * SS) / SS

    def with_colour(self, colour):
        twin = Face.__new__(Face)
        twin.__dict__.update(self.__dict__)
        twin.colour = colour
        return twin


# --------------------------------------------------------------------- faces


def hand(size, weight=400, colour=INK, line=None):
    return Face("hand", size, weight, colour, 0.0, line)


def mono(size, weight="Regular", colour=INK, tracking=1.6, line=None):
    return Face("mono", size, weight, colour, tracking, line)


# Space Mono has Regular and Bold only, so weight is a family lookup instead.
def mono_bold(size, colour=INK, tracking=1.6):
    return Face("mono", size, "Bold", colour, tracking)


def caps_bold(size=13, colour=INK_SOFT, tracking=2.2):
    return Face("mono", size, "Bold", colour, tracking)


def wrap(text, face, width):
    """Word wrap by measured width, which is what keeps copy off the edges."""
    words = str(text).split()
    lines, current = [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        if current and face.width(trial) > width:
            lines.append(current)
            current = word
        else:
            current = trial
    if current:
        lines.append(current)
    return lines or [""]


def para_height(text, face, width):
    return len(wrap(text, face, width)) * face.line


class Canvas:
    """A figure: frame, drawing primitives, and a content cursor."""

    def __init__(self, tag=None, title=None, lead=None, lead_width=1040, header=True, height=None):
        self.w = W
        self.h = height or 2400  # cropped on save unless a height is fixed
        self.img = Image.new("RGB", (self.w * SS, self.h * SS), PAPER)
        self.d = ImageDraw.Draw(self.img)
        self.bottom = 0
        self.fixed = height
        if header:
            self._header(tag, title, lead, lead_width)
        else:
            self.content_top = 0
        self.y = self.content_top

    # ------------------------------------------------------------- primitives

    def _s(self, value):
        return int(round(value * SS))

    def rect(self, x, y, w, h, fill=None, stroke=None, width=2, radius=0):
        box = [self._s(x), self._s(y), self._s(x + w), self._s(y + h)]
        if radius:
            self.d.rounded_rectangle(
                box, radius=self._s(radius), fill=fill, outline=stroke, width=max(1, self._s(width))
            )
        else:
            self.d.rectangle(box, fill=fill, outline=stroke, width=max(1, self._s(width)))
        self._touch(y + h)

    def card(self, x, y, w, h, fill=WHITE, stroke=INK, width=2, radius=16, pad=0):
        """A white panel. Returns the inner content box, already padded."""
        self.rect(x, y, w, h, fill=fill, stroke=stroke, width=width, radius=radius)
        return (x + pad, y + pad, w - pad * 2, h - pad * 2)

    def rule(self, x1, x2, y, colour=LINE, width=1.5):
        self.d.line(
            [(self._s(x1), self._s(y)), (self._s(x2), self._s(y))],
            fill=colour,
            width=max(1, self._s(width)),
        )
        self._touch(y + width)

    def line(self, points, colour=INK, width=2.5, joint="curve"):
        pts = [(self._s(px), self._s(py)) for px, py in points]
        self.d.line(pts, fill=colour, width=max(1, self._s(width)), joint=joint)
        self._touch(max(py for _, py in points))

    def arrow(self, x1, y1, x2, y2, colour=INK_SOFT, width=2.2, head=9):
        self.line([(x1, y1), (x2, y2)], colour, width)
        angle = math.atan2(y2 - y1, x2 - x1)
        for spread in (math.radians(152), math.radians(-152)):
            self.line(
                [
                    (x2, y2),
                    (x2 + head * math.cos(angle + spread), y2 + head * math.sin(angle + spread)),
                ],
                colour,
                width,
            )

    def chip(self, x, y, text, face, fill=PEACH_LIGHT, stroke=INK, pad_x=14, height=32, radius=8, width=1.5):
        w = face.width(text) + pad_x * 2
        self.rect(x, y, w, height, fill=fill, stroke=stroke, width=width, radius=radius)
        self.text(x + pad_x, y + height / 2 + face.cap / 2, text, face)
        return w

    def badge(self, x, y, number, size=34):
        self.d.ellipse(
            [self._s(x), self._s(y), self._s(x + size), self._s(y + size)],
            fill=PEACH,
            outline=INK,
            width=self._s(1.5),
        )
        f = mono_bold(16)
        self.text(x + size / 2 - f.width(str(number)) / 2, y + size / 2 + f.cap / 2, str(number), f)
        self._touch(y + size)

    def tick(self, x, y, scale=1.0, colour=GREEN):
        self.line(
            [
                (x, y + 5 * scale),
                (x + 5 * scale, y + 10 * scale),
                (x + 14 * scale, y - 1 * scale),
            ],
            colour,
            3.0,
        )

    def cross(self, x, y, scale=1.0, colour=MUTED):
        self.line([(x, y + 1 * scale), (x + 10 * scale, y + 11 * scale)], colour, 2.4)
        self.line([(x, y + 11 * scale), (x + 10 * scale, y + 1 * scale)], colour, 2.4)

    def dot(self, x, y, radius=3.5, colour=MUTED):
        self.d.ellipse(
            [self._s(x - radius), self._s(y - radius), self._s(x + radius), self._s(y + radius)],
            fill=colour,
        )

    # ------------------------------------------------------------------ text

    def text(self, x, baseline, value, face, colour=None):
        """Draws on the baseline, so vertical rhythm stays exact."""
        fill = colour or face.colour
        if face.tracking:
            cursor = x
            for ch in value:
                self.d.text((self._s(cursor), self._s(baseline)), ch, font=face.f, fill=fill, anchor="ls")
                cursor += face.f.getlength(ch) / SS + face.tracking
        else:
            self.d.text((self._s(x), self._s(baseline)), value, font=face.f, fill=fill, anchor="ls")
        self._touch(baseline + face.descent * 0.6)
        return x + face.width(value)

    def para(self, x, top, value, face, width, colour=None):
        """A wrapped paragraph. `top` is the top of its first line box."""
        lines = wrap(value, face, width)
        for index, line in enumerate(lines):
            self.text(x, top + index * face.line + face.ascent, line, face, colour)
        return top + len(lines) * face.line

    def mono_block(self, x, top, value, face, width, colour=None):
        row = top
        for raw in str(value).split("\n"):
            for line in wrap(raw, face, width):
                self.text(x, row + face.ascent, line, face, colour)
                row += face.line
        return row

    # ---------------------------------------------------------------- header

    def _touch(self, y):
        if y > self.bottom:
            self.bottom = y

    def _header(self, tag, title, lead, lead_width):
        mark = 30
        self.rect(MARGIN, 54, mark, mark, fill=None, stroke=INK, width=2, radius=8)
        for index, offset in enumerate((8, 15, 22)):
            self.line(
                [(MARGIN + 7, 54 + offset), (MARGIN + mark - 7, 54 + offset)],
                INK,
                2.0,
            )
        wordmark = hand(25, 700)
        self.text(MARGIN + mark + 12, 54 + mark / 2 + wordmark.cap / 2, "Recur", wordmark)

        if tag:
            label = tag.upper()
            f = caps_bold(13)
            height = 32
            self.chip(
                self.w - MARGIN - (f.width(label) + 32),
                54 + (mark - height) / 2,
                label,
                f,
                pad_x=16,
                height=height,
            )

        self.rule(MARGIN, self.w - MARGIN, 118)

        title_face = hand(52, 700, line=64)
        y = 118 + 62
        for line in title:
            self.text(MARGIN, y + title_face.cap, line, title_face)
            y += title_face.line

        if lead:
            y += 6
            lead_face = hand(23, 400, INK_SOFT, line=34)
            y = self.para(MARGIN, y, lead, lead_face, lead_width)
        self.content_top = y + 46

    # ----------------------------------------------------------------- output

    def save(self, name, out_dir=None):
        height = self.fixed or int(math.ceil(self.bottom + 60))
        out = self.img.crop((0, 0, self.w * SS, height * SS))
        out = out.resize((self.w, height), Image.LANCZOS)
        out.save(os.path.join(out_dir or OUT_DIR, name), "PNG", optimize=True)
        print(f"wrote {name} ({self.w}x{height})")
