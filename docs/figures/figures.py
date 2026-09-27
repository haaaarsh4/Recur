#!/usr/bin/env python3
"""The seven figures the README is built around.

Run after fetching the fonts (see generate.py):

    FONT_DIR=/tmp/recur-docs/fonts python3 docs/figures/figures.py

Layout is flow based: every box is sized from the text it holds, so rewording a
paragraph grows its box instead of spilling out of it. Each figure is one
function so a single one can be re-rendered while editing it.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from generate import (  # noqa: E402
    GREEN,
    INK,
    INK_SOFT,
    MUTED,
    PAPER,
    PEACH,
    PEACH_LIGHT,
    WHITE,
    Sketch,
    block_height,
    hand,
    mono,
)

W = 1600


def para(s, x, y, text, size=22, weight=400, width=520, fill=INK_SOFT, gap=7):
    return s.sentence(x, y, text, size, weight, width, "la", fill, gap)


def badge(s, x, y, label, size=34, fill=PEACH_LIGHT):
    s.d.ellipse([x, y, x + size, y + size], outline=INK, width=2, fill=fill)
    s.text(x + size / 2, y + size / 2 + 1, label, hand(20, 800), INK, anchor="mm")


def tick(s, x, y, scale=1.0):
    s.d.line([(x, y), (x + 9 * scale, y + 10 * scale), (x + 24 * scale, y - 12 * scale)], fill=GREEN, width=4, joint="curve")


def cross(s, x, y, scale=1.0):
    s.d.line([(x, y), (x + 18 * scale, y + 18 * scale)], fill=INK_SOFT, width=3)
    s.d.line([(x, y + 18 * scale), (x + 18 * scale, y)], fill=INK_SOFT, width=3)


def mark(s, x, y, kind="dot", size=23, fill=INK_SOFT):
    if kind == "dot":
        s.d.ellipse([x - 17, y + size * 0.5, x - 6, y + size * 0.5 + 11], fill=fill)
    elif kind == "tick":
        tick(s, x - 22, y + 10, 0.9)
    else:
        cross(s, x - 24, y + 4, 0.8)


def note(s, y, text, size=25):
    """The closing note band, sized to its sentence."""
    width = s.w - s.margin * 2 - 52
    height = max(76, block_height(text, size, 500, width) + 42)
    s.band(s.margin, y, s.w - s.margin * 2, height, text, size=size)
    return y + height


def caption(s, x, y, text, size=21, width=1200):
    return s.sentence(x, y, text, size, 400, width, "la", MUTED)


# ---------------------------------------------------------------------------
# 01 · Why
# ---------------------------------------------------------------------------


def figure_why():
    s = Sketch(
        W,
        1400,
        "01 · why",
        ["Solve it once.", "Run it forever."],
        "A general model re-derives the same answer every time, and a derivation can drift. Recur compiles the repeated task once, then runs that program.",
        seed=11,
    )
    top = s.content_top
    rows = [
        ("is civic a palindrome", "Yes, \u201ccivic\u201d is a palindrome."),
        ("is madam a palindrome", "Madam reads the same."),
        ("is racecar a palindrome", "Yes, \u201cracecar\u201d is a palindrome."),
    ]
    row_h, row_gap = 92, 16
    left_h = 66 + len(rows) * row_h + (len(rows) - 1) * row_gap + 58
    note_body = "search a typed dataflow for the cheapest program that reproduces the evidence you gave"
    compile_h = 50 + block_height(note_body, 20, 400, 594) + 26
    right_h = 66 + compile_h + 66 + 108 + 50
    panel_h = max(left_h, right_h)

    left = s.panel(s.margin, top, 690, panel_h)
    right = s.panel(826, top, 690, panel_h)
    s.caps(left[0] + 28, top + 26, "every time, from scratch", size=17)
    s.caps(right[0] + 28, top + 26, "compiled once, run forever", size=17)

    y = top + 66
    for question, answer in rows:
        s.round_box(left[0] + 28, y, 634, row_h, radius=12, fill=PAPER, outline=INK_SOFT, width=2, jitter=0.8)
        s.text(left[0] + 46, y + 20, question, hand(21, 500), INK)
        s.text(left[0] + 46, y + 52, answer, hand(20, 400), MUTED)
        s.text(left[0] + 646, y + 46, "\u2248 3.9 s", hand(22, 700), INK, anchor="rm")
        y += row_h + row_gap
    caption(s, left[0] + 28, y + 6, "three derivations, three chances to drift", 22)

    s.round_box(right[0] + 28, top + 66, 634, compile_h, radius=12, fill=PEACH_LIGHT, outline=INK, width=3)
    s.text(right[0] + 46, top + 84, "compile once", hand(26, 700), INK)
    para(s, right[0] + 46, top + 126, f"\u2248 0.7 s, one time: {note_body}.", 20, 400, 594)

    s.arrow(right[0] + 345, top + 66 + compile_h + 12, right[0] + 345, top + 66 + compile_h + 60, width=3)
    s.text(right[0] + 372, top + 66 + compile_h + 36, "then this", hand(20, 400), MUTED, anchor="lm")

    run_y = top + 66 + compile_h + 66
    s.round_box(right[0] + 28, run_y, 634, 108, radius=12, fill=PAPER, outline=INK, width=3)
    s.text(right[0] + 46, run_y + 18, "runs locally, on your machine", hand(23, 500), INK)
    s.text(right[0] + 46, run_y + 58, "< 1 ms  ·  no model call  ·  same answer every time", hand(21, 700), INK)
    caption(s, right[0] + 28, run_y + 118, "computed, not recalled", 22)

    note(s, top + panel_h + 44, "Nothing is compiled, and nothing is reused, without you saying yes first.")
    s.save("01-why.png")


# ---------------------------------------------------------------------------
# 02 · How it works
# ---------------------------------------------------------------------------


def figure_pipeline():
    s = Sketch(
        W,
        1300,
        "02 · how it works",
        ["Three repeats become", "one program."],
        "Discovery is cheap, because repeating a task already did the hard part. The interesting work is deciding what the evidence licenses.",
        seed=23,
    )
    top = s.content_top
    stages = [
        ("01", "profile", "Intent, domain, operation, and a 256-dimension vector of words and word pairs. Two requests match on shape, not just on wording."),
        ("02", "match", "0.78 similarity or better against a stored program, and the program has to be able to read this request. A match is offered back to you by name."),
        ("03", "observe", "The same task seen three times, each stored with the answer the model actually gave. Three shows a family; it does not yet earn trust."),
        ("04", "compile", "Best-first search over a typed dataflow IR with a simplicity prior. The cheapest program that reproduces every demonstration exactly wins."),
        ("05", "verify", "Exact and variant coverage, consistency, leave-one-out, 64 generated inputs, and an acceptance head trained on the same evidence."),
    ]
    card_w, gap = 258, 34
    body_w = card_w - 40
    card_h = 86 + max(block_height(body, 20, 400, body_w) for _, _, body in stages) + 26
    x = s.margin + 3
    centres = []
    for index, (number, title, body) in enumerate(stages):
        cx = x + index * (card_w + gap)
        centres.append(cx + card_w / 2)
        s.round_box(cx, top, card_w, card_h, radius=18, fill=WHITE, outline=INK, width=3)
        s.d.rectangle([cx + 20, top + 20, cx + 62, top + 56], outline=INK, width=2, fill=PEACH_LIGHT)
        s.text(cx + 41, top + 38, number, mono(20, "Bold"), INK, anchor="mm")
        s.caps(cx + 20, top + 72, title, size=19)
        para(s, cx + 20, top + 106, body, 20, 400, body_w)
        if index:
            s.arrow(cx - gap + 6, top + card_h / 2, cx - 6, top + card_h / 2, width=3)

    flow_y = top + card_h + 44
    s.arrow(centres[0], flow_y, centres[4], flow_y, width=2, colour=INK_SOFT)
    s.text(centres[2], flow_y + 14, "one pipeline, every request", hand(20, 400), MUTED, anchor="mm")

    decline_y = flow_y + 54
    box_w = 330
    # Under the last stage, but never past the page margin: the drop line moves
    # with the box so the two stay a single gesture.
    drop_x = min(centres[4], s.w - s.margin - box_w / 2)
    s.arrow(drop_x, flow_y + 26, drop_x, decline_y - 8, width=2, colour=INK_SOFT)
    s.round_box(drop_x - box_w / 2, decline_y, box_w, 92, radius=14, fill=PAPER, outline=INK_SOFT, width=2)
    s.text(drop_x, decline_y + 22, "declines instead of guessing", hand(21, 500), INK_SOFT, anchor="mm")
    s.text(drop_x, decline_y + 54, "and the model answers it", hand(19, 400), MUTED, anchor="mm")

    note(s, decline_y + 132, "No match, no offer, no program: the request still gets an answer.")
    s.save("02-how-it-works.png")


# ---------------------------------------------------------------------------
# 03 · Anatomy of a program
# ---------------------------------------------------------------------------


def figure_anatomy():
    s = Sketch(
        W,
        1500,
        "03 · anatomy",
        ["A program is one read,", "some steps, one answer."],
        "What gets stored is not a prompt and not a fine-tuned model. It is a tiny typed dataflow, versioned in a registry and run by a virtual machine that opens no sockets.",
        seed=37,
    )
    top = s.content_top
    boxes = [
        ("read", "exactly one", "request text \u2192 subject"),
        ("steps", "zero or more", "subject \u2192 value"),
        ("emit", "exactly one", "value + subject \u2192 answer"),
    ]
    bw, gap, bh = 420, 90, 168
    for index, (name, count, types) in enumerate(boxes):
        bx = s.margin + index * (bw + gap)
        s.round_box(bx, top, bw, bh, radius=18, fill=PEACH_LIGHT if index == 1 else WHITE, outline=INK, width=3)
        s.caps(bx + 26, top + 26, name, size=22, tracking=3)
        s.text(bx + 26, top + 66, count, hand(21, 400), MUTED)
        s.text(bx + 26, top + 108, types, mono(20), INK)
        if index:
            s.arrow(bx - gap + 8, top + bh / 2, bx - 8, top + bh / 2, width=3)
    s.text(W / 2, top + bh + 26, "a program is pure: the same request always produces the same answer, with no state and no model", hand(21, 400), MUTED, anchor="mm")

    ex_top = top + bh + 96
    s.caps(s.margin, ex_top, "two programs this repository actually compiled", size=19)
    examples = [
        (
            "text-reverser",
            "read: the word after \u201creverse\u201d\nstep: reverses it\nemit: fills in the recorded wording",
            "Four demonstrations, all four answered wrongly by the model, none reproduced exactly. It still reverses fresh words correctly, because the computation was kept and the replies were only phrasing.",
        ),
        (
            "palindrome-checker",
            "read: the word before \u201cpalindrome\u201d\nstep: checks whether it reads the same way backwards\nemit: chooses between the recorded wordings",
            "One reply named a different word and one claimed a palindrome that was not one. Both are reported as model errors and set aside, and the program computes the answer instead.",
        ),
    ]
    card_w = (W - s.margin * 2 - 30) / 2
    example_h = 108 + 3 * 28 + 22 + max(block_height(note_text, 20, 400, card_w - 52) for _, _, note_text in examples) + 32
    for index, (name, flow, note_text) in enumerate(examples):
        cx = s.margin + index * (card_w + 30)
        s.round_box(cx, ex_top + 40, card_w, example_h, radius=16, fill=WHITE, outline=INK, width=3)
        s.text(cx + 26, ex_top + 62, name, hand(26, 700), INK)
        s.mono_block(cx + 26, ex_top + 106, flow, size=20, max_width=card_w - 52)
        para(s, cx + 26, ex_top + 108 + 3 * 28 + 22, note_text, 20, 400, card_w - 52)
    s.save("03-anatomy.png")


# ---------------------------------------------------------------------------
# 04 · Evidence
# ---------------------------------------------------------------------------


def figure_evidence():
    s = Sketch(
        W,
        1300,
        "04 · evidence",
        ["What the evidence", "licenses, and what it refuses."],
        "These are rules about evidence, not cases for a task family. The same rules decide for palindromes, arithmetic, counting and lookups, which is why the compiler has no list of supported tasks.",
        seed=41,
    )
    top = s.content_top
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
    col_w = (W - s.margin * 2 - 40) / 2
    text_w = col_w - 104
    col_h = 74 + sum(block_height(text, 23, 400, text_w) + 30 for text in kept)
    refused_h = 74 + sum(block_height(text, 23, 400, text_w) + 30 for text in refused)
    col_h = max(col_h, refused_h)

    for index, (title, items, marker_kind) in enumerate((("kept as evidence", kept, "tick"), ("refused, and said so", refused, "cross"))):
        cx = s.margin + index * (col_w + 40)
        s.round_box(cx, top, col_w, col_h, radius=18, fill=WHITE, outline=INK, width=3)
        s.caps(cx + 26, top + 24, title, size=19)
        y = top + 72
        for text in items:
            mark(s, cx + 30, y + 4, marker_kind, 23)
            para(s, cx + 66, y, text, 23, 400, text_w)
            y += block_height(text, 23, 400, text_w) + 30

    note(s, top + col_h + 44, "When nothing generalises, the fallback is a verified lookup that answers what it observed and declines everything else.")
    s.save("04-evidence.png")


# ---------------------------------------------------------------------------
# 05 · What to expect
# ---------------------------------------------------------------------------


def figure_contract():
    s = Sketch(
        W,
        1400,
        "05 · what to expect",
        ["It asks first.", "It shows its source."],
        "Three promises the product keeps, whatever it has compiled.",
        seed=53,
    )
    top = s.content_top

    badge(s, s.margin, top, "1", size=40)
    s.text(s.margin + 60, top + 16, "It offers. You approve.", hand(30, 700), INK)
    box_y = top + 72
    s.round_box(s.margin + 60, box_y, 820, 104, radius=14, fill=WHITE, outline=INK, width=3)
    s.text(s.margin + 86, box_y + 22, "A compiled program already covers this: palindrome-checker.", hand(23, 500), INK)
    s.text(s.margin + 86, box_y + 60, "Run it, or answer from scratch?", hand(21, 400), MUTED)
    tick(s, s.margin + 916, box_y + 40, 1.2)
    s.text(s.margin + 958, box_y + 44, "run it", hand(23, 500), INK, anchor="lm")
    cross(s, s.margin + 1092, box_y + 34, 1.1)
    s.text(s.margin + 1132, box_y + 44, "skip", hand(23, 500), INK, anchor="lm")
    caption(s, s.margin + 60, box_y + 120, "Typing \u201cyes\u201d works too. A program never answers on its own.", 20)

    top2 = box_y + 190
    badge(s, s.margin, top2, "2", size=40)
    s.text(s.margin + 60, top2 + 16, "It shows where the answer came from.", hand(30, 700), INK)
    box_y2 = top2 + 72
    s.round_box(s.margin + 60, box_y2, 820, 104, radius=14, fill=WHITE, outline=INK, width=3)
    s.text(s.margin + 86, box_y2 + 22, "No, \u201cabcd\u201d is not a palindrome.", hand(24, 500), INK)
    s.text(s.margin + 86, box_y2 + 62, "compiled program: palindrome-checker \u00b7 < 1 ms \u00b7 no model call", hand(20, 400), MUTED)
    s.round_box(s.margin + 910, box_y2, 520, 104, radius=14, fill=PEACH_LIGHT, outline=INK, width=3)
    s.text(s.margin + 934, box_y2 + 22, "every reply is labelled", hand(21, 500), INK)
    s.text(s.margin + 934, box_y2 + 60, "with the program that produced it", hand(20, 400), INK_SOFT)

    top3 = box_y2 + 190
    badge(s, s.margin, top3, "3", size=40)
    s.text(s.margin + 60, top3 + 16, "Nothing is overwritten.", hand(30, 700), INK)
    box_y3 = top3 + 76
    s.round_box(s.margin + 60, box_y3, 420, 132, radius=14, fill=PAPER, outline=INK_SOFT, width=2)
    s.caps(s.margin + 84, box_y3 + 20, "replaced", size=18, fill=MUTED)
    s.text(s.margin + 84, box_y3 + 58, "the earlier program", hand(23, 500), MUTED)
    s.d.line([(s.margin + 84, box_y3 + 68), (s.margin + 400, box_y3 + 68)], fill=MUTED, width=3)
    s.arrow(s.margin + 500, box_y3 + 66, s.margin + 600, box_y3 + 66, width=3)
    s.round_box(s.margin + 620, box_y3, 420, 132, radius=14, fill=PEACH_LIGHT, outline=INK, width=3)
    s.caps(s.margin + 644, box_y3 + 20, "current", size=18)
    s.text(s.margin + 644, box_y3 + 58, "palindrome-checker", hand(23, 700), INK)
    s.text(s.margin + 644, box_y3 + 92, "kept as history, never matched", hand(20, 400), INK_SOFT)
    s.text(s.margin + 1080, box_y3 + 22, "A description in the registry", hand(21, 500), INK)
    para(s, s.margin + 1080, box_y3 + 60, "is generated from the stored program itself, so it cannot describe something the program does not do.", 20, 400, s.w - s.margin - (s.margin + 1080))
    s.save("05-what-to-expect.png")


# ---------------------------------------------------------------------------
# 06 · System
# ---------------------------------------------------------------------------


def figure_system():
    s = Sketch(
        W,
        1400,
        "06 · system",
        ["One process,", "no hidden service."],
        "The browser talks to one Express app, storage is a JSON file, and compiled programs run inside that same process. A reused answer needs no model, no network and no second service.",
        seed=67,
    )
    top = s.content_top
    parts = [
        ("program.js", "compiler and VM \u00b7 search, verify, execute"),
        ("neural.js", "acceptance head \u00b7 12 units, trained at compile"),
        ("embeddings.js", "task profiler \u00b7 intent, domain, 256-dim"),
    ]
    part_h, part_gap = 84, 10
    api_h = len(parts) * part_h + (len(parts) - 1) * part_gap
    api_x, api_w = 566, 400
    px, px_w = 1050, 466

    browser = s.round_box(s.margin, top, 300, api_h, radius=18, fill=WHITE, outline=INK, width=3)
    s.caps(s.margin + 24, top + 24, "browser", size=20)
    para(s, s.margin + 24, top + 64, "React and Vite: chat, offer cards, the tool registry, and the integrations page.", 20, 400, 250)
    caption(s, s.margin + 24, top + api_h - 46, "renders what it is told", 20)

    s.round_box(api_x, top, api_w, api_h, radius=18, fill=PEACH_LIGHT, outline=INK, width=3)
    s.caps(api_x + 24, top + 24, "express api", size=20)
    s.mono_block(api_x + 24, top + 66, "routes/chats\nengine.js pipeline\nroutes/tools\nroutes/stats", size=20, max_width=340)

    s.arrow(s.margin + 318, top + 56, api_x - 16, top + 56, width=3)
    s.text((s.margin + 318 + api_x) / 2, top + 30, "HTTP /api", hand(20, 400), MUTED, anchor="mm")
    s.arrow(api_x - 16, top + 96, s.margin + 318, top + 96, width=2, colour=INK_SOFT)
    s.text((s.margin + 318 + api_x) / 2, top + 122, "JSON", hand(20, 400), MUTED, anchor="mm")

    for index, (name, role) in enumerate(parts):
        py = top + index * (part_h + part_gap)
        s.round_box(px, py, px_w, part_h, radius=14, fill=WHITE, outline=INK, width=3)
        s.text(px + 22, py + 16, name, mono(20, "Bold"), INK)
        s.text(px + 22, py + 48, role, hand(20, 400), INK_SOFT)
        s.arrow(api_x + api_w + 6, top + api_h / 2, px - 12, py + part_h / 2, width=2, colour=INK_SOFT)

    lower = top + api_h + 60
    lower_h = 132
    s.round_box(s.margin, lower, 660, lower_h, radius=16, fill=WHITE, outline=INK, width=3)
    s.caps(s.margin + 24, lower + 22, "storage", size=19)
    s.text(s.margin + 24, lower + 58, "one JSON file: programs, evidence, chats, the log", hand(21, 500), INK)
    caption(s, s.margin + 24, lower + 96, "a writable directory is chosen at boot", 20)
    s.arrow(s.margin + 330, lower - 8, s.margin + 330, top + api_h + 8, width=2, colour=INK_SOFT, both=True)

    s.round_box(776, lower, 740, lower_h, radius=16, fill=PAPER, outline=INK_SOFT, width=2)
    s.caps(800, lower + 22, "model, for general answers only", size=19, fill=INK_SOFT)
    s.text(800, lower + 58, "Ollama on your machine, or a provider key you add", hand(21, 400), INK_SOFT)
    caption(s, 800, lower + 96, "reached only when no program matches, and never from a program", 20)

    note(s, lower + lower_h + 44, "Compiled programs are the reason the model is optional: reuse is a function call inside this process.")
    s.save("06-system.png")


# ---------------------------------------------------------------------------
# 07 · What it teaches
# ---------------------------------------------------------------------------


def figure_lessons():
    s = Sketch(
        W,
        1500,
        "07 · what it teaches",
        ["What a pipeline like this", "actually teaches."],
        "Four findings that generalise past this codebase, and one that tempers them.",
        seed=79,
    )
    top = s.content_top
    lessons = [
        (
            "Repetition is free supervision",
            "Nobody labels anything. A user who asks the same task three times has already shown where the task family is, and every repetition arrives with an answer attached.",
        ),
        (
            "Verification is the product",
            "Generation is cheap now; deciding what is true is not. Search plus hard evidence rules produced correct programs for cases the model itself had answered wrongly.",
        ),
        (
            "Separate wording from computation",
            "A reply is evidence about phrasing, never about arithmetic. Treat a sentence as the answer and a rule will eventually assert a number that nothing derived.",
        ),
        (
            "Measure generalisation, don't assume it",
            "Reproducing the demonstrations says almost nothing. Leave-one-out, generated in-domain inputs and honest decline counts are what show whether a program can be trusted.",
        ),
    ]
    card_w = (W - s.margin * 2 - 34) / 2
    card_h = 92 + max(block_height(body, 22, 400, card_w - 52) for _, body in lessons) + 34
    for index, (title, body) in enumerate(lessons):
        cx = s.margin + (index % 2) * (card_w + 34)
        cy = top + (index // 2) * (card_h + 34)
        s.round_box(cx, cy, card_w, card_h, radius=18, fill=WHITE, outline=INK, width=3)
        s.text(cx + 26, cy + 22, f"{index + 1:02d}", mono(22, "Bold"), INK_SOFT)
        s.text(cx + 68, cy + 16, title, hand(28, 700), INK)
        para(s, cx + 26, cy + 80, body, 22, 400, card_w - 52)

    note(
        s,
        top + 2 * card_h + 34 + 44,
        "The tempering one: a tiny local model is a good source of phrasing and a poor oracle. That difference is the whole design.",
        size=24,
    )
    s.save("07-what-it-teaches.png")


def figure_compiler():
    s = Sketch(
        W,
        1700,
        "08 · the compiler",
        ["Compile by search,", "not by prompting."],
        "The recorded answers are targets, never instructions. Candidate programs are enumerated from the words in the requests, executed against every demonstration, and priced.",
        seed=97,
    )
    top = s.content_top
    s.caps(s.margin, top - 4, "three of the candidates the search considered, in the order it ranks them", size=19)

    rows = [
        (
            "read   the word after \u201creverse\u201d\nstep   reverse it\nemit   fill in the recorded wording",
            "explains all 4", "cost 6", "wins", True,
        ),
        (
            "read   the word after \u201creverse\u201d\nstep   nothing\nemit   look the answer up in a table",
            "explains all 4", "cost 34", "priced out", False,
        ),
        (
            "read   the whole request\nstep   nothing\nemit   repeat one recorded sentence",
            "explains none", "cost 2", "discarded", False,
        ),
    ]
    prog_w, row_h, row_gap = 1000, 132, 20
    y = top + 34
    for index, (body, verdict, cost, comment, wins) in enumerate(rows):
        s.round_box(
            s.margin, y, prog_w, row_h, radius=16,
            fill=PEACH_LIGHT if wins else WHITE, outline=INK, width=3 if wins else 2,
        )
        s.mono_block(s.margin + 26, y + 22, body, size=20, max_width=prog_w - 52)
        vx = s.margin + prog_w + 44
        if wins:
            tick(s, vx, y + 34, 1.1)
        else:
            cross(s, vx, y + 24, 0.9)
        s.text(vx + 40, y + 32, verdict, hand(23, 500), INK if wins else MUTED)
        s.text(vx + 40, y + 68, cost, mono(19, "Bold"), INK_SOFT)
        s.text(vx + 40, y + 100, comment, hand(20, 700 if wins else 500), INK if wins else MUTED)
        y += row_h + row_gap

    caption(s, s.margin, y + 2, "A lookup has to beat a genuine computation on price, and usually cannot. 12,000 candidates are enumerated by default, and there is no sampling anywhere in the path.", 21, width=s.w - s.margin * 2)

    gate_y = y + 2 + block_height("A lookup has to beat a genuine computation on price, and usually cannot. 12,000 candidates are enumerated by default, and there is no sampling anywhere in the path.", 21, 400, s.w - s.margin * 2) + 46
    rules = [
        "It explains every demonstration exactly, either reproduced or recognised as a variant of the same answer.",
        "It derives every number it states, from the request, the subject it read, or the value it computed.",
        "It declines inputs it cannot read instead of answering them with a lucky branch.",
    ]
    rule_w = s.w - s.margin * 2 - 104
    gate_h = 74 + sum(block_height(rule, 22, 400, rule_w) + 30 for rule in rules)
    s.round_box(s.margin, gate_y, s.w - s.margin * 2, gate_h, radius=18, fill=WHITE, outline=INK, width=3)
    s.caps(s.margin + 26, gate_y + 24, "before a candidate is priced, it has to survive three rules", size=19)
    ry = gate_y + 72
    for rule in rules:
        mark(s, s.margin + 30, ry + 4, "tick", 23)
        para(s, s.margin + 66, ry, rule, 22, 400, rule_w)
        ry += block_height(rule, 22, 400, rule_w) + 30

    note(s, gate_y + gate_h + 44, "Nothing a model wrote is executed: the search produces the program, and the evidence decides whether it is stored.")
    s.save("08-the-compiler.png")


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
    wanted = sys.argv[1:]
    for name, builder in FIGURES.items():
        if wanted and name not in wanted:
            continue
        builder()


if __name__ == "__main__":
    main()
