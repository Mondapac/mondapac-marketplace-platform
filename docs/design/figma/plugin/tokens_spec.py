"""Single source for MondaPac tokens: primitives, semantic colour (light/dark), dimension (desktop/touch), typography, effects.
Outputs: spec.json (for the Figma plugin) and repo token files (DTCG multi-file + CSS)."""
import json, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))

# ---------- semantic colour: (light, dark, scopes, description) ----------
C = {
 "bg/page": ("#F5F6F8", "#0E1116", "FRAME_FILL", "Page background behind cards"),
 "bg/surface": ("#FFFFFF", "#161A21", "FRAME_FILL,SHAPE_FILL,STROKE_COLOR,TEXT_FILL", "Cards, sidebar, top bar"),
 "bg/subtle": ("#F9FAFB", "#1B2029", "FRAME_FILL,SHAPE_FILL", "Table header, card footers, hover"),
 "bg/muted": ("#EEF0F3", "#232933", "FRAME_FILL,SHAPE_FILL", "Document viewer, neutral fills"),
 "bg/selected": ("#EDF2FF", "#1B2645", "FRAME_FILL,SHAPE_FILL", "Active nav item, applied filter, selected segment"),
 "bg/row-selected": ("#F7F9FF", "#18213A", "FRAME_FILL", "Selected table row"),
 "bg/row-attention": ("#FFFCF7", "#211A10", "FRAME_FILL", "Rows that need action"),
 "bg/info-banner": ("#EEF3FD", "#15213A", "FRAME_FILL", "Info banner"),
 "border/default": ("#E3E6EB", "#2A303B", "STROKE_COLOR,SHAPE_FILL", "Card and section borders"),
 "border/row": ("#EEF0F3", "#222833", "STROKE_COLOR,SHAPE_FILL", "Row dividers"),
 "border/control": ("#D0D5DD", "#3A4250", "STROKE_COLOR,FRAME_FILL", "Secondary buttons, segmented controls"),
 "border/input": ("#8A93A3", "#6B7586", "STROKE_COLOR,SHAPE_FILL", "Inputs, checkboxes (3:1 on surface)"),
 "border/info": ("#C9D7F5", "#2B3F6B", "STROKE_COLOR", "Info banner border"),
 "text/primary": ("#111827", "#E8EBF0", "TEXT_FILL,STROKE_COLOR,FRAME_FILL", "Headings, values"),
 "text/secondary": ("#3F4756", "#C3C9D3", "TEXT_FILL", "Body text, labels"),
 "text/muted": ("#5B6475", "#98A1B0", "TEXT_FILL,STROKE_COLOR", "Meta text, axis labels"),
 "text/link": ("#1B45BD", "#8FB0FF", "TEXT_FILL,STROKE_COLOR", "Links, selected tab"),
 "text/link-hover": ("#173FB0", "#B3C8FF", "TEXT_FILL", "Link hover"),
 "text/on-accent": ("#FFFFFF", "#FFFFFF", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR", "Text and icons on primary"),
 "icon/default": ("#3F4756", "#C3C9D3", "SHAPE_FILL,STROKE_COLOR", "Default icon colour"),
 "icon/muted": ("#5B6475", "#98A1B0", "SHAPE_FILL,STROKE_COLOR", "Secondary icons"),
 "action/primary": ("#1D4FD7", "#3D68E6", "FRAME_FILL,SHAPE_FILL,STROKE_COLOR", "Primary button, focus, selection"),
 "action/primary-hover": ("#1A45BF", "#3159D4", "FRAME_FILL,SHAPE_FILL", "Primary button hover"),
 "action/primary-disabled": ("#C7D4F5", "#26345A", "FRAME_FILL,SHAPE_FILL", "Disabled primary button"),
 "focus/ring": ("#1D4FD7", "#8FB0FF", "STROKE_COLOR,EFFECT_COLOR", "Keyboard focus ring"),
 "status/success/bg": ("#E7F6EC", "#0F2E1D", "FRAME_FILL,SHAPE_FILL", "Success badge background"),
 "status/success/fg": ("#12663A", "#6CD49A", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR,FRAME_FILL", "Success text and icon"),
 "status/success/track": ("#DDF2E5", "#1C4A30", "SHAPE_FILL,STROKE_COLOR", "Success ring track"),
 "status/info/bg": ("#EAF1FB", "#13284A", "FRAME_FILL,SHAPE_FILL", "Info badge background"),
 "status/info/fg": ("#1F4E8C", "#8DB5F2", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR", "Info text and icon"),
 "status/attention/bg": ("#FFF1E0", "#33240D", "FRAME_FILL,SHAPE_FILL", "Attention badge background"),
 "status/attention/fg": ("#8F4A00", "#F5B65C", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR", "Attention text and icon"),
 "status/attention/solid": ("#C46A00", "#E08A1E", "SHAPE_FILL,STROKE_COLOR", "Attention meter fill, pips"),
 "status/attention/track": ("#FBE3C4", "#4A3418", "SHAPE_FILL,STROKE_COLOR", "Attention meter track"),
 "status/attention/border": ("#F2C894", "#6B4A1F", "STROKE_COLOR", "Attention card border"),
 "status/attention/surface": ("#FFF8EF", "#241A0D", "FRAME_FILL", "Attention panel background"),
 "status/critical/bg": ("#FDEBEA", "#3B1512", "FRAME_FILL,SHAPE_FILL", "Critical badge background"),
 "status/critical/fg": ("#A8231A", "#F79A90", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR", "Critical text and icon"),
 "status/critical/solid": ("#D92D20", "#F04438", "SHAPE_FILL,STROKE_COLOR", "Urgent card border, red ring"),
 "status/critical/meter": ("#B42318", "#F04438", "SHAPE_FILL,FRAME_FILL", "Overdue meter fill"),
 "status/critical/track": ("#F6C9C5", "#4F201C", "SHAPE_FILL,STROKE_COLOR", "Overdue meter track"),
 "status/critical/border": ("#F3C4C0", "#7A2E28", "STROKE_COLOR", "Destructive secondary button border"),
 "status/neutral/bg": ("#EEF0F3", "#262C36", "FRAME_FILL,SHAPE_FILL", "Neutral badge background"),
 "status/neutral/fg": ("#3F4756", "#C3C9D3", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR", "Neutral text"),
 "cert/seller/fg": ("#0B6B5C", "#5BCFB8", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR,FRAME_FILL", "Seller-level certificate"),
 "cert/seller/bg": ("#F2FAF8", "#0F2925", "FRAME_FILL,SHAPE_FILL", "Seller certificate chip"),
 "cert/seller/border": ("#B7DDD5", "#1F4D45", "STROKE_COLOR", "Seller certificate chip border"),
 "cert/seller/tile": ("#E6F4F1", "#123430", "FRAME_FILL,SHAPE_FILL", "Teal identity tile"),
 "cert/manufacturer/fg": ("#3F4756", "#C3C9D3", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR", "Manufacturer certificate"),
 "cert/manufacturer/bg": ("#FFFFFF", "#161A21", "FRAME_FILL", "Manufacturer chip"),
 "cert/manufacturer/border": ("#D0D5DD", "#3A4250", "STROKE_COLOR", "Manufacturer chip border"),
 "cert/vegan/fg": ("#3F6212", "#A9D570", "TEXT_FILL,SHAPE_FILL,STROKE_COLOR", "Vegan certificate"),
 "cert/vegan/bg": ("#F5FAEF", "#1A2812", "FRAME_FILL", "Vegan chip"),
 "cert/vegan/border": ("#C8DDB0", "#35511F", "STROKE_COLOR", "Vegan chip border"),
 "cert/vegan/self-declared-border": ("#9DBB7A", "#6E8F45", "STROKE_COLOR", "Self-declared chip, dashed"),
 "tile/purple-bg": ("#F1ECFF", "#271E47", "FRAME_FILL,SHAPE_FILL", "Identity tile: applications"),
 "tile/purple-fg": ("#5B3CC4", "#B9A6FF", "TEXT_FILL,SHAPE_FILL", "Identity tile text"),
 "thumb/meat-bg": ("#FDE7E3", "#3A1A16", "FRAME_FILL", "Product thumbnail: meat"),
 "thumb/meat-fg": ("#B23F2E", "#F4A595", "STROKE_COLOR,SHAPE_FILL", "Meat glyph"),
 "thumb/poultry-bg": ("#FFF0D6", "#33260F", "FRAME_FILL", "Product thumbnail: poultry"),
 "thumb/poultry-fg": ("#9A5A08", "#F3C46A", "STROKE_COLOR,SHAPE_FILL", "Poultry glyph"),
 "thumb/bakery-bg": ("#F6EADB", "#2F2419", "FRAME_FILL", "Product thumbnail: bakery"),
 "thumb/bakery-fg": ("#865628", "#E4BB8E", "STROKE_COLOR,SHAPE_FILL", "Bakery glyph"),
 "thumb/pantry-bg": ("#EAF2DF", "#1F2B14", "FRAME_FILL", "Product thumbnail: pantry"),
 "thumb/pantry-fg": ("#4C6A1C", "#B6D68B", "STROKE_COLOR,SHAPE_FILL", "Pantry glyph"),
 "thumb/other-bg": ("#EBEEF2", "#232830", "FRAME_FILL", "Product thumbnail: other"),
 "thumb/other-fg": ("#4A525E", "#C3C9D3", "STROKE_COLOR,SHAPE_FILL", "Other glyph"),
 "chart/series-1": ("#1D4FD7", "#7096FF", "SHAPE_FILL,STROKE_COLOR", "Main series"),
 "chart/series-1-soft": ("#B9C9F2", "#2C3F73", "SHAPE_FILL", "Past periods in bar charts"),
 "chart/split-2": ("#9DB4F0", "#4A68B8", "SHAPE_FILL", "Second part of a split bar"),
 "chart/compare": ("#7C8698", "#8B95A6", "STROKE_COLOR", "Comparison series (dashed)"),
 "chart/grid": ("#EEF0F3", "#232933", "STROKE_COLOR,SHAPE_FILL", "Gridlines"),
 "chart/axis": ("#D0D5DD", "#3A4250", "STROKE_COLOR,SHAPE_FILL", "Baseline"),
 "chart/meter-track": ("#DCE6FB", "#22305A", "SHAPE_FILL,STROKE_COLOR", "Meter track, accent"),
 "chart/donut-track": ("#DCEFEA", "#143A34", "STROKE_COLOR,SHAPE_FILL", "Certificate donut track"),
 "chart/tooltip-bg": ("#111827", "#E8EBF0", "FRAME_FILL,SHAPE_FILL", "Chart tooltip background (inverse)"),
 "chart/tooltip-fg": ("#FFFFFF", "#111827", "TEXT_FILL", "Chart tooltip value"),
 "chart/tooltip-muted": ("#D0D5DD", "#3F4756", "TEXT_FILL", "Chart tooltip label"),
 "map/land": ("#F3F5F8", "#181C24", "FRAME_FILL,SHAPE_FILL", "Map land"),
 "map/water": ("#DDE7F3", "#17263A", "SHAPE_FILL,STROKE_COLOR", "Map water"),
 "map/road": ("#E3E6EB", "#2A303B", "STROKE_COLOR", "Map roads"),
 "map/seller-pin": ("#1D4FD7", "#7096FF", "SHAPE_FILL", "Seller with open orders"),
 "map/courier": ("#0B6B5C", "#5BCFB8", "SHAPE_FILL", "Courier position"),
 "board/action-bg": ("#FFF8EF", "#211A10", "FRAME_FILL", "Needs action column"),
 "board/action-border": ("#F3D7B0", "#4A3418", "STROKE_COLOR", "Needs action column border"),
 "board/prep-bg": ("#F3F6FC", "#141B2C", "FRAME_FILL", "Preparing column"),
 "board/prep-border": ("#D6E0F2", "#2B3F6B", "STROKE_COLOR", "Preparing column border"),
 "board/ready-bg": ("#F1F8F3", "#10221A", "FRAME_FILL", "Ready column"),
 "board/ready-border": ("#CFE6D7", "#1F4A33", "STROKE_COLOR", "Ready column border"),
 # 1.6.0: appended last so a library updated in place exports in the same order as a fresh build.
 # Hex8 literals (RRGGBBAA): the alpha is part of the value, so there is no primitive and no alias.
 "bg/scrim": ("#11182780", "#00000099", "FRAME_FILL,SHAPE_FILL", "Overlay behind drawers and modals; alpha is part of the value"),
 # 1.7.0 "Auth": appended last for the same reason. The brand panel colours are the same in both themes.
 "bg/qr": ("#FFFFFF", "#FFFFFF", "FRAME_FILL,SHAPE_FILL", "QR code plate; white in both themes"),
 "bg/auth-showcase-admin": ("#0B1D2E", "#0B1D2E", "FRAME_FILL,SHAPE_FILL", "Auth brand panel, Admin; dark in both themes"),
 "bg/auth-showcase-seller": ("#06352E", "#06352E", "FRAME_FILL,SHAPE_FILL", "Auth brand panel, Seller; dark in both themes"),
 "text/on-showcase": ("#FFFFFF", "#FFFFFF", "TEXT_FILL,FRAME_FILL,SHAPE_FILL", "Brand line on the Auth brand panel"),
 "text/on-showcase-muted": ("#FFFFFFBD", "#FFFFFFBD", "TEXT_FILL,STROKE_COLOR", "Secondary brand line on the Auth brand panel; alpha is part of the value"),
}
def literal(h): return len(h) == 9
# family for primitive naming
FAM = {}
def fam(name, hexes):
    for h in hexes: FAM.setdefault(h.upper(), name)
fam("neutral", ["#FFFFFF","#F9FAFB","#F5F6F8","#EEF0F3","#E3E6EB","#D0D5DD","#98A1B0","#8A93A3","#7C8698","#5B6475","#3F4756","#111827","#0E1116","#161A21","#1B2029","#232933","#2A303B","#222833","#3A4250","#6B7586","#E8EBF0","#C3C9D3","#8B95A6","#262C36","#EBEEF2","#4A525E","#232830","#181C24"])
fam("blue", ["#0B1D2E","#EDF2FF","#F7F9FF","#EEF3FD","#C9D7F5","#1B45BD","#173FB0","#1D4FD7","#1A45BF","#C7D4F5","#EAF1FB","#1F4E8C","#B9C9F2","#9DB4F0","#DCE6FB","#DDE7F3","#F3F6FC","#D6E0F2","#1B2645","#18213A","#15213A","#2B3F6B","#8FB0FF","#B3C8FF","#3D68E6","#3159D4","#26345A","#13284A","#8DB5F2","#7096FF","#2C3F73","#4A68B8","#22305A","#17263A","#141B2C","#F3F5F8"])
fam("amber", ["#FFFCF7","#FFF1E0","#8F4A00","#C46A00","#FBE3C4","#F2C894","#FFF8EF","#F3D7B0","#211A10","#33240D","#F5B65C","#E08A1E","#4A3418","#6B4A1F","#241A0D"])
fam("green", ["#E7F6EC","#12663A","#DDF2E5","#F1F8F3","#CFE6D7","#0F2E1D","#6CD49A","#1C4A30","#10221A","#1F4A33"])
fam("red", ["#FDEBEA","#A8231A","#D92D20","#B42318","#F6C9C5","#F3C4C0","#3B1512","#F79A90","#F04438","#4F201C","#7A2E28"])
fam("teal", ["#06352E","#0B6B5C","#F2FAF8","#B7DDD5","#E6F4F1","#DCEFEA","#5BCFB8","#0F2925","#1F4D45","#123430","#143A34"])
fam("lime", ["#3F6212","#F5FAEF","#C8DDB0","#9DBB7A","#A9D570","#1A2812","#35511F","#6E8F45"])
fam("purple", ["#F1ECFF","#5B3CC4","#271E47","#B9A6FF"])
fam("coral", ["#FDE7E3","#B23F2E","#3A1A16","#F4A595"])
fam("honey", ["#FFF0D6","#9A5A08","#33260F","#F3C46A"])
fam("brown", ["#F6EADB","#865628","#2F2419","#E4BB8E"])
fam("olive", ["#EAF2DF","#4C6A1C","#1F2B14","#B6D68B"])

def srgb(h): h=h.lstrip('#'); return [int(h[i:i+2],16)/255 for i in (0,2,4)]
def lin(c): return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
def oklab_L(h):
    r,g,b=[lin(c) for c in srgb(h)]
    l=0.4122214708*r+0.5363325363*g+0.0514459929*b; m=0.2119034982*r+0.6806995451*g+0.1073969566*b; s=0.0883024619*r+0.2817188376*g+0.6299787005*b
    l,m,s=[x**(1/3) for x in (l,m,s)]
    return 0.2104542553*l+0.7936177850*m-0.0040720468*s
def rel(h):
    r,g,b=[lin(c) for c in srgb(h)]; return 0.2126*r+0.7152*g+0.0722*b
def over(fg, bg):
    """A #RRGGBBAA foreground composited over an opaque background (alpha tokens such as text/on-showcase-muted)."""
    if not literal(fg): return fg
    a = int(fg[7:9], 16) / 255
    return '#' + ''.join('%02X' % round((a * f + (1 - a) * b) * 255) for f, b in zip(srgb(fg), srgb(bg)))
def cr(a,b):
    a = over(a, b)
    la,lb=rel(a),rel(b); return (max(la,lb)+0.05)/(min(la,lb)+0.05)

# ---------- primitives: name = family/step, step = 1000*(1-L) rounded to 5, unique ----------
allhex = sorted({v[i].upper() for v in C.values() for i in (0, 1) if not literal(v[i])})
missing = [h for h in allhex if h not in FAM]
if missing: sys.exit('no family for ' + ', '.join(missing))
prim = {}   # hex -> name
used = set()
# Primitives added after 1.0.0 are named after the existing ones, so an existing name never changes
# (a rename would be a MAJOR change). A new hex that lands on a taken step takes the next free step.
NEW_PRIMITIVES = ["#0B1D2E", "#06352E"]  # 1.7.0: Auth brand panel
for h in sorted([x for x in allhex if x not in NEW_PRIMITIVES], key=lambda x: (FAM[x], -oklab_L(x))) + NEW_PRIMITIVES:
    step = int(round((1 - oklab_L(h)) * 1000 / 5.0) * 5)
    if h == '#FFFFFF': step = 0
    name = '%s/%d' % (FAM[h], step)
    while name in used:
        step += 5; name = '%s/%d' % (FAM[h], step)
    used.add(name); prim[h] = name
primitives = sorted(((n, h) for h, n in prim.items()), key=lambda x: (x[0].split('/')[0], int(x[0].split('/')[1])))

# ---------- contrast checks ----------
checks = []
def need(fg, bgs, minr, label):
    for theme, idx in (('light', 0), ('dark', 1)):
        for bg in bgs:
            r = cr(C[fg][idx], C[bg][idx])
            checks.append((theme, label, fg, bg, round(r, 2), minr, r >= minr))
need('text/primary', ['bg/page','bg/surface','bg/subtle','bg/muted','bg/selected'], 4.5, 'text')
need('text/secondary', ['bg/page','bg/surface','bg/subtle','bg/row-selected','bg/row-attention'], 4.5, 'text')
need('text/muted', ['bg/page','bg/surface','bg/subtle'], 4.5, 'text')
need('text/link', ['bg/surface','bg/selected','bg/info-banner'], 4.5, 'text')
need('text/on-accent', ['action/primary','action/primary-hover'], 4.5, 'text')
for t in ['success','info','attention','critical','neutral']:
    need('status/%s/fg' % t, ['status/%s/bg' % t], 4.5, 'badge')
need('status/attention/fg', ['status/attention/surface','bg/surface'], 4.5, 'text')
need('status/critical/fg', ['bg/surface'], 4.5, 'text')
need('status/success/fg', ['bg/surface'], 4.5, 'text')
for k in ['seller','manufacturer','vegan']:
    need('cert/%s/fg' % k, ['cert/%s/bg' % k], 4.5, 'chip')
need('cert/seller/fg', ['cert/seller/tile'], 4.5, 'tile')
need('tile/purple-fg', ['tile/purple-bg'], 4.5, 'tile')
for k in ['meat','poultry','bakery','pantry','other']:
    need('thumb/%s-fg' % k, ['thumb/%s-bg' % k], 3.0, 'glyph')
need('border/input', ['bg/surface'], 3.0, 'ui-boundary')
need('focus/ring', ['bg/surface','bg/page'], 3.0, 'focus')
need('chart/series-1', ['bg/surface'], 3.0, 'graphic')
need('chart/compare', ['bg/surface'], 3.0, 'graphic')
need('status/critical/solid', ['bg/surface'], 3.0, 'graphic')
need('status/attention/solid', ['bg/surface'], 3.0, 'graphic')
need('map/seller-pin', ['map/land'], 3.0, 'graphic')
need('map/courier', ['map/land'], 3.0, 'graphic')
need('chart/tooltip-fg', ['chart/tooltip-bg'], 4.5, 'text')
need('chart/tooltip-muted', ['chart/tooltip-bg'], 4.5, 'text')
need('icon/default', ['bg/surface'], 3.0, 'icon')
need('icon/muted', ['bg/surface'], 3.0, 'icon')
# 1.7.0: brand line on the Auth brand panel (both panel colours are the same in both themes)
need('text/on-showcase', ['bg/auth-showcase-admin','bg/auth-showcase-seller'], 4.5, 'text')
need('text/on-showcase-muted', ['bg/auth-showcase-admin','bg/auth-showcase-seller'], 4.5, 'text')
fails = [c for c in checks if not c[6]]
for c in fails: print('FAIL', c)
print(len(checks), 'checks,', len(fails), 'fail;', len(primitives), 'primitives')
json.dump({'checks': checks}, open(os.path.join(HERE, 'contrast-report.json'), 'w'), indent=1)

# ---------- dimension (desktop, touch) ----------
D = {
 "space/0-5": (2,2), "space/1": (4,4), "space/1-5": (6,6), "space/2": (8,8), "space/2-5": (10,10), "space/3": (12,12), "space/3-5": (14,14),
 "space/4": (16,16), "space/4-5": (18,18), "space/5": (20,20), "space/6": (24,24), "space/7": (28,28), "space/8": (32,32), "space/10": (40,40),
 "radius/chip": (6,6), "radius/control": (8,10), "radius/card": (12,12), "radius/column": (14,14), "radius/pill": (999,999),
 "size/control-sm": (32,44), "size/control": (36,48), "size/control-lg": (44,48), "size/badge": (22,24), "size/icon": (18,20), "size/thumb": (28,32),
 "size/sidebar": (248,248), "size/sidebar-collapsed": (72,72), "size/topbar": (64,64), "border/width": (1,1), "border/width-strong": (2,2),
 # 1.5.0 (D16): appended last so a library updated in place exports in the same order as a fresh build.
 "size/bottom-bar": (64,64),
 # 1.6.0: phone top bar height (both panels), appended after bottom-bar for the same reason.
 "size/topbar-phone": (56,56),
 # 1.7.0 "Auth": width of the Auth form column's content, appended last.
 "size/auth-card": (400,400),
 # 1.8.0 "Panel": dialog widths (Sm: confirm, change-role, invite and add-seller dialogs, also the Toast; Md: dialogs with a reason field).
 "size/dialog-sm": (400,400),
 "size/dialog-md": (560,560),
}
DSCOPE = {"space": "GAP,WIDTH_HEIGHT", "radius": "CORNER_RADIUS", "size": "WIDTH_HEIGHT", "border": "STROKE_FLOAT"}
# ---------- typography ----------
TYPE = [  # name, family, style, size, lineHeight, letterSpacing(px), case
 ("Display/Hero", "IBM Plex Sans", "SemiBold", 30, 38, -0.3, None),
 ("Heading/H1", "IBM Plex Sans", "SemiBold", 24, 32, -0.24, None),
 ("Heading/H2", "IBM Plex Sans", "SemiBold", 16, 22, 0, None),
 ("Heading/Amount", "IBM Plex Sans", "SemiBold", 26, 32, -0.2, None),
 ("Heading/Stat", "IBM Plex Sans", "SemiBold", 22, 28, 0, None),
 ("Body/Default", "IBM Plex Sans", "Regular", 13.5, 20, 0, None),
 ("Body/Medium", "IBM Plex Sans", "Medium", 13.5, 20, 0, None),
 ("Body/Strong", "IBM Plex Sans", "SemiBold", 13.5, 20, 0, None),
 ("Body/Small", "IBM Plex Sans", "Regular", 12.5, 18, 0, None),
 ("Body/Small Strong", "IBM Plex Sans", "SemiBold", 12.5, 18, 0, None),
 ("Caption/Default", "IBM Plex Sans", "Regular", 12, 16, 0, None),
 ("Caption/Strong", "IBM Plex Sans", "SemiBold", 12, 16, 0, None),
 ("Caption/Overline", "IBM Plex Sans", "SemiBold", 11, 16, 0.77, "UPPER"),
 ("Label/Button", "IBM Plex Sans", "SemiBold", 13.5, 20, 0, None),
 ("Label/Button Small", "IBM Plex Sans", "SemiBold", 13, 18, 0, None),
 ("Touch/Body", "IBM Plex Sans", "Regular", 14, 20, 0, None),
 ("Touch/Strong", "IBM Plex Sans", "Bold", 14, 20, 0, None),
 ("Touch/Button", "IBM Plex Sans", "SemiBold", 15, 20, 0, None),
 ("Touch/Title", "IBM Plex Sans", "Bold", 15, 20, 0, None),
 ("Mono/Default", "IBM Plex Mono", "Medium", 13.5, 20, 0, None),
 ("Mono/Small", "IBM Plex Mono", "Regular", 11, 16, 0, None),
 ("Mono/Touch", "IBM Plex Mono", "Medium", 15, 20, 0, None),
]
EFFECTS = [
 ("Elevation/Floating", [("DROP_SHADOW", (17,24,39,0.22), 0, 12, 28, -8), ("DROP_SHADOW", (17,24,39,0.10), 0, 4, 8, -4)], "Floating bulk action bar"),
 ("Elevation/Document", [("DROP_SHADOW", (17,24,39,0.10), 0, 1, 2, 0), ("DROP_SHADOW", (17,24,39,0.08), 0, 8, 16, 0)], "Document preview paper"),
 ("Focus/Ring", [("DROP_SHADOW", (255,255,255,1), 0, 0, 0, 2, "bg/surface"), ("DROP_SHADOW", (29,79,215,1), 0, 0, 0, 4, "focus/ring")], "Keyboard focus ring: 2px gap + 2px blue"),
 ("Ring/Urgent", [("DROP_SHADOW", (253,235,234,1), 0, 0, 0, 3, "status/critical/bg")], "Ring around urgent order card"),
]
MOTION = {"duration/fast": 120, "duration/base": 160, "duration/slow": 240}

spec = {
 "version": "1.8.2", "generated": "2026-10-07",
 "primitives": [{"name": n, "hex": h} for n, h in primitives],
 "color": [{"name": k, "light": None if literal(v[0]) else prim[v[0].upper()], "dark": None if literal(v[1]) else prim[v[1].upper()], "lightHex": v[0].upper(), "darkHex": v[1].upper(), "scopes": v[2].split(','), "description": v[3]} for k, v in C.items()],
 "dimension": [{"name": k, "desktop": v[0], "touch": v[1], "scopes": DSCOPE[k.split('/')[0]].split(',')} for k, v in D.items()],
 "type": [{"name": t[0], "family": t[1], "style": t[2], "size": t[3], "lineHeight": t[4], "letterSpacing": t[5], "case": t[6]} for t in TYPE],
 "effects": [{"name": e[0], "layers": [{"type": l[0], "rgba": l[1], "x": l[2], "y": l[3], "blur": l[4], "spread": l[5], "token": l[6] if len(l) > 6 else None} for l in e[1]], "description": e[2]} for e in EFFECTS],
 "motion": MOTION,
}
json.dump(spec, open(os.path.join(HERE, 'spec.json'), 'w'), indent=1)

# ---------- repo token files (DTCG) ----------
# Default output: the repo's docs/design/tokens (this script lives in docs/design/figma/plugin).
REPO_TOKENS = os.path.normpath(os.path.join(HERE, '..', '..', 'tokens'))
out = sys.argv[1] if len(sys.argv) > 1 else (REPO_TOKENS if os.path.isdir(REPO_TOKENS) else os.path.join(HERE, 'repo-tokens'))
os.makedirs(out, exist_ok=True)
def nest(pairs):
    root = {}
    for path, node in pairs:
        cur = root
        parts = path.split('/')
        for p in parts[:-1]: cur = cur.setdefault(p, {})
        cur[parts[-1]] = node
    return root
pr = nest([(n, {"$type": "color", "$value": h}) for n, h in primitives])
json.dump({"$description": "MondaPac primitives. Do not use directly in UI; use semantic tokens.", "color": pr}, open(out + '/primitives.json', 'w'), indent=2)
for theme, idx in (('light', 'light'), ('dark', 'dark')):
    body = nest([(c['name'], {"$type": "color", "$value": c[idx + 'Hex'] if c[idx] is None else "{color.%s}" % c[idx].replace('/', '.'), "$description": c['description']}) for c in spec['color']])
    json.dump({"$description": "MondaPac semantic colour, %s theme. Aliases point to primitives.json." % theme, "color": body}, open(out + '/color.%s.json' % theme, 'w'), indent=2)
for dens in ('desktop', 'touch'):
    body = nest([(d['name'], {"$type": "dimension", "$value": "%spx" % (d[dens] if d[dens] != int(d[dens]) else int(d[dens]))}) for d in spec['dimension']])
    json.dump({"$description": "MondaPac dimensions, %s density." % dens, **body}, open(out + '/dimension.%s.json' % dens, 'w'), indent=2)
typ = {}
for t in spec['type']:
    g, n = t['name'].split('/')
    typ.setdefault(g.lower(), {})[n.lower().replace(' ', '-')] = {"$type": "typography", "$value": {"fontFamily": t['family'], "fontWeight": {"Regular": 400, "Medium": 500, "SemiBold": 600, "Bold": 700}[t['style']], "fontSize": "%spx" % t['size'], "lineHeight": "%spx" % t['lineHeight'], "letterSpacing": "%spx" % t['letterSpacing']}}
json.dump({"$description": "MondaPac text styles (match Figma text styles).", "typography": typ}, open(out + '/typography.json', 'w'), indent=2)

# CSS: light default, dark via [data-theme="dark"], touch via [data-density="touch"]
def cssname(n): return '--mp-' + n.replace('/', '-')
lines = ["/* MondaPac design tokens v%s. Source of truth: the Figma file 'MondaPac Design System'." % spec['version'],
         " * Do not edit by hand. Change the Figma variables, run the plugin command Export tokens and commit these files. */", ":root {"]
for c in spec['color']: lines.append("  %s: %s;" % (cssname('color/' + c['name']), c['lightHex']))
for d in spec['dimension']:
    v = d['desktop']; lines.append("  %s: %spx;" % (cssname(d['name']), v if v != int(v) else int(v)))
lines.append("  --mp-font-family-sans: 'IBM Plex Sans', system-ui, sans-serif;\n  --mp-font-family-mono: 'IBM Plex Mono', ui-monospace, monospace;")
# Typography: one font shorthand per text style (+ tracking when not zero); uppercase is applied in components.
W = {"Regular": 400, "Medium": 500, "SemiBold": 600, "Bold": 700}
for t in spec['type']:
    g, n = t['name'].split('/'); key = g.lower() + '-' + n.lower().replace(' ', '-')
    fam = 'mono' if t['family'] == 'IBM Plex Mono' else 'sans'
    lines.append("  --mp-text-%s: %d %spx/%spx var(--mp-font-family-%s);" % (key, W[t['style']], t['size'], t['lineHeight'], fam))
    if t['letterSpacing']: lines.append("  --mp-text-%s-tracking: %spx;" % (key, t['letterSpacing']))
for k, v in MOTION.items(): lines.append("  %s: %dms;" % (cssname('motion/' + k), v))
lines.append("  --mp-motion-easing: cubic-bezier(0.2, 0, 0, 1);")
for e in spec['effects']:
    lines.append("  %s: %s;" % (cssname('shadow/' + e['name'].lower().replace(' ', '-')), ", ".join("%dpx %dpx %dpx %dpx rgba(%d,%d,%d,%s)" % (l['x'], l['y'], l['blur'], l['spread'], *l['rgba']) for l in e['layers'])))
lines.append("}\n\n[data-theme=\"dark\"] {")
for c in spec['color']: lines.append("  %s: %s;" % (cssname('color/' + c['name']), c['darkHex']))
DARK = {c['name']: c['darkHex'] for c in spec['color']}
def hexrgb(h): h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
for e in spec['effects']:
    if not any(l.get('token') for l in e['layers']): continue
    parts = []
    for l in e['layers']:
        r, g, b, a = l['rgba']
        if l.get('token'): r, g, b = hexrgb(DARK[l['token']])
        parts.append("%dpx %dpx %dpx %dpx rgba(%d,%d,%d,%s)" % (l['x'], l['y'], l['blur'], l['spread'], r, g, b, a))
    lines.append("  %s: %s;" % (cssname('shadow/' + e['name'].lower().replace(' ', '-')), ", ".join(parts)))
lines.append("}\n\n[data-density=\"touch\"] {")
for d in spec['dimension']:
    if d['touch'] != d['desktop']: lines.append("  %s: %spx;" % (cssname(d['name']), d['touch'] if d['touch'] != int(d['touch']) else int(d['touch'])))
lines.append("}")
open(out + '/tokens.css', 'w').write("\n".join(lines) + "\n")
print('wrote', out)
