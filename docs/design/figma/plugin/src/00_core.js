// MondaPac Design System generator — Figma plugin (development plugin).
// Builds the complete MondaPac design system library in an empty Figma design file:
// variables (primitives → semantic, light/dark, desktop/touch), text and effect styles,
// icons, components with variants and properties, documentation pages and screen templates.
// Works on every Figma plan: when a collection cannot have a second mode (Starter plan),
// dark and touch values are created as parallel collections and can be merged later
// with the "Upgrade to modes" command.

/* eslint-disable no-undef */
const SPEC = __SPEC__;
const ICONS = __ICONS__;
const CONTRAST = __CONTRAST__;
const PLUGIN_TAG = 'mondapac-ds';

const S = {
  modes: { color: false, dim: false },
  prim: {}, color: {}, colorDark: {}, dim: {}, dimTouch: {}, typeVars: {},
  colls: {}, ts: {}, es: {}, icons: {}, sets: {}, pending: [], fonts: {}, report: [], counts: { components: 0, variants: 0, instances: 0 },
};
const HEX = {}; const DARKHEX = {};
SPEC.color.forEach(function (c) { HEX[c.name] = c.lightHex; DARKHEX[c.name] = c.darkHex; });
const DIM = {}; const TOUCH = {}; SPEC.dimension.forEach(function (d) { DIM[d.name] = d.desktop; TOUCH[d.name] = d.touch; });

function log(msg) { S.report.push(msg); }
async function safe(label, fn) {
  try { return await fn(); } catch (e) { log('⚠ ' + label + ': ' + (e && e.message ? e.message : String(e))); return null; }
}
function tag(node) { try { node.setPluginData(PLUGIN_TAG, '1'); } catch (e) { /* ignore */ } return node; }
function rgb(hex) { const h = hex.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 }; }
function rgba(hex, a) { const c = rgb(hex); c.a = a === undefined ? 1 : a; return c; }
function cssVar(prefix, name) { return 'var(--mp-' + (prefix ? prefix + '-' : '') + name.replace(/[\/\s]+/g, '-').toLowerCase() + ')'; }
async function flush() { const p = S.pending; S.pending = []; await Promise.all(p.map(function (x) { return x.catch(function (e) { log('⚠ style: ' + e.message); }); })); }

// ---------------------------------------------------------------- variables
function newCollection(name) { const c = figma.variables.createVariableCollection(name); S.colls[name] = c; return c; }
function tryAddMode(coll, name) { try { return coll.addMode(name); } catch (e) { return null; } }

// Adds one Dimension token to the collections described by S.dimModes (used by the build and by "Update library").
function addDimensionVariable(d) {
  const M = S.dimModes;
  const v = figma.variables.createVariable(d.name, M.collection, 'FLOAT');
  v.setValueForMode(M.desktop, d.desktop);
  if (M.touch) v.setValueForMode(M.touch, d.touch);
  v.scopes = d.scopes; v.setVariableCodeSyntax('WEB', cssVar('', d.name));
  S.dim[d.name] = v;
  if (M.touchCollection) {
    const t = figma.variables.createVariable(d.name, M.touchCollection, 'FLOAT');
    t.setValueForMode(M.touchAlt, d.touch); t.scopes = d.scopes; t.setVariableCodeSyntax('WEB', cssVar('', d.name));
    S.dimTouch[d.name] = t;
  }
}

// A colour value from #RRGGBB or #RRGGBBAA (the alpha byte becomes the colour's own alpha, e.g. bg/scrim).
function colorValue(hex) { const c = rgb(hex); if (hex.length > 7) c.a = parseInt(hex.slice(7, 9), 16) / 255; return c; }
// Adds one semantic colour token to the collections described by S.colorModes (used by the build and by "Update library").
// A token with a null light/dark primitive is a hex8 literal (alpha is part of the value), not an alias.
function addColorVariable(c) {
  const M = S.colorModes;
  function val(prim, hex) {
    if (!prim) return colorValue(hex);
    if (!S.prim[prim]) throw new Error('Primitive ' + prim + ' is missing for ' + c.name);
    return figma.variables.createVariableAlias(S.prim[prim]);
  }
  const v = figma.variables.createVariable(c.name, M.collection, 'COLOR');
  v.setValueForMode(M.light, val(c.light, c.lightHex));
  if (M.dark) v.setValueForMode(M.dark, val(c.dark, c.darkHex));
  v.scopes = c.scopes; v.description = c.description;
  v.setVariableCodeSyntax('WEB', cssVar('color', c.name));
  S.color[c.name] = v;
  if (M.darkCollection) {
    const d = figma.variables.createVariable(c.name, M.darkCollection, 'COLOR');
    d.setValueForMode(M.darkAlt, val(c.dark, c.darkHex));
    d.scopes = c.scopes; d.description = c.description + ' (dark)';
    d.setVariableCodeSyntax('WEB', cssVar('color', c.name));
    S.colorDark[c.name] = d;
  }
}

// Adds one primitive to the collection in S.primColl (used by the build and by "Update library", 1.7.0).
function addPrimitive(p) {
  const coll = S.primColl;
  const v = figma.variables.createVariable('color/' + p.name, coll, 'COLOR');
  v.setValueForMode(coll.modes[0].modeId, rgba(p.hex));
  v.scopes = [];
  v.description = p.hex + ' · step = 1000 × (1 − OKLab L)';
  S.prim[p.name] = v;
}

async function buildVariables() {
  // 1. Primitives (hidden from publishing, no scopes: designers use semantic tokens only)
  const prim = newCollection('Primitives');
  prim.renameMode(prim.modes[0].modeId, 'Value');
  await safe('hide primitives', function () { prim.hiddenFromPublishing = true; });
  S.primColl = prim;
  SPEC.primitives.forEach(addPrimitive);

  // 2. Semantic colour: Light + Dark (modes when the plan allows, otherwise a parallel collection)
  const color = newCollection('Color');
  color.renameMode(color.modes[0].modeId, 'Light');
  const lightMode = color.modes[0].modeId;
  const darkMode = tryAddMode(color, 'Dark');
  S.modes.color = !!darkMode;
  let dark = null; let darkModeAlt = null;
  if (!darkMode) {
    dark = newCollection('Color · Dark');
    dark.renameMode(dark.modes[0].modeId, 'Dark');
    darkModeAlt = dark.modes[0].modeId;
    log('ℹ Starter plan: one mode per collection. Dark values live in "Color · Dark". Run "Upgrade to modes" after upgrading the plan.');
  }
  S.colorModes = { collection: color, light: lightMode, dark: darkMode, darkCollection: dark, darkAlt: darkModeAlt };
  SPEC.color.forEach(addColorVariable);

  // 3. Dimension: Desktop + Touch density
  const dim = newCollection('Dimension');
  dim.renameMode(dim.modes[0].modeId, 'Desktop');
  const desk = dim.modes[0].modeId;
  const touch = tryAddMode(dim, 'Touch');
  S.modes.dim = !!touch;
  let dimT = null; let touchAlt = null;
  if (!touch) { dimT = newCollection('Dimension · Touch'); dimT.renameMode(dimT.modes[0].modeId, 'Touch'); touchAlt = dimT.modes[0].modeId; }
  S.dimModes = { collection: dim, desktop: desk, touch: touch, touchCollection: dimT, touchAlt: touchAlt };
  SPEC.dimension.forEach(addDimensionVariable);

  // 4. Typography variables (bound into text styles where the plan supports it)
  const ty = newCollection('Typography');
  ty.renameMode(ty.modes[0].modeId, 'Value');
  const tm = ty.modes[0].modeId;
  function tv(name, type, value, scopes) {
    const v = figma.variables.createVariable(name, ty, type); v.setValueForMode(tm, value); v.scopes = scopes;
    v.setVariableCodeSyntax('WEB', cssVar('font', name.replace(/^font\//, ''))); S.typeVars[name] = v; return v;
  }
  tv('font/family/sans', 'STRING', 'IBM Plex Sans', ['FONT_FAMILY']);
  tv('font/family/mono', 'STRING', 'IBM Plex Mono', ['FONT_FAMILY']);
  SPEC.type.forEach(function (t) {
    const key = t.name.toLowerCase().replace(/\s+/g, '-');
    if (!S.typeVars['font/size/' + key]) tv('font/size/' + key, 'FLOAT', t.size, ['FONT_SIZE']);
    if (!S.typeVars['font/line-height/' + key]) tv('font/line-height/' + key, 'FLOAT', t.lineHeight, ['LINE_HEIGHT']);
  });

  // 5. Motion (documentation + code syntax)
  const mo = newCollection('Motion');
  mo.renameMode(mo.modes[0].modeId, 'Value');
  Object.keys(SPEC.motion).forEach(function (k) {
    const v = figma.variables.createVariable(k, mo, 'FLOAT'); v.setValueForMode(mo.modes[0].modeId, SPEC.motion[k]); v.scopes = [];
    v.setVariableCodeSyntax('WEB', cssVar('motion', k)); v.description = SPEC.motion[k] + ' ms';
  });
  log('✓ Variables: ' + SPEC.primitives.length + ' primitives, ' + SPEC.color.length + ' colour tokens (light + dark), ' + SPEC.dimension.length + ' dimensions (desktop + touch).');
}

// ---------------------------------------------------------------- fonts & styles
const FONT_FALLBACK = { 'IBM Plex Sans': 'Inter', 'IBM Plex Mono': 'Roboto Mono' };
async function loadFonts() {
  const want = {};
  SPEC.type.forEach(function (t) { want[t.family + '|' + t.style] = { family: t.family, style: t.style }; });
  [['IBM Plex Sans', 'Regular'], ['IBM Plex Sans', 'Medium'], ['IBM Plex Sans', 'SemiBold'], ['IBM Plex Sans', 'Bold'], ['IBM Plex Mono', 'Regular'], ['IBM Plex Mono', 'Medium']]
    .forEach(function (f) { want[f[0] + '|' + f[1]] = { family: f[0], style: f[1] }; });
  const keys = Object.keys(want);
  for (let i = 0; i < keys.length; i++) {
    const f = want[keys[i]];
    const alt = f.style === 'SemiBold' ? 'Semi Bold' : (f.style === 'Semi Bold' ? 'SemiBold' : null);
    const fbFamily = FONT_FALLBACK[f.family] || 'Inter';
    const tries = [f, alt ? { family: f.family, style: alt } : null, { family: fbFamily, style: f.style === 'SemiBold' ? 'Semi Bold' : f.style }, { family: fbFamily, style: 'Regular' }].filter(Boolean);
    let ok = null;
    for (let j = 0; j < tries.length && !ok; j++) { try { await figma.loadFontAsync(tries[j]); ok = tries[j]; } catch (e) { /* try next */ } }
    if (!ok) throw new Error('No usable font for ' + f.family + ' ' + f.style);
    S.fonts[keys[i]] = ok;
    if (ok.family !== f.family) log('⚠ Font ' + f.family + ' ' + f.style + ' is not available; used ' + ok.family + ' ' + ok.style + '. Install IBM Plex and rebuild.');
  }
}
function font(family, style) { return S.fonts[family + '|' + style] || S.fonts['IBM Plex Sans|Regular']; }

// Binds the colour of each token layer of a spec effect. Figma's setBoundVariableForEffect returns the copy with spread 0
// (forum.figma.com/t/setboundvariableforeffect-bug/59788; the real file had Focus/Ring and Ring/Urgent at spread 0 until 1.8.4),
// so the spread is put back on the copy before the effects are set.
function bindEffectColours(layers, e) {
  return layers.map(function (fx, i) {
    const tk = e.layers[i].token;
    if (!tk) return fx;
    return Object.assign({}, figma.variables.setBoundVariableForEffect(fx, 'color', S.color[tk]), { spread: e.layers[i].spread });
  });
}
async function buildStyles() {
  // Font family variables hold the family actually loaded (fallback included), so bindings stay valid.
  const tm = S.colls.Typography.modes[0].modeId;
  S.typeVars['font/family/sans'].setValueForMode(tm, font('IBM Plex Sans', 'Regular').family);
  S.typeVars['font/family/mono'].setValueForMode(tm, font('IBM Plex Mono', 'Regular').family);
  for (let i = 0; i < SPEC.type.length; i++) {
    const t = SPEC.type[i];
    const st = figma.createTextStyle();
    st.name = t.name; st.fontName = font(t.family, t.style); st.fontSize = t.size;
    st.lineHeight = { unit: 'PIXELS', value: t.lineHeight };
    st.letterSpacing = { unit: 'PIXELS', value: t.letterSpacing || 0 };
    if (t.case === 'UPPER') st.textCase = 'UPPER';
    st.description = t.family + ' ' + t.style + ' · ' + t.size + '/' + t.lineHeight + (t.case ? ' · uppercase' : '');
    const key = t.name.toLowerCase().replace(/\s+/g, '-');
    await safe('bind type ' + t.name, function () {
      st.setBoundVariable('fontSize', S.typeVars['font/size/' + key]);
      st.setBoundVariable('lineHeight', S.typeVars['font/line-height/' + key]);
      st.setBoundVariable('fontFamily', S.typeVars[t.family === 'IBM Plex Mono' ? 'font/family/mono' : 'font/family/sans']);
    });
    tag(st); // 1.8.4: styles carry the plugin tag, so a later repair can tell them from a style of the same name made by hand
    S.ts[t.name] = st;
  }
  for (let ei = 0; ei < SPEC.effects.length; ei++) {
    const e = SPEC.effects[ei];
    const st = figma.createEffectStyle();
    st.name = e.name; st.description = e.description;
    const layers = e.layers.map(function (l) {
      return { type: 'DROP_SHADOW', color: { r: l.rgba[0] / 255, g: l.rgba[1] / 255, b: l.rgba[2] / 255, a: l.rgba[3] }, offset: { x: l.x, y: l.y }, radius: l.blur, spread: l.spread, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false };
    });
    st.effects = layers;
    // Focus and urgent rings take their colour from semantic variables, so they follow the theme.
    if (e.layers.some(function (l) { return l.token; })) {
      await safe('bind effect ' + e.name, function () { st.effects = bindEffectColours(layers, e); });
    }
    tag(st);
    S.es[e.name] = st;
  }
  log('✓ Styles: ' + SPEC.type.length + ' text styles, ' + SPEC.effects.length + ' effect styles.');
}

// ---------------------------------------------------------------- node DSL
// Figma nodes are not extensible, so layout intent (sizing, absolute position) waits in a side table until add().
const META = new Map();
function setMeta(node, o) { if (o.sizeH || o.sizeV || o.abs || o.xy || o.truncate) META.set(node.id, { sizeH: o.sizeH, sizeV: o.sizeV, abs: o.abs, xy: o.xy, truncate: o.truncate }); return node; }
function paint(token, opacity) {
  if (!token) return null;
  let p;
  if (token.charAt(0) === '#') { p = { type: 'SOLID', color: rgb(token) }; if (opacity !== undefined) p.opacity = opacity; return p; }
  const v = S.color[token]; if (!HEX[token]) throw new Error('Unknown colour token ' + token);
  p = figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(HEX[token]) }, 'color', v);
  // Binding returns a paint with opacity 1, so the opacity is applied after binding.
  if (opacity !== undefined) p.opacity = opacity;
  return p;
}
function numVal(v) { if (typeof v !== 'string') return v; const x = S.touch ? TOUCH[v] : DIM[v]; if (x === undefined) throw new Error('Unknown dimension token ' + v); return x; }
function dimVar(name) { const v = (S.touch && !S.modes.dim) ? S.dimTouch[name] : S.dim[name]; if (!v) throw new Error('Unknown dimension token ' + name); return v; }
function touchMode(node) { if (!S.touch) return; try { node.setPluginData('density', 'touch'); } catch (e) { /* ignore */ } if (S.modes.dim) node.setExplicitVariableModeForCollection(S.dimModes.collection, S.dimModes.touch); }
function bindNum(node, field, v) {
  if (v === undefined || v === null) return;
  node[field] = numVal(v);
  if (typeof v === 'string') node.setBoundVariable(field, dimVar(v));
}
function radius(node, r) {
  if (r === undefined || r === null) return;
  if (typeof r === 'string') { ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].forEach(function (f) { bindNum(node, f, r); }); }
  else node.cornerRadius = r;
}
const ALIGN = { start: 'MIN', center: 'CENTER', end: 'MAX', baseline: 'BASELINE' };
const JUSTIFY = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };

function applyBox(f, o) {
  f.fills = o.fill ? [paint(o.fill, o.fillOpacity)] : [];
  if (o.stroke) {
    f.strokes = [paint(o.stroke)]; f.strokeAlign = o.strokeAlign || 'INSIDE';
    if (o.sides) { const w = o.strokeW || 1; f.strokeTopWeight = o.sides.indexOf('top') >= 0 ? w : 0; f.strokeBottomWeight = o.sides.indexOf('bottom') >= 0 ? w : 0; f.strokeLeftWeight = o.sides.indexOf('left') >= 0 ? w : 0; f.strokeRightWeight = o.sides.indexOf('right') >= 0 ? w : 0; }
    else f.strokeWeight = o.strokeW || 1;
    if (o.dash) f.dashPattern = o.dash;
  }
  radius(f, o.radius);
  if (o.effect) { const es = S.es[o.effect]; if (es) S.pending.push(f.setEffectStyleIdAsync(es.id)); }
  if (o.opacity !== undefined) f.opacity = o.opacity;
}
function frame(o, children) {
  o = o || {};
  const f = figma.createFrame(); f.name = o.name || 'Frame';
  f.clipsContent = !!o.clip;
  applyBox(f, o);
  if (o.dir) {
    f.layoutMode = o.dir === 'H' ? 'HORIZONTAL' : 'VERTICAL';
    f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO';
    if (o.wrap && o.dir === 'H') { f.layoutWrap = 'WRAP'; if (o.rowGap !== undefined) bindNum(f, 'counterAxisSpacing', o.rowGap); }
    const p = o.pad; let pt, pr, pb, pl;
    if (Array.isArray(p)) { pt = p[0]; pr = p[1]; pb = p[2]; pl = p[3]; } else { pt = pr = pb = pl = p; }
    if (o.px !== undefined) { pl = pr = o.px; } if (o.py !== undefined) { pt = pb = o.py; }
    bindNum(f, 'paddingTop', pt); bindNum(f, 'paddingRight', pr); bindNum(f, 'paddingBottom', pb); bindNum(f, 'paddingLeft', pl);
    if (o.gap === 'auto') f.primaryAxisAlignItems = 'SPACE_BETWEEN'; else bindNum(f, 'itemSpacing', o.gap);
    if (o.align) f.counterAxisAlignItems = ALIGN[o.align];
    if (o.justify) f.primaryAxisAlignItems = JUSTIFY[o.justify];
    if (o.w !== undefined || o.h !== undefined) {
      f.resize(numVal(o.w !== undefined ? o.w : 100), numVal(o.h !== undefined ? o.h : 100));
      if (o.w === undefined) f.layoutSizingHorizontal = 'HUG';
      if (o.h === undefined) f.layoutSizingVertical = 'HUG';
      if (typeof o.w === 'string') f.setBoundVariable('width', dimVar(o.w));
      if (typeof o.h === 'string') f.setBoundVariable('height', dimVar(o.h));
    }
  } else {
    f.layoutMode = 'NONE';
    f.resize(numVal(o.w || 100), numVal(o.h || 100));
  }
  // A frame that will FILL its parent starts FIXED (not HUG): FILL children inside a HUG frame would
  // otherwise freeze it at their natural width. It takes the parent's size when add() applies FILL.
  if (o.dir) {
    const fw = o.sizeH === 'FILL' && o.w === undefined, fh = o.sizeV === 'FILL' && o.h === undefined;
    if (fw || fh) {
      f.resize(fw ? 10 : f.width, fh ? 10 : f.height);
      if (!fw && o.w === undefined) f.layoutSizingHorizontal = 'HUG';
      if (!fh && o.h === undefined) f.layoutSizingVertical = 'HUG';
    }
  }
  if (o.minW) f.minWidth = o.minW;
  setMeta(f, { sizeH: o.sizeH, sizeV: o.sizeV, abs: o.abs });
  (children || []).forEach(function (c) { if (c) add(f, c); });
  return f;
}
function add(parent, child) {
  parent.appendChild(child);
  const m = META.get(child.id) || {}; META.delete(child.id);
  if (m.abs) { child.layoutPositioning = 'ABSOLUTE'; child.x = m.abs[0]; child.y = m.abs[1]; }
  if (parent.layoutMode && parent.layoutMode !== 'NONE' && !m.abs) {
    if (m.sizeH) { child.layoutSizingHorizontal = m.sizeH; if (child.type === 'TEXT' && m.sizeH === 'FILL' && child.textAutoResize !== 'HEIGHT') child.textAutoResize = 'HEIGHT'; }
    // Changing sizing resets truncation in Figma; re-apply single-line truncation afterwards.
    if (child.type === 'TEXT' && m.truncate) { child.textTruncation = 'ENDING'; child.maxLines = 1; }
    if (m.sizeV) child.layoutSizingVertical = m.sizeV;
  } else if (m.xy) { child.x = m.xy[0]; child.y = m.xy[1]; }
  return child;
}
function text(str, style, color, o) {
  o = o || {};
  const t = figma.createText();
  const spec = SPEC.type.filter(function (x) { return x.name === style; })[0];
  if (!spec) throw new Error('Unknown text style ' + style);
  t.fontName = font(spec.family, spec.style); t.fontSize = spec.size;
  t.lineHeight = { unit: 'PIXELS', value: spec.lineHeight };
  if (spec.case === 'UPPER') t.textCase = 'UPPER';
  t.characters = String(str);
  S.pending.push(t.setTextStyleIdAsync(S.ts[style].id));
  t.fills = [paint(color || 'text/primary')];
  t.name = o.name || String(str).slice(0, 40);
  if (o.align) t.textAlignHorizontal = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' }[o.align];
  if (o.w) { t.resize(o.w, t.height); t.textAutoResize = 'HEIGHT'; }
  if (o.truncate) { t.textAutoResize = 'HEIGHT'; t.textTruncation = 'ENDING'; t.maxLines = 1; }
  if (o.strike) t.textDecoration = 'STRIKETHROUGH';
  if (o.underline) t.textDecoration = 'UNDERLINE';
  setMeta(t, o);
  return t;
}
function rect(o) {
  const r = figma.createRectangle(); r.name = o.name || 'Rect';
  r.resize(numVal(o.w), numVal(o.h)); r.fills = o.fill ? [paint(o.fill, o.fillOpacity)] : [];
  if (o.stroke) { r.strokes = [paint(o.stroke)]; r.strokeWeight = o.strokeW || 1; r.strokeAlign = 'INSIDE'; if (o.dash) r.dashPattern = o.dash; }
  radius(r, o.radius);
  if (typeof o.w === 'string') r.setBoundVariable('width', dimVar(o.w));
  if (typeof o.h === 'string') r.setBoundVariable('height', dimVar(o.h));
  setMeta(r, o);
  return r;
}
function ellipse(o) {
  const e = figma.createEllipse(); e.name = o.name || 'Ellipse'; e.resize(o.w, o.h || o.w);
  e.fills = o.fill ? [paint(o.fill, o.fillOpacity)] : [];
  if (o.stroke) { e.strokes = [paint(o.stroke)]; e.strokeWeight = o.strokeW || 1; e.strokeAlign = o.strokeAlign || 'INSIDE'; if (o.cap) e.strokeCap = o.cap; }
  if (o.arc) e.arcData = o.arc;
  setMeta(e, o);
  return e;
}
// Normalise an absolute path ("M x y L x y C … Q … Z") so its bounding box starts at 0,0; returns offset.
function normPath(d) {
  const t = d.replace(/,/g, ' ').trim().split(/\s+/);
  let minx = Infinity, miny = Infinity; const nums = [];
  for (let i = 0; i < t.length; i++) { if (/^[A-Za-z]$/.test(t[i])) continue; nums.push(i); }
  for (let j = 0; j + 1 < nums.length; j += 2) { minx = Math.min(minx, +t[nums[j]]); miny = Math.min(miny, +t[nums[j + 1]]); }
  for (let j = 0; j + 1 < nums.length; j += 2) { t[nums[j]] = String(+(+t[nums[j]] - minx).toFixed(2)); t[nums[j + 1]] = String(+(+t[nums[j + 1]] - miny).toFixed(2)); }
  return { d: t.join(' '), x: minx, y: miny };
}
function vector(o) {
  const v = figma.createVector(); v.name = o.name || 'Vector';
  const np = normPath(o.d);
  v.vectorPaths = [{ windingRule: o.closed ? 'NONZERO' : 'NONE', data: np.d }];
  if (o.xy) o.xy = [o.xy[0] + np.x, o.xy[1] + np.y]; else o.xy = [np.x, np.y];
  v.fills = o.fill ? [paint(o.fill, o.fillOpacity)] : [];
  v.strokes = o.stroke ? [paint(o.stroke)] : []; v.strokeWeight = o.strokeW || 2;
  v.strokeJoin = 'ROUND'; v.strokeCap = 'ROUND'; if (o.dash) v.dashPattern = o.dash;
  setMeta(v, o);
  return v;
}
function spacer(w, h) { const f = frame({ name: 'Spacer', w: w || 1, h: h || 1 }); f.fills = []; return f; }
