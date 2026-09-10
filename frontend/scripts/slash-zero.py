"""Regenerates fonts/share-tech-mono-400-latin.woff2 with a slashed-zero variant.

The stock Share Tech Mono draws '0' as its '8' with the waist removed — same
outer bowl, same width, the counters just merge instead of pinching. At the
12-14px the tables use, the two are almost the same blob, which is expensive
when the figures are weights and money someone is reading out loud.

This adds a 'zero.slash' glyph (the stock zero plus a diagonal bar across the
counter) and wires it to the standard OpenType 'zero' feature. The default '0'
is left alone, so the change only shows where CSS opts in — see the .font-mono
rule in css/tailwind-source.css. The existing 'frac' and 'liga' features are
preserved. Printed receipts set their own Arial/Times stacks (receipt/*.css)
and are unaffected.

The shipped font is already patched; this only needs re-running if the upstream
face is re-downloaded. Requires `pip install fonttools brotli`:

    python3 scripts/slash-zero.py <upstream.woff2> fonts/share-tech-mono-400-latin.woff2
"""
import sys

from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables import otTables as ot

SRC = sys.argv[1]
DST = sys.argv[2]

f = TTFont(SRC)
glyf, hmtx, glyphSet = f['glyf'], f['hmtx'], f.getGlyphSet()

# --- 1. Build zero.slash = zero + a diagonal bar across the counter ---------
zero = glyf['zero']
zero.expand(glyf)


def signed_area(points):
    total = 0.0
    for i, (x0, y0) in enumerate(points):
        x1, y1 = points[(i + 1) % len(points)]
        total += x0 * y1 - x1 * y0
    return total / 2.0


outer = [tuple(p) for p in zero.coordinates[:zero.endPtsOfContours[0] + 1]]
outer_sign = 1 if signed_area(outer) > 0 else -1

# Endpoints sit inside the bowl at both ends so the bar reads as joined to the
# stroke rather than as a floating tick. The counter spans x[177,363] y[75,625]
# in a 1000-unit em. Thickness stays well under the 85-unit vertical stem: a
# heavier bar closes the counter up at 12px and the zero turns into a dark
# blob, which trades one ambiguity for another.
x1, y1, x2, y2 = 165.0, 70.0, 375.0, 630.0
THICKNESS = 56.0
dx, dy = x2 - x1, y2 - y1
length = (dx * dx + dy * dy) ** 0.5
ox, oy = dy / length * THICKNESS / 2, -dx / length * THICKNESS / 2

quad = [(x1 + ox, y1 + oy), (x2 + ox, y2 + oy), (x2 - ox, y2 - oy), (x1 - ox, y1 - oy)]
# Fill (rather than cut a hole) means winding the same way as the outer contour.
if (1 if signed_area(quad) > 0 else -1) != outer_sign:
    quad.reverse()

pen = TTGlyphPen(glyphSet)
glyphSet['zero'].draw(pen)
pen.moveTo(quad[0])
for point in quad[1:]:
    pen.lineTo(point)
pen.closePath()

# glyf.__setitem__ appends to its own glyphOrder; mirror that onto the font so
# the two stay the same length (glyf asserts on the mismatch when compiling).
glyf['zero.slash'] = pen.glyph()
hmtx['zero.slash'] = hmtx['zero']
f.setGlyphOrder(list(glyf.glyphOrder))

# --- 2. Register it under the 'zero' feature, per script --------------------
# feaLib would rebuild GSUB from scratch and drop 'frac'/'liga', so the lookup
# and feature records are appended by hand instead.
gsub = f['GSUB'].table

subtable = ot.SingleSubst()
subtable.mapping = {'zero': 'zero.slash'}

lookup = ot.Lookup()
lookup.LookupType = 1
lookup.LookupFlag = 0
lookup.SubTable = [subtable]
lookup.SubTableCount = 1
gsub.LookupList.Lookup.append(lookup)
gsub.LookupList.LookupCount = len(gsub.LookupList.Lookup)
lookup_index = gsub.LookupList.LookupCount - 1

# Each script carries its own FeatureRecord (as 'frac'/'liga' already do), all
# pointing at the one shared lookup. Appending keeps the list tag-alphabetical.
for script_record in gsub.ScriptList.ScriptRecord:
    feature = ot.Feature()
    feature.FeatureParams = None
    feature.LookupListIndex = [lookup_index]
    feature.LookupCount = 1

    record = ot.FeatureRecord()
    record.FeatureTag = 'zero'
    record.Feature = feature
    gsub.FeatureList.FeatureRecord.append(record)
    gsub.FeatureList.FeatureCount = len(gsub.FeatureList.FeatureRecord)

    lang_sys_list = [script_record.Script.DefaultLangSys] if script_record.Script.DefaultLangSys else []
    lang_sys_list += [r.LangSys for r in script_record.Script.LangSysRecord]
    for lang_sys in lang_sys_list:
        lang_sys.FeatureIndex.append(gsub.FeatureList.FeatureCount - 1)
        lang_sys.FeatureCount = len(lang_sys.FeatureIndex)

f.flavor = 'woff2'
f.save(DST)
print('wrote', DST)
