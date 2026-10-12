#!/usr/bin/env python3
"""Subset JuliaMono for the bt10x web apps.

Scans the repo for every character the apps can print, rounds that up to
whole Unicode blocks, keeps only what JuliaMono has and what is safely one
cell wide, then writes renamed woff2 files plus the matching @font-face CSS.

JuliaMono is SIL OFL 1.1 with Reserved Font Name "JuliaMono", and a subset is
a Modified Version, so the output is renamed (default "Bt10x Mono").

Usage (from the repo root, needs `pip install fonttools brotli`):
  python3 scripts/subset-juliamono.py --src path/to/JuliaMono-ttf --out web/fonts
"""

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

# Files whose text can reach the screen. Comments get scanned too; that only
# adds a few harmless extra glyphs.
SCAN_GLOBS = [
    "web/**/*.ts",
    "web/*.txt",
    "web/*.html",
    "src/**/*.ts",
    "data/btlib10x.jsonl",
    "data/maps/*.json",
]
SKIP = re.compile(r"\.(test|d)\.ts$")

# Whole blocks kept for headroom, so a new glyph in one of them needs no
# re-subset. Every character the scan finds is added on top, whatever its
# block. Sizes measured on v0.63.2 (per face, woff2, no hinting):
#   without the last four blocks   ~683 glyphs   ~26 KB
#   all blocks below              ~1550 glyphs   ~87 KB
BLOCKS = {
    "Basic Latin": (0x0020, 0x007E),
    "Latin-1 Supplement": (0x00A0, 0x00FF),
    "General Punctuation": (0x2000, 0x206F),
    "Arrows": (0x2190, 0x21FF),
    "Mathematical Operators": (0x2200, 0x22FF),
    "Miscellaneous Technical": (0x2300, 0x23FF),
    "Box Drawing": (0x2500, 0x257F),
    "Block Elements": (0x2580, 0x259F),
    "Geometric Shapes": (0x25A0, 0x25FF),
    "Miscellaneous Symbols": (0x2600, 0x26FF),
    # Not needed so far; uncomment if a glyph from these shows up:
    # "Greek": (0x0370, 0x03FF),
    # "Superscripts and Subscripts": (0x2070, 0x209F),
    "Miscellaneous Mathematical Symbols-B": (0x29C0, 0x29FF),
}

# Unicode categories with no width of their own (combining marks, format
# controls, line/paragraph separators, C0/C1 controls). JuliaMono gives these
# a full advance in hmtx, but browsers render them as zero-width or not at
# all, so an advance check alone would not catch them.
ZERO_WIDTH_CATEGORIES = {"Mn", "Me", "Mc", "Cf", "Cc", "Zl", "Zp"}

FACES = {"regular": ("JuliaMono-Regular.ttf", 400), "bold": ("JuliaMono-Bold.ttf", 700)}

# JuliaMono draws vertical box-drawing strokes up to 0.5em past the cell so they
# join at any line height, which makes stacked rows overlap. These glyphs get
# their outline y-coordinates clamped to the cell (ascent 1900 / descent -450 of
# 2000 upm, i.e. exactly a 1.175 line height) plus a small overshoot that keeps
# antialiased row seams closed. Diagonals (U+2571-2573) are left alone: clamping
# would change their slope.
CELL_TOP, CELL_BOTTOM = 1900, -450
CLAMP_RANGES = [
    (0x2500, 0x2570), (0x2574, 0x257F),  # box drawing
    (0x2320, 0x2321), (0x239B, 0x23B3), (0x23B8, 0x23B9), (0x23D0, 0x23D0),  # integral/bracket pieces, vertical bars
]

ESCAPE = re.compile(r"\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})")


def scan(root: Path) -> dict[int, set[str]]:
    """Every non-ASCII code point in the scanned files, with where it was seen.

    Also decodes \\uXXXX and \\u{...} escapes so glyphs written as escapes in
    TS or JSON are not missed.
    """
    found: dict[int, set[str]] = {}
    for pattern in SCAN_GLOBS:
        for path in sorted(root.glob(pattern)):
            if SKIP.search(path.name):
                continue
            text = path.read_text(encoding="utf8")
            chars = set(text)
            for m in ESCAPE.finditer(text):
                chars.add(chr(int(m.group(1) or m.group(2), 16)))
            rel = str(path.relative_to(root))
            for ch in chars:
                if ord(ch) > 0x7E:
                    found.setdefault(ord(ch), set()).add(rel)
    return found


def is_wide(cp: int) -> bool:
    """East Asian Wide/Fullwidth: takes two terminal cells (Hangul, CJK...)."""
    return unicodedata.east_asian_width(chr(cp)) in ("W", "F")


def is_zero_width(cp: int) -> bool:
    return unicodedata.category(chr(cp)) in ZERO_WIDTH_CATEGORIES


def to_ranges(cps: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for cp in sorted(cps):
        if out and cp == out[-1][1] + 1:
            out[-1] = (out[-1][0], cp)
        else:
            out.append((cp, cp))
    return out


def unicode_range(cps: list[int]) -> str:
    parts = [f"U+{a:04X}" if a == b else f"U+{a:04X}-{b:04X}" for a, b in to_ranges(cps)]
    return ", ".join(parts)


def rename(font: TTFont, family: str, style: str, note: str) -> None:
    """Replace every JuliaMono name record (OFL Reserved Font Name)."""
    ps = family.replace(" ", "") + "-" + style
    name = font["name"]
    for rec_id in (16, 17, 21, 22):
        name.removeNames(nameID=rec_id)
    values = {
        1: family,
        2: style,
        3: f"{note.split()[-1]};{ps}",
        4: f"{family} {style}",
        6: ps,
    }
    for rec_id, value in values.items():
        name.removeNames(nameID=rec_id)
        name.setName(value, rec_id, 3, 1, 0x409)
    # nameID 5 (version) and 0 (copyright) are kept; 10 (description) says
    # where it came from.
    name.removeNames(nameID=10)
    name.setName(f"Subset of JuliaMono ({note}). SIL Open Font License 1.1.", 10, 3, 1, 0x409)
    leftover = [r.toUnicode() for r in name.names if "JuliaMono" in r.toUnicode() and r.nameID not in (0, 5, 10, 13, 14)]
    if leftover:
        sys.exit(f"name table still says JuliaMono: {leftover}")


def clamp_strokes(font: TTFont, overshoot: int) -> int:
    """Clamp outline points of CLAMP_RANGES glyphs to the cell. Returns glyphs changed."""
    top, bottom = CELL_TOP + overshoot, CELL_BOTTOM - overshoot
    cmap, glyf = font.getBestCmap(), font["glyf"]
    changed = 0
    for lo, hi in CLAMP_RANGES:
        for cp in range(lo, hi + 1):
            name = cmap.get(cp)
            if name is None:
                continue
            glyph = glyf[name]
            if glyph.isComposite() or glyph.numberOfContours == 0:
                sys.exit(f"U+{cp:04X}: composite/empty glyph, clamp not implemented")
            coords = glyph.coordinates
            moved = False
            for i, (x, y) in enumerate(coords):
                ny = min(max(y, bottom), top)
                if ny != y:
                    coords[i] = (x, ny)
                    moved = True
            if moved:
                glyph.recalcBounds(glyf)
                changed += 1
    return changed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="repo root to scan")
    ap.add_argument("--src", required=True, help="folder holding the JuliaMono TTFs and LICENSE")
    ap.add_argument("--out", default="web/fonts")
    ap.add_argument("--family", default="Bt10x Mono")
    ap.add_argument("--slug", default="bt10x-mono")
    ap.add_argument("--stroke-overshoot", type=int, default=40, metavar="UNITS",
                    help="how far (of 2000 upm) clamped strokes may pass the cell; -1 keeps JuliaMono's long strokes")
    ap.add_argument("--hinting", action="store_true", help="keep TrueType hinting (bigger files)")
    args = ap.parse_args()

    root, src, out = Path(args.root), Path(args.src), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    fonts = {style: TTFont(src / fname) for style, (fname, _) in FACES.items()}
    version = fonts["regular"]["name"].getDebugName(5).split(";")[0].strip()  # e.g. v0.63.2
    note = f"JuliaMono {version}"

    clamped = 0
    if args.stroke_overshoot >= 0:
        for font in fonts.values():
            clamped = clamp_strokes(font, args.stroke_overshoot)

    # 1. What the apps print.
    seen = scan(root)

    # 2. Rounded up to whole blocks.
    wanted = set(seen)
    for lo, hi in BLOCKS.values():
        wanted.update(range(lo, hi + 1))

    # 3. Only what every face has, minus wide and zero-width code points.
    cmaps = {s: f.getBestCmap() for s, f in fonts.items()}
    have = set.intersection(*(set(c) for c in cmaps.values()))
    cell = fonts["regular"]["hmtx"][cmaps["regular"][ord("0")]][0]

    keep, dropped = [], {"not in JuliaMono": [], "wide (2 cells)": [], "zero-width": [], "odd advance": []}
    for cp in sorted(wanted):
        if is_wide(cp):
            dropped["wide (2 cells)"].append(cp)
        elif is_zero_width(cp):
            dropped["zero-width"].append(cp)
        elif cp not in have:
            dropped["not in JuliaMono"].append(cp)
        elif any(f["hmtx"][cmaps[s][cp]][0] != cell for s, f in fonts.items()):
            dropped["odd advance"].append(cp)
        else:
            keep.append(cp)

    # 4. Subset, rename, write woff2.
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = []  # no ligatures/alternates: terminal shows exactly what was typed
    opts.hinting = args.hinting
    opts.name_IDs = ["*"]
    opts.name_languages = [0x409]
    opts.notdef_outline = True
    opts.drop_tables += ["DSIG"]

    files = {}
    for style, font in fonts.items():
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=keep)
        sub.subset(font)
        rename(font, args.family, style.capitalize(), note)
        fname = f"{args.slug}-{version.lstrip('v')}-{style}.woff2"
        font.flavor = "woff2"
        font.save(out / fname)
        files[style] = fname

    # 5. Re-open the output and check every mapped glyph is one cell wide.
    for style, fname in files.items():
        f = TTFont(out / fname)
        bad = [hex(cp) for cp, g in f.getBestCmap().items() if f["hmtx"][g][0] != cell]
        if bad:
            sys.exit(f"{fname}: glyphs not {cell} units wide: {bad}")

    (out / "OFL.txt").write_text(
        f"{args.family} is a subset of JuliaMono {version}, renamed as the SIL OFL\n"
        "requires for Modified Versions of a font with a Reserved Font Name.\n"
        "Source: https://github.com/cormullion/juliamono\n\n"
        + (src / "LICENSE").read_text(encoding="utf8"),
        encoding="utf8",
    )

    urange = unicode_range(keep)
    css = []
    for style, (_, weight) in FACES.items():
        css.append(
            "@font-face {\n"
            f'  font-family: "{args.family}";\n'
            f'  src: url("fonts/{files[style]}") format("woff2");\n'
            f"  font-weight: {weight};\n"
            "  font-style: normal;\n"
            "  font-display: swap;\n"
            f"  unicode-range: {urange};\n"
            "}\n"
        )
    (out / "fonts.css").write_text(
        f"/* Generated by scripts/subset-juliamono.py from {note}. Paste into web/bt10x.css. */\n" + "".join(css),
        encoding="utf8",
    )

    # Report.
    def fmt(cps: list[int]) -> str:
        return unicode_range(cps) if cps else "-"

    def is_hangul(cp: int) -> bool:
        return 0x1100 <= cp <= 0x11FF or 0x3130 <= cp <= 0x318F or 0xAC00 <= cp <= 0xD7A3

    seen_missing = sorted(cp for cp in seen if cp not in keep and not is_hangul(cp))
    report = {
        "source": note,
        "kept": len(keep),
        "strokes_clamped_glyphs": clamped,
        "files": {s: {"name": n, "bytes": (out / n).stat().st_size} for s, n in files.items()},
        "unicode_range": urange,
        "dropped": {k: fmt(v) for k, v in dropped.items() if k != "wide (2 cells)"},
        "dropped_wide": {
            "count": len(dropped["wide (2 cells)"]),
            "non_hangul": fmt([cp for cp in dropped["wide (2 cells)"] if not 0xAC00 <= cp <= 0xD7A3]),
        },
        "scanned_but_not_kept": [
            {"char": chr(cp), "cp": f"U+{cp:04X}", "files": sorted(seen[cp])[:3]} for cp in seen_missing
        ],
        "scanned_hangul_count": sum(1 for cp in seen if is_hangul(cp)),
    }
    (out / "subset-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
