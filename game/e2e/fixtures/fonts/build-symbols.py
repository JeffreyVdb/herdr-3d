"""Regenerate the pinned monospace symbol fixture; see README.md."""

import hashlib
import io
import sys
from pathlib import Path
from zipfile import ZipFile

from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

archive = Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(archive).hexdigest() == "7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a"
out = Path(__file__).parent
with ZipFile(io.BytesIO(archive)) as release:
    root = "dejavu-fonts-ttf-2.37/"
    font = TTFont(io.BytesIO(release.read(root + "ttf/DejaVuSansMono.ttf")))
    sans = TTFont(io.BytesIO(release.read(root + "ttf/DejaVuSans.ttf")))
    license_text = release.read(root + "LICENSE").decode("utf-8")
    (out / "LICENSE").write_text("\n".join(line.rstrip() for line in license_text.splitlines()) + "\n")

# Mono omits braille. Give the fixture's one braille character the same
# advance, using the corresponding Sans glyph from this same release.
advance = font["hmtx"][font.getBestCmap()[ord("M")]][0]
name = sans.getBestCmap()[0x283F]
width, bearing = sans["hmtx"][name]
scale = advance / width
recording = DecomposingRecordingPen(sans.getGlyphSet())
sans.getGlyphSet()[name].draw(recording)
pen = TTGlyphPen(None)
recording.replay(TransformPen(pen, (scale, 0, 0, 1, 0, 0)))
name = "h3d_braille"
font.setGlyphOrder([*font.getGlyphOrder(), name])
font["glyf"][name] = pen.glyph()
font["hmtx"][name] = (advance, round(bearing * scale))
for table in font["cmap"].tables:
    if table.isUnicode():
        table.cmap[0x283F] = name

# The font is modified: use its own name, as the upstream licence requires.
for record in font["name"].names:
    if record.nameID in (1, 3, 4, 6, 16):
        text = "H3DTestSymbols" if record.nameID == 6 else "H3D Test Symbols"
        record.string = text.encode(record.getEncoding())
options = subset.Options()
options.hinting = False
options.layout_features = []
subsetter = subset.Subsetter(options=options)
subsetter.populate(text="→←↑↓↔⇒⇄↩↵●◆▶✓✔✗✘❯★☐☑⠿≤≥≠")
subsetter.subset(font)
font.recalcTimestamp = False
font.flavor = "woff2"
font.save(out / "h3d-test-symbols.woff2")
