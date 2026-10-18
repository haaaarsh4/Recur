#!/usr/bin/env python3
"""The eight figures the README is built around.

Run after fetching the fonts (see generate.py):

    FONT_DIR=/tmp/recur-docs/fonts python3 docs/figures/figures.py

Each figure is one function, so a single one can be re-rendered while editing it.
Every box is sized from the text it holds and every line sits on a baseline, so a
reworded sentence grows its container instead of crowding the border.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from generate import (  # noqa: E402
    GUTTER,
    INK,
    INK_SOFT,
    MARGIN,
    MUTED,
    LINE,
    PAPER,
    PEACH_LIGHT,
    W,
    WHITE,
    Canvas,
    Face,
    caps_bold,
    hand,
    mono,
    mono_bold,
    para_height,
)

CW = W - MARGIN * 2

BODY = hand(20, 400, INK_SOFT, line=30)
SMALL = hand(17, 400, MUTED, line=25)
CARD_TITLE = hand(24, 600, INK, line=32)
CAPTION = hand(17, 400, MUTED, line=26)
LABEL = caps_bold(12, INK_SOFT, 2.2)
LABEL_LIGHT = caps_bold(12, MUTED, 2.2)
MONO = Face("mono", 16, "Regular", INK, 0, 28)


def label(s, x, top, text, face=None):
    face = face or LABEL
    s.text(x, top + face.cap, text.upper(), face)
    return top + face.line


def note(s, y, text, size=20):
    """The closing band, sized to its sentence and padded evenly."""
    face = hand(size, 500, INK, line=int(size * 1.42))
    width = CW - 56
    body_h = para_height(text, face, width)
    height = 28 * 2 + body_h
    s.rect(MARGIN, y, CW, height, fill=PEACH_LIGHT, stroke=INK, width=1.5, radius=14)
    s.para(MARGIN + 28, y + (height - body_h) / 2, text, face, width)
    return y + height


def caption(s, x, top, text, width=CW, face=None):
    face = face or CAPTION
    return s.para(x, top, text, face, width)


# ---------------------------------------------------------------------------
# 01 · Why
# ---------------------------------------------------------------------------


def figure_why():
    s = Canvas(
        "01 · why",
        ["Solve it once.", "Run it forever."],
        "A general model re-derives the same answer every time, and a derivation can drift. Recur compiles the repeated task once, then runs that program.",
    )
    top = s.y
    pad = 30
    col_w = (CW - GUTTER) // 2
    row_h, row_gap = 78, 12
    rows = [
        ("is civic a palindrome", "Yes, \u201ccivic\u201d is a palindrome."),
        ("is madam a palindrome", "Madam reads the same."),
        ("is racecar a palindrome", "Yes, \u201cracecar\u201d is a palindrome."),
    ]
    q = hand(19, 500, INK, line=26)
    a = hand(17, 400, MUTED, line=24)

    compile_body = "0.7 s, one time: search a typed dataflow for the cheapest program that reproduces the evidence you gave."
    compile_face = hand(17, 400, INK_SOFT, line=27)
    compile_text_w = col_w - pad * 2 - 52
    compile_h = 26 + 32 + 8 + para_height(compile_body, compile_face, compile_text_w) + 26
    arrow_gap = 46
    run_h = 104
    panel_h = max(
        pad * 2 + LABEL.line + 22 + len(rows) * row_h + (len(rows) - 1) * row_gap + 20 + CAPTION.line,
        pad * 2 + compile_h + arrow_gap + run_h + 18 + CAPTION.line,
    )

    for index, head in enumerate(("every time, from scratch", "compiled once, run forever")):
        x = MARGIN + index * (col_w + GUTTER)
        s.rect(x, top, col_w, panel_h, fill=WHITE, stroke=INK, width=2, radius=18)
        label(s, x + pad, top + pad, head)

    # Left: three fresh derivations.
    left_x = MARGIN + pad
    inner_w = col_w - pad * 2
    y = top + pad + LABEL.line + 22
    for question, answer in rows:
        s.rect(left_x, y, inner_w, row_h, fill=PAPER, stroke=LINE, width=1.5, radius=12)
        s.text(left_x + 18, y + 31, question, q)
        s.text(left_x + 18, y + 58, answer, a)
        timing = hand(17, 700, INK)
        s.text(left_x + inner_w - 18 - timing.width("\u2248 3.9 s"), y + 46, "\u2248 3.9 s", timing)
        y += row_h + row_gap
    s.text(left_x, top + panel_h - pad - CAPTION.ascent + 3, "three derivations, three chances to drift", CAPTION)

    # Right: one compile, then a local run.
    right_x = MARGIN + col_w + GUTTER + pad
    s.rect(right_x, top + pad, inner_w, compile_h, fill=PEACH_LIGHT, stroke=INK, width=1.5, radius=12)
    s.text(right_x + 26, top + pad + 26 + hand(24, 600).cap, "compile once", hand(24, 600))
    s.para(right_x + 26, top + pad + 26 + 32 + 8, compile_body, compile_face, compile_text_w)

    stem_y = top + pad + compile_h
    s.arrow(right_x + 40, stem_y + 4, right_x + 40, stem_y + arrow_gap - 6, width=2)
    s.text(right_x + 62, stem_y + arrow_gap / 2 + 5, "then this", hand(17, 400, MUTED))

    run_y = stem_y + arrow_gap
    s.rect(right_x, run_y, inner_w, run_h, fill=PAPER, stroke=INK, width=2, radius=12)
    s.text(right_x + 26, run_y + 30, "runs locally, on your machine", hand(21, 500))
    s.text(right_x + 26, run_y + 64, "< 1 ms  \u00b7  no model call  \u00b7  same answer every time", hand(17, 700, INK_SOFT))
    s.text(right_x, top + panel_h - pad - CAPTION.ascent + 3, "computed, not recalled", CAPTION)

    note(s, top + panel_h + 44, "Nothing is compiled, and nothing is reused, without you saying yes first.")
    s.save("01-why.png")


# ---------------------------------------------------------------------------
# 02 · How it works
# ---------------------------------------------------------------------------


def figure_pipeline():
    s = Canvas(
        "02 \u00b7 how it works",
        ["Three repeats become", "one program."],
        "Discovery is cheap, because repeating a task already did the hard part. The interesting work is deciding what the evidence licenses.",
    )
    top = s.y
    stages = [
        ("01", "profile", "Intent, domain, operation, and a 256-dimension vector of words and word pairs. Two requests match on shape."),
        ("02", "match", "0.78 similarity or better, and the program has to be able to read the request. A match is offered back to you by name."),
        ("03", "observe", "The same task seen three times, each stored with the answer the model gave. Three shows a family, not trust."),
        ("04", "compile", "Best-first search over a typed dataflow. The cheapest program that reproduces every demonstration wins."),
        ("05", "verify", "Coverage, consistency, leave-one-out, 64 generated inputs, and an acceptance head trained on the evidence."),
    ]
    gap = 28
    card_w = (CW - gap * 4) // 5
    pad = 22
    body = hand(17, 400, INK_SOFT, line=26)
    body_w = card_w - pad * 2
    body_h = max(para_height(text, body, body_w) for _, _, text in stages)
    card_h = pad + 30 + 14 + LABEL.line + 12 + body_h + pad

    centres = []
    for index, (number, title, text) in enumerate(stages):
        x = MARGIN + index * (card_w + gap)
        centres.append(x + card_w / 2)
        s.rect(x, top, card_w, card_h, fill=WHITE, stroke=INK, width=2, radius=16)
        s.rect(x + pad, top + pad, 30, 30, fill=PEACH_LIGHT, stroke=INK, width=1.5, radius=8)
        f = mono_bold(14)
        s.text(x + pad + 15 - f.width(number) / 2, top + pad + 15 + f.cap / 2, number, f)
        label(s, x + pad, top + pad + 44, title)
        s.para(x + pad, top + pad + 44 + LABEL.line + 12, text, body, body_w)
        if index:
            s.arrow(x - gap + 4, top + card_h / 2, x - 4, top + card_h / 2, width=2.2, head=8)

    flow_y = top + card_h + 42
    s.arrow(centres[0], flow_y, centres[-1], flow_y, width=1.6, head=8)
    flow_label = hand(16, 400, MUTED)
    s.text((centres[0] + centres[-1]) / 2 - flow_label.width("one pipeline, every request") / 2, flow_y + 24, "one pipeline, every request", flow_label)

    box_w, box_h = 300, 86
    box_x = W - MARGIN - box_w
    box_y = flow_y + 52
    drop_x = box_x + box_w / 2
    s.arrow(drop_x, flow_y + 8, drop_x, box_y - 7, width=1.6, head=7)
    s.rect(box_x, box_y, box_w, box_h, fill=PAPER, stroke=LINE, width=1.5, radius=12)
    s.text(box_x + 24, box_y + 32, "declines instead of guessing", hand(19, 500))
    s.text(box_x + 24, box_y + 58, "and the model answers it", hand(16, 400, MUTED))

    note(s, box_y + box_h + 44, "No match, no offer, no program: the request still gets an answer.")
    s.save("02-how-it-works.png")


# ---------------------------------------------------------------------------
# 03 · Anatomy of a program
# ---------------------------------------------------------------------------


def figure_anatomy():
    s = Canvas(
        "03 \u00b7 anatomy",
        ["A program is one read,", "some steps, one answer."],
        "What gets stored is not a prompt and not a fine-tuned model. It is a tiny typed dataflow, versioned in a registry and run by a virtual machine that opens no sockets.",
    )
    top = s.y
    boxes = [
        ("read", "exactly one", "request text \u2192 subject"),
        ("steps", "zero or more", "subject \u2192 value"),
        ("emit", "exactly one", "value + subject \u2192 answer"),
    ]
    bw = (CW - 80) // 3
    bh = 150
    for index, (name, count, types) in enumerate(boxes):
        x = MARGIN + index * (bw + 40)
        s.rect(x, top, bw, bh, fill=PEACH_LIGHT if index == 1 else WHITE, stroke=INK, width=2, radius=16)
        label(s, x + 26, top + 24, name, caps_bold(13, INK, 2.6))
        s.text(x + 26, top + 24 + 18 + 26, count, hand(18, 400, INK_SOFT))
        s.text(x + 26, top + 24 + 18 + 26 + 40, types, mono(16, "Regular", INK, 0))
        if index:
            s.arrow(x - 40 + 8, top + bh / 2, x - 8, top + bh / 2, width=2.2, head=8)

    f = hand(18, 400, MUTED)
    purity = "A program is pure: the same request always produces the same answer, with no state and no model."
    note_y = top + bh + 50
    s.text(MARGIN, note_y + f.cap, purity, f)

    ex_label_y = note_y + f.line + 42
    label(s, MARGIN, ex_label_y, "two programs this repository actually compiled")
    ex_top = ex_label_y + LABEL.line + 18

    examples = [
        (
            "text-reverser",
            "read    the word after \u201creverse\u201d\nstep    reverse it\nemit    fill in the recorded wording",
            "Four demonstrations, all four answered wrongly by the model, none reproduced exactly. It still reverses fresh words correctly, because the computation was kept and the replies were only phrasing.",
        ),
        (
            "palindrome-checker",
            "read    the word before \u201cpalindrome\u201d\nstep    checks whether it reads the same backwards\nemit    chooses between the recorded wordings",
            "One reply named a different word and one claimed a palindrome that was not one. Both are reported as model errors and set aside, and the program computes the answer instead.",
        ),
    ]
    card_w = (CW - 32) // 2
    pad = 28
    text_w = card_w - pad * 2
    card_h = pad + 32 + 14 + 3 * MONO.line + 22 + max(para_height(text, BODY, text_w) for _, _, text in examples) + pad

    for index, (name, flow, body_text) in enumerate(examples):
        x = MARGIN + index * (card_w + 32)
        s.rect(x, ex_top, card_w, card_h, fill=WHITE, stroke=INK, width=2, radius=16)
        s.text(x + pad, ex_top + pad + 22, name, CARD_TITLE)
        s.mono_block(x + pad, ex_top + pad + 46, flow, MONO, text_w)
        s.para(x + pad, ex_top + pad + 46 + 3 * MONO.line + 22, body_text, BODY, text_w)

    s.save("03-anatomy.png")


# ---------------------------------------------------------------------------
# 04 · Evidence
# ---------------------------------------------------------------------------


def figure_evidence():
    s = Canvas(
        "04 \u00b7 evidence",
        ["What the evidence licenses,", "and what it refuses."],
        "These are rules about evidence, not cases for a task family. The same rules decide for palindromes, arithmetic, counting and lookups, which is why the compiler has no list of supported tasks.",
    )
    top = s.y
    kept = [
        "Demonstrations that agree about one computation. Three repeats show a family, and every one of them is stored with the answer it received.",
        "A correct computation even when the recorded reply disagreed. A reply that contradicts a decidable answer is a model error, and it is reported as one instead of being imitated.",
        "Two phrasings of the same answer. \u201cYes, \u2018civic\u2019 is a palindrome.\u201d and \u201cCivic reads the same.\u201d teach one program with two surface forms.",
    ]
    refused = [
        "Two different answers for one input. Conflicting evidence compiles nothing, because two answers cannot both describe one computation.",
        "A reply about a different word than the request named. It stays useful as phrasing evidence and is worthless as an answer.",
        "A sentence that states a number the computation never produced. \u201cYes, 12 is the 7th number in the Fibonacci series.\u201d asserts a position nothing derived.",
    ]
    col_w = (CW - GUTTER) // 2
    pad = 28
    bullet = 30
    text_w = col_w - pad * 2 - bullet
    gap = 28
    def stack(items):
        return sum(para_height(text, BODY, text_w) for text in items) + gap * (len(items) - 1)

    panel_h = pad * 2 + LABEL.line + 24 + max(stack(kept), stack(refused))

    for index, (title, items, kind) in enumerate(
        (("kept as evidence", kept, "tick"), ("refused, and said so", refused, "cross"))
    ):
        x = MARGIN + index * (col_w + GUTTER)
        s.rect(x, top, col_w, panel_h, fill=WHITE, stroke=INK, width=2, radius=16)
        label(s, x + pad, top + pad, title)
        y = top + pad + LABEL.line + 24
        for index, text in enumerate(items):
            if kind == "tick":
                s.tick(x + pad + 1, y + 3, 1.0)
            else:
                s.cross(x + pad + 2, y + 5, 0.9)
            s.para(x + pad + bullet, y, text, BODY, text_w)
            y += para_height(text, BODY, text_w) + (gap if index < len(items) - 1 else 0)

    note(s, top + panel_h + 44, "When nothing generalises, the fallback is a verified lookup that answers what it observed and declines everything else.")
    s.save("04-evidence.png")


# ---------------------------------------------------------------------------
# 05 · What to expect
# ---------------------------------------------------------------------------


def figure_contract():
    s = Canvas(
        "05 \u00b7 what to expect",
        ["It asks first.", "It shows its source."],
        "Three promises the product keeps, whatever it has compiled.",
    )
    top = s.y
    head = hand(26, 600, INK)
    demo_w = 640
    demo_x = MARGIN + 52
    side_x = demo_x + demo_w + 44
    side_w = W - MARGIN - side_x

    def section(y, number, title, body_text):
        s.badge(MARGIN, y, number)
        s.text(MARGIN + 52, y + 17 + head.cap / 2, title, head)
        s.para(MARGIN + 52, y + 56, body_text, SMALL, 560)

    # 1
    y1 = top
    section(y1, "1", "It offers. You approve.", "A program never answers on its own.")
    box_y = y1 + 104
    s.rect(demo_x, box_y, demo_w, 150, fill=WHITE, stroke=INK, width=2, radius=16)
    s.text(demo_x + 26, box_y + 40, "A compiled program already covers this: palindrome-checker.", hand(19, 500))
    s.text(demo_x + 26, box_y + 70, "Run it, or answer from scratch?", hand(17, 400, MUTED))
    s.chip(demo_x + 26, box_y + 96, "run it", hand(17, 500, INK), pad_x=18, height=34)
    s.chip(demo_x + 132, box_y + 96, "skip", hand(17, 400, INK_SOFT), fill=WHITE, stroke=LINE, pad_x=18, height=34)
    s.para(side_x, box_y + 10, "Typing \u201cyes\u201d works too. The offer names the program, its score and its recorded task.", SMALL, side_w)

    # 2
    y2 = box_y + 150 + 52
    section(y2, "2", "It shows where the answer came from.", "Every reply is labelled.")
    box_y2 = y2 + 104
    s.rect(demo_x, box_y2, demo_w, 132, fill=WHITE, stroke=INK, width=2, radius=16)
    s.text(demo_x + 26, box_y2 + 42, "No, \u201cabcd\u201d is not a palindrome.", hand(20, 500))
    s.text(demo_x + 26, box_y2 + 78, "compiled program: palindrome-checker", hand(16, 500, INK_SOFT))
    s.text(demo_x + 26, box_y2 + 102, "< 1 ms  \u00b7  no model call", hand(16, 400, MUTED))
    s.para(side_x, box_y2 + 10, "The label is the same one the registry shows, and it is generated from the program rather than written by hand.", SMALL, side_w)

    # 3
    y3 = box_y2 + 132 + 52
    section(y3, "3", "Nothing is overwritten.", "A better program supersedes, it does not erase.")
    box_y3 = y3 + 104
    old_w, gap = 260, 44
    s.rect(demo_x, box_y3, old_w, 112, fill=PAPER, stroke=LINE, width=1.5, radius=12)
    label(s, demo_x + 22, box_y3 + 20, "replaced", LABEL_LIGHT)
    s.text(demo_x + 22, box_y3 + 66, "the earlier program", hand(18, 500, MUTED))
    s.line([(demo_x + 22, box_y3 + 76), (demo_x + old_w - 22, box_y3 + 76)], MUTED, 1.5)
    s.arrow(demo_x + old_w + 6, box_y3 + 56, demo_x + old_w + gap - 6, box_y3 + 56, width=2)
    s.rect(demo_x + old_w + gap, box_y3, old_w, 112, fill=PEACH_LIGHT, stroke=INK, width=2, radius=12)
    label(s, demo_x + old_w + gap + 22, box_y3 + 20, "current")
    s.text(demo_x + old_w + gap + 22, box_y3 + 66, "palindrome-checker", hand(18, 700, INK))
    s.para(side_x, box_y3 + 8, "History stays in the registry, marked and never matched again. Descriptions are generated from the stored program, so they cannot outlive it.", SMALL, side_w)

    s.save("05-what-to-expect.png")


# ---------------------------------------------------------------------------
# 06 · System
# ---------------------------------------------------------------------------


def figure_system():
    s = Canvas(
        "06 \u00b7 system",
        ["One process,", "no hidden service."],
        "The browser talks to one Express app, storage is a JSON file, and compiled programs run inside that same process. A reused answer needs no model, no network and no second service.",
    )
    top = s.y
    browser_w = 250
    api_w = 320
    gap = 110
    parts_x = MARGIN + browser_w + gap + api_w + gap
    parts_w = W - MARGIN - parts_x
    api_x = MARGIN + browser_w + gap

    parts = [
        ("program.js", "compiler and VM: search, verify, execute"),
        ("neural.js", "acceptance head: 12 units, trained at compile"),
        ("embeddings.js", "task profiler: intent, domain, 256-dim"),
    ]
    part_h, part_gap = 76, 9
    body_h = len(parts) * part_h + (len(parts) - 1) * part_gap

    s.rect(MARGIN, top, browser_w, body_h, fill=WHITE, stroke=INK, width=2, radius=16)
    label(s, MARGIN + 24, top + 24, "browser", caps_bold(13, INK, 2.6))
    s.para(MARGIN + 24, top + 62, "React and Vite: chat, offer cards, the tool registry, and the integrations page.", hand(17, 400, INK_SOFT, line=26), browser_w - 48)
    s.text(MARGIN + 24, top + body_h - 26 + hand(15, 400).cap, "renders what it is told", hand(15, 400, MUTED))

    s.rect(api_x, top, api_w, body_h, fill=PEACH_LIGHT, stroke=INK, width=2, radius=16)
    label(s, api_x + 24, top + 24, "express api", caps_bold(13, INK, 2.6))
    s.mono_block(api_x + 24, top + 62, "routes/chats\nengine.js pipeline\nroutes/tools\nroutes/stats", mono(15, "Regular", INK, 0, 27), api_w - 48)

    for index, (name, role) in enumerate(parts):
        y = top + index * (part_h + part_gap)
        s.rect(parts_x, y, parts_w, part_h, fill=WHITE, stroke=INK, width=2, radius=12)
        s.text(parts_x + 22, y + 32, name, mono_bold(16))
        s.text(parts_x + 22, y + 58, role, hand(16, 400, INK_SOFT))

    mid_y = top + body_h / 2
    s.arrow(MARGIN + browser_w + 8, mid_y - 12, api_x - 10, mid_y - 12, width=2, head=7)
    s.arrow(api_x - 10, mid_y + 20, MARGIN + browser_w + 8, mid_y + 20, width=1.6, head=7)
    mid_label = hand(15, 400, MUTED)
    s.text((MARGIN + browser_w + api_x) / 2 - mid_label.width("HTTP /api") / 2, mid_y - 24, "HTTP /api", mid_label)
    s.text((MARGIN + browser_w + api_x) / 2 - mid_label.width("JSON") / 2, mid_y + 44, "JSON", mid_label)

    for index in range(len(parts)):
        cy = top + index * (part_h + part_gap) + part_h / 2
        s.arrow(api_x + api_w + 8, cy, parts_x - 8, cy, width=1.6, head=7)

    lower = top + body_h + 56
    lower_h = 112
    store_w = 596
    s.rect(MARGIN, lower, store_w, lower_h, fill=WHITE, stroke=INK, width=2, radius=16)
    label(s, MARGIN + 24, lower + 22, "storage", caps_bold(13, INK, 2.6))
    s.text(MARGIN + 24, lower + 66, "one JSON file: programs, evidence, chats, the log", hand(18, 500))
    s.text(MARGIN + 24, lower + 92, "a writable directory is chosen at boot", hand(16, 400, MUTED))

    model_x = MARGIN + store_w + 40
    s.rect(model_x, lower, W - MARGIN - model_x, lower_h, fill=PAPER, stroke=LINE, width=1.5, radius=16)
    label(s, model_x + 24, lower + 22, "model, for general answers only", LABEL_LIGHT)
    s.text(model_x + 24, lower + 66, "Ollama on your machine, or a provider key you add", hand(18, 400, INK_SOFT))
    s.text(model_x + 24, lower + 92, "never reached from inside a compiled program", hand(16, 400, MUTED))

    note(s, lower + lower_h + 44, "Compiled programs are the reason the model is optional: reuse is a function call inside this process.")
    s.save("06-system.png")


# ---------------------------------------------------------------------------
# 07 · What it teaches
# ---------------------------------------------------------------------------


def figure_lessons():
    s = Canvas(
        "07 \u00b7 what it teaches",
        ["What a pipeline like this", "actually teaches."],
        "Four findings that generalise past this codebase, and one that tempers them.",
    )
    top = s.y
    lessons = [
        ("Repetition is free supervision", "Nobody labels anything. A user who asks the same task three times has already shown where the task family is, and every repetition arrives with an answer attached."),
        ("Verification is the product", "Generation is cheap now; deciding what is true is not. Search plus hard evidence rules produced correct programs for cases the model itself had answered wrongly."),
        ("Separate wording from computation", "A reply is evidence about phrasing, never about arithmetic. Treat a sentence as the answer and a rule will eventually assert a number that nothing derived."),
        ("Measure generalisation, don't assume it", "Reproducing the demonstrations says almost nothing. Leave-one-out, generated in-domain inputs and honest decline counts are what show whether a program can be trusted."),
    ]
    card_w = (CW - 32) // 2
    pad = 28
    text_w = card_w - pad * 2
    body_h = max(para_height(text, BODY, text_w) for _, text in lessons)
    card_h = pad + 32 + 16 + body_h + pad

    for index, (title, text) in enumerate(lessons):
        x = MARGIN + (index % 2) * (card_w + 32)
        y = top + (index // 2) * (card_h + 32)
        s.rect(x, y, card_w, card_h, fill=WHITE, stroke=INK, width=2, radius=16)
        s.text(x + pad, y + pad + 18, f"{index + 1:02d}", mono_bold(15, MUTED))
        s.text(x + pad + 34, y + pad + 20, title, hand(21, 600))
        s.para(x + pad, y + pad + 58, text, BODY, text_w)

    note(
        s,
        top + 2 * card_h + 32 + 44,
        "The tempering one: a tiny local model is a good source of phrasing and a poor oracle. That difference is the whole design.",
    )
    s.save("07-what-it-teaches.png")


# ---------------------------------------------------------------------------
# 08 · The compiler
# ---------------------------------------------------------------------------


def figure_compiler():
    s = Canvas(
        "08 \u00b7 the compiler",
        ["Compile by search,", "not by prompting."],
        "The recorded answers are targets, never instructions. Candidate programs are enumerated from the words in the requests, executed against every demonstration, and priced.",
    )
    top = s.y
    label(s, MARGIN, top, "three of the candidates the search considered, in the order it ranks them")

    rows = [
        ("read   the word after \u201creverse\u201d\nstep   reverse it\nemit   fill in the recorded wording", "explains all 4", "cost 6", "wins", True),
        ("read   the word after \u201creverse\u201d\nstep   nothing\nemit   look the answer up in a table", "explains all 4", "cost 34", "priced out", False),
        ("read   the whole request\nstep   nothing\nemit   repeat one recorded sentence", "explains none", "cost 2", "discarded", False),
    ]
    prog_w = 900
    row_h, row_gap = 122, 18
    y = top + 34
    for body, verdict, cost, comment, wins in rows:
        s.rect(MARGIN, y, prog_w, row_h, fill=PEACH_LIGHT if wins else WHITE, stroke=INK, width=2 if wins else 1.5, radius=14)
        s.mono_block(MARGIN + 26, y + 22, body, mono(15, "Regular", INK, 0, 27), prog_w - 52)
        vx = MARGIN + prog_w + 40
        if wins:
            s.tick(vx, y + 30, 1.1)
        else:
            s.cross(vx, y + 24, 0.9)
        s.text(vx + 30, y + 38, verdict, hand(19, 500, INK if wins else MUTED))
        s.text(vx + 30, y + 64, cost, mono_bold(14, INK_SOFT))
        s.text(vx + 30, y + 94, comment, hand(17, 700 if wins else 500, INK if wins else MUTED))
        y += row_h + row_gap

    cap_y = y + 4
    cap_text = "A lookup has to beat a genuine computation on price, and usually cannot. 12,000 candidates are enumerated by default, and there is no sampling anywhere in the path."
    cap_bottom = s.para(MARGIN, cap_y, cap_text, CAPTION, CW)

    rules = [
        "It explains every demonstration exactly, either reproduced or recognised as a variant of the same answer.",
        "It derives every number it states, from the request, the subject it read, or the value it computed.",
        "It declines inputs it cannot read instead of answering them with a lucky branch.",
    ]
    gate_y = cap_bottom + 44
    pad = 28
    bullet = 32
    rule_w = CW - pad * 2 - bullet
    gate_h = pad * 2 + LABEL.line + 26 + sum(para_height(rule, BODY, rule_w) for rule in rules) + 26 * (len(rules) - 1)
    s.rect(MARGIN, gate_y, CW, gate_h, fill=WHITE, stroke=INK, width=2, radius=16)
    label(s, MARGIN + pad, gate_y + pad, "before a candidate is priced, it has to survive three rules")
    ry = gate_y + pad + LABEL.line + 26
    for index, rule in enumerate(rules):
        s.tick(MARGIN + pad + 1, ry + 3, 1.0)
        s.para(MARGIN + pad + bullet, ry, rule, BODY, rule_w)
        ry += para_height(rule, BODY, rule_w) + (26 if index < len(rules) - 1 else 0)

    note(s, gate_y + gate_h + 44, "Nothing a model wrote is executed: the search produces the program, and the evidence decides whether it is stored.")
    s.save("08-the-compiler.png")


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
FIGURES = {
    "01-why.png": figure_why,
    "02-how-it-works.png": figure_pipeline,
    "03-anatomy.png": figure_anatomy,
    "04-evidence.png": figure_evidence,
    "05-what-to-expect.png": figure_contract,
    "06-system.png": figure_system,
    "07-what-it-teaches.png": figure_lessons,
    "08-the-compiler.png": figure_compiler,
}


def main():
    wanted = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    for name, builder in FIGURES.items():
        if wanted and name not in wanted:
            continue
        builder()


if __name__ == "__main__":
    main()
