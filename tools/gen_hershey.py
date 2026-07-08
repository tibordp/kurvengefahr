#!/usr/bin/env python3
"""Regenerate crate/fonts/hershey.json from the public-domain Hershey JHF sources.

Usage:
    git clone --depth 1 https://github.com/kamalmostafa/hershey-fonts /tmp/hershey-fonts
    python3 tools/gen_hershey.py /tmp/hershey-fonts/hershey-fonts

Emits, per font, one glyph per ASCII codepoint 32..=127 as {d, a}:
  d  the pen strokes as "Mx,y Lx,y x,y ..." (M lifts the pen, first continuation is L, the rest
     are bare pairs), shifted so the left bearing is at x=0 and the baseline sits where the
     previous conversion put it (x' = x - L, y' = y + 13);
  a  the glyph's true horizontal advance, R - L, in Hershey units.

The {d} strings for 33..=127 are byte-compatible with the previous hersheytext-derived
hershey.json (which stored only o = -L and had no real advances); this script verifies that
against the existing file before overwriting it, so a JHF parsing bug cannot silently reshape
the glyphs.
"""

import json
import sys
from pathlib import Path

# The bundled fonts: JHF file stem -> display name (kept identical to the existing json).
FONTS = {
    "futural": "Sans",
    "futuram": "Sans Bold",
    "timesr": "Serif",
    "timesrb": "Serif Bold",
    "scripts": "Script",
    "gothiceng": "Gothic",
}

BASELINE_SHIFT = 13  # matches the previous conversion: JHF y=0 (centerline) -> y'=13


def parse_jhf(path: Path):
    """Parse a JHF file into glyphs: [{left, right, strokes: [[(x, y), ...], ...]}, ...].

    JHF records: cols 0-4 glyph number, 5-7 vertex count (including the L/R pair), then
    2*count coordinate chars valued ord(c)-ord('R'); the pair " R" is a pen-up; records wrap
    across physical lines.
    """
    lines = path.read_text().splitlines()
    glyphs = []
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip():
            continue
        count = int(line[5:8])
        data = line[8:]
        while len(data) < 2 * count and i < len(lines):
            data += lines[i]
            i += 1
        if len(data) < 2 * count:
            raise ValueError(f"{path.name}: truncated record ({len(data)} < {2 * count} chars)")
        left = ord(data[0]) - ord("R")
        right = ord(data[1]) - ord("R")
        strokes, cur = [], []
        for j in range(2, 2 * count, 2):
            if data[j] == " " and data[j + 1] == "R":  # pen up
                if cur:
                    strokes.append(cur)
                cur = []
                continue
            cur.append((ord(data[j]) - ord("R"), ord(data[j + 1]) - ord("R")))
        if cur:
            strokes.append(cur)
        glyphs.append({"left": left, "right": right, "strokes": strokes})
    return glyphs


def glyph_d(g) -> str:
    """The committed d-string format: per stroke "Mx,y Lx,y x,y ...", left-aligned, baseline-shifted."""
    parts = []
    for stroke in g["strokes"]:
        for k, (x, y) in enumerate(stroke):
            sx, sy = x - g["left"], y + BASELINE_SHIFT
            prefix = "M" if k == 0 else ("L" if k == 1 else "")
            parts.append(f"{prefix}{sx},{sy}")
    return " ".join(parts)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    jhf_dir = Path(sys.argv[1])
    out_path = Path(__file__).resolve().parent.parent / "crate" / "fonts" / "hershey.json"
    old = json.loads(out_path.read_text()) if out_path.exists() else {}

    result = {}
    for key, name in FONTS.items():
        glyphs = parse_jhf(jhf_dir / f"{key}.jhf")
        if len(glyphs) < 96:
            raise ValueError(f"{key}: expected >= 96 glyphs (ASCII 32..127), got {len(glyphs)}")
        chars = [{"d": glyph_d(g), "a": g["right"] - g["left"]} for g in glyphs[:96]]

        # Self-check against the previous conversion: same strokes for '!'..'~', and its `o` field
        # must equal the JHF right-hand position. A mismatch means the JHF parse is wrong — bail.
        if key in old:
            old_chars = old[key]["chars"]
            for idx, oc in enumerate(old_chars):
                nc = chars[idx + 1]  # old index 0 = '!', new index 0 = ' '
                if "d" in oc and oc["d"] != nc["d"]:
                    raise ValueError(f"{key} glyph {chr(33 + idx)!r}: d mismatch\n old: {oc['d']}\n new: {nc['d']}")
                if "o" in oc and oc["o"] != glyphs[idx + 1]["right"]:
                    raise ValueError(f"{key} glyph {chr(33 + idx)!r}: o != R")
        result[key] = {"name": name, "chars": chars}

    out_path.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    print(f"wrote {out_path} ({len(result)} fonts, 96 glyphs each)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
