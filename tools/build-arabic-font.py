#!/usr/bin/env python3
"""Builds "Qalam Amiri": Amiri with its climbing letter combinations switched off.

Amiri (https://github.com/aliftype/amiri, SIL Open Font License 1.1) follows Naskh
calligraphy, where some letter combinations climb above the line: بر in البراء and قبر,
letters stacked over ح in نحو and حين. In a document that reads as uneven, so we remove
the three contextual substitutions that pick those shapes (Amiri 1.003 numbering):

  57  stacks letters before ح (نحو)      — Regular only; Bold draws it into the glyphs
  59  raises the ب+ر combination (البراء, قبر)
  61  raises letters before ح in words like حين

Lookup 140 (مي in اسمي) must NOT be removed: it also carries the dots of ي, and without
it اسمي renders as اسمى.

The script checks its own result: target words must change, and words with ي must render
pixel-identical to stock Amiri. Output is subset to Arabic (plus spaces) and saved as
woff2 in src/fonts/, with the licence.

Needs: fonttools, brotli, pillow (with raqm), numpy.
    python3 tools/build-arabic-font.py
"""

import hashlib
import io
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from fontTools import subset
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont, features

VERSION = "1.003"
URL = f"https://github.com/aliftype/amiri/releases/download/{VERSION}/Amiri-{VERSION}.zip"
SHA256 = "81af0aff7d2086d8af24cea7202f7546130997982534691373485cd96744d05e"
FAMILY = "Qalam Amiri"
OUT = Path(__file__).resolve().parent.parent / "src" / "fonts"

# Same ranges as the @font-face rules in src/fonts.css.
UNICODES = (
    [*range(0x0600, 0x0700), *range(0x0750, 0x0780), *range(0x0870, 0x088F), 0x0890, 0x0891,
     *range(0x0898, 0x08E2), *range(0x08E3, 0x0900), *range(0x200C, 0x200F), 0x2010, 0x2011,
     0x204F, 0x2E41, *range(0xFB50, 0xFE00), *range(0xFE70, 0xFE75), *range(0xFE76, 0xFEFD),
     0x0020, 0x00A0]
)

DROP = {"Regular": {57, 59, 61}, "Bold": {59, 61}}

# Words these lookups flatten, and words that must come out exactly as in stock Amiri.
TARGET_WORDS = {"Regular": ["البراء", "الْبَرَاءِ", "قبر", "نحو", "حين"],
                "Bold": ["البراء", "الْبَرَاءِ", "قبر", "حين"]}
UNCHANGED_WORDS = ["اسمي", "اسْمِي", "في", "فِي", "علي", "يمشي", "وحيد", "مصر"]
SIZE = 120


def render(font_bytes: bytes, word: str) -> Image.Image:
    font = ImageFont.truetype(io.BytesIO(font_bytes), SIZE, layout_engine=ImageFont.Layout.RAQM)
    img = Image.new("L", (SIZE * 8, SIZE * 3), 0)
    ImageDraw.Draw(img).text((20, SIZE), word, font=font, fill=255, direction="rtl", anchor="ls")
    return img


def to_bytes(font: TTFont) -> bytes:
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def flatten(path: Path, style: str) -> TTFont:
    stock = to_bytes(TTFont(path))
    font = TTFont(path)
    lookups = font["GSUB"].table.LookupList.Lookup
    for index in DROP[style]:
        if lookups[index].LookupType != 5:
            sys.exit(f"{path.name}: lookup {index} isn't the expected contextual substitution")
    for record in font["GSUB"].table.FeatureList.FeatureRecord:
        record.Feature.LookupListIndex = [i for i in record.Feature.LookupListIndex if i not in DROP[style]]
    flat = to_bytes(font)

    same = lambda w: np.array_equal(np.asarray(render(stock, w)), np.asarray(render(flat, w)))
    unchanged = [w for w in TARGET_WORDS[style] if same(w)]
    altered = [w for w in UNCHANGED_WORDS if not same(w)]
    if unchanged or altered:
        sys.exit(f"{path.name}: targets not flattened {unchanged}; words that must not change did {altered}")
    print(f"{path.name}: removed lookups {sorted(DROP[style])}; targets flattened, ي words untouched")
    return font


def rename(font: TTFont, style: str) -> None:
    names = font["name"]
    for rec in list(names.names):
        if rec.nameID in (1, 3, 4, 6, 16, 17):
            names.removeNames(nameID=rec.nameID)
    full = f"{FAMILY} {style}"
    for name_id, value in ((1, FAMILY), (2, style), (3, f"{full};{VERSION}"), (4, full),
                           (6, full.replace(" ", "")), (16, FAMILY), (17, style)):
        names.setName(value, name_id, 3, 1, 0x409)


def main() -> None:
    if not features.check("raqm"):
        sys.exit("Pillow needs libraqm (complex text layout) to check the result.")
    with tempfile.TemporaryDirectory() as tmp:
        data = urllib.request.urlopen(URL).read()
        if hashlib.sha256(data).hexdigest() != SHA256:
            sys.exit("Amiri download didn't match its fingerprint.")
        zipfile.ZipFile(io.BytesIO(data)).extractall(tmp)
        src = Path(tmp) / f"Amiri-{VERSION}"
        OUT.mkdir(parents=True, exist_ok=True)
        for style in ("Regular", "Bold"):
            font = flatten(src / f"Amiri-{style}.ttf", style)
            rename(font, style)
            options = subset.Options()
            options.layout_features = ["*"]
            options.name_IDs = ["*"]
            options.flavor = "woff2"
            subsetter = subset.Subsetter(options)
            subsetter.populate(unicodes=UNICODES)
            subsetter.subset(font)
            out = OUT / f"qalam-amiri-{style.lower()}.woff2"
            font.flavor = "woff2"
            font.save(out)
            print(f"wrote {out.relative_to(OUT.parent.parent)} ({out.stat().st_size // 1024} KB)")
        shutil.copy(src / "OFL.txt", OUT / "OFL-Amiri.txt")


if __name__ == "__main__":
    main()
