// ---------------------------------------------------------------- icons
function recolor(node, token) {
  const p = paint(token);
  const all = node.findAll ? node.findAll(function (n) { return n.type === 'VECTOR' || n.type === 'ELLIPSE' || n.type === 'RECTANGLE' || n.type === 'BOOLEAN_OPERATION' || n.type === 'LINE'; }) : [];
  all.forEach(function (n) {
    if (n.strokes && n.strokes.length) n.strokes = [p];
    if (n.fills && n.fills.length) n.fills = [p];
  });
}
// One icon component plus its cell on the Icons page (used by the build and by "Update library").
function iconCell(n) {
  const node = figma.createNodeFromSvg(ICONS[n]);
  node.name = 'Icon/' + n;
  node.findAll(function () { return true; }).forEach(function (c) { if ('constraints' in c) c.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; });
  const comp = figma.createComponentFromNode(node);
  comp.name = 'Icon/' + n; comp.fills = [];
  comp.description = n.indexOf('product-') === 0 ? 'Product category glyph (placeholder until real product photos).' : 'Line icon, 24px grid drawn at 20px. Colour comes from icon/* or status tokens.';
  recolor(comp, 'icon/default');
  S.icons[n] = comp;
  return frame({ name: n, dir: 'V', gap: 'space/2', align: 'center', pad: 'space/3', w: 120, radius: 'radius/control', fill: 'bg/subtle' }, [comp, text(n, 'Caption/Default', 'text/muted', { align: 'center' })]);
}
async function buildIcons(page) {
  const wrap = frame({ name: 'Icons', dir: 'H', wrap: true, gap: 'space/4', rowGap: 'space/4', pad: 'space/6', fill: 'bg/surface', radius: 'radius/card', stroke: 'border/default', w: 1360 });
  const names = Object.keys(ICONS);
  for (let i = 0; i < names.length; i++) add(wrap, iconCell(names[i]));
  S.counts.components += names.length;
  return wrap;
}
function icon(name, token, size) {
  const c = S.icons[name]; if (!c) throw new Error('Unknown icon ' + name);
  const i = c.createInstance(); i.name = 'icon-' + name;
  if (size && size !== 20) i.resize(size, size);
  if (token && token !== 'icon/default') recolor(i, token);
  S.counts.instances++;
  return i;
}

// ---------------------------------------------------------------- variant sets
function combos(axes) {
  const keys = Object.keys(axes); let out = [{}];
  keys.forEach(function (k) { const next = []; out.forEach(function (o) { axes[k].forEach(function (v) { const c = Object.assign({}, o); c[k] = v; next.push(c); }); }); out = next; });
  return out;
}
// Find layers that belong to this component itself: descend into frames, but not into nested instances
// (layers inside a nested instance cannot carry this component's property references).
function ownFind(root, pred) {
  const out = [];
  (function walk(n) { (n.children || []).forEach(function (c) { if (pred(c)) out.push(c); if (c.type !== 'INSTANCE') walk(c); }); })(root);
  return out;
}
function variantName(p) { return Object.keys(p).map(function (k) { return k + '=' + p[k]; }).join(', '); }

/**
 * makeSet(name, axes, build, opts)
 *  axes: { Variant: [...], Size: [...] }   build(component, props) fills one variant
 *  opts.text: [{ prop, node, def }]  opts.bool: [{ prop, node, def }]  opts.swap: [{ prop, node, def }]
 *  opts.width: wrap width   opts.desc: component description   opts.skip(props) → true to skip a combination
 */
function makeSet(name, axes, build, opts) {
  opts = opts || {};
  const list = combos(axes).filter(function (p) { return !(opts.skip && opts.skip(p)); });
  const comps = list.map(function (p) {
    const c = figma.createComponent(); c.name = variantName(p); c.fills = [];
    build(c, p);
    return c;
  });
  const set = figma.combineAsVariants(comps, figma.currentPage);
  set.name = name; set.description = opts.desc || '';
  gridVariants(set, axes, opts);
  set.fills = [paint('bg/surface')];
  set.strokes = [{ type: 'SOLID', color: rgb('#9747FF') }]; set.dashPattern = [6, 4]; set.strokeWeight = 1; set.cornerRadius = 16;
  const keys = {};
  (opts.text || []).forEach(function (t) {
    const k = set.addComponentProperty(t.prop, 'TEXT', t.def); keys[t.prop] = k;
    set.children.forEach(function (c) { ownFind(c, function (n) { return n.type === 'TEXT' && n.name === t.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { characters: k }); }); });
  });
  (opts.bool || []).forEach(function (b) {
    const k = set.addComponentProperty(b.prop, 'BOOLEAN', b.def); keys[b.prop] = k;
    set.children.forEach(function (c) { ownFind(c, function (n) { return n.name === b.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { visible: k }); }); });
  });
  (opts.swap || []).forEach(function (s) {
    const def = S.icons[s.def];
    const k = set.addComponentProperty(s.prop, 'INSTANCE_SWAP', def.id); keys[s.prop] = k;
    set.children.forEach(function (c) { ownFind(c, function (n) { return n.type === 'INSTANCE' && n.name === s.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { mainComponent: k }); }); });
  });
  tag(set);
  S.sets[name] = { set: set, keys: keys, axes: Object.keys(axes) };
  S.counts.components++; S.counts.variants += comps.length;
  return set;
}
// Lay variants out as a grid: one column per value of the last axis (usually State), one row per
// combination of the other axes. Single-axis sets flow left to right and wrap at opts.width.
function gridVariants(set, axes, opts) {
  const keys = Object.keys(axes); const last = keys[keys.length - 1];
  const PAD = 32, GX = opts.gapX || 24, GY = opts.gapY || 24, MAXW = opts.width || 1040;
  const kids = set.children.slice();
  const cells = [];
  if (keys.length > 1) {
    const rowIndex = {}; let rows = 0;
    kids.forEach(function (c) {
      const vp = c.variantProperties; const rk = keys.slice(0, -1).map(function (k) { return vp[k]; }).join('|');
      if (rowIndex[rk] === undefined) rowIndex[rk] = rows++;
      cells.push({ node: c, row: rowIndex[rk], col: axes[last].indexOf(vp[last]) });
    });
  } else {
    let x = 0, row = 0, col = 0;
    kids.forEach(function (c) {
      if (col > 0 && x + c.width > MAXW - 2 * PAD) { row++; col = 0; x = 0; }
      cells.push({ node: c, row: row, col: col }); x += c.width + GX; col++;
    });
  }
  const colW = [], rowH = [];
  cells.forEach(function (k) { colW[k.col] = Math.max(colW[k.col] || 0, k.node.width); rowH[k.row] = Math.max(rowH[k.row] || 0, k.node.height); });
  const colX = [], rowY = []; let acc = PAD;
  for (let i = 0; i < colW.length; i++) { colX[i] = acc; acc += (colW[i] || 0) + GX; }
  const totalW = acc - GX + PAD; acc = PAD;
  for (let j = 0; j < rowH.length; j++) { rowY[j] = acc; acc += (rowH[j] || 0) + GY; }
  const totalH = acc - GY + PAD;
  set.layoutMode = 'NONE';
  cells.forEach(function (k) { k.node.x = colX[k.col]; k.node.y = rowY[k.row] + Math.round(((rowH[k.row] || 0) - k.node.height) / 2); });
  set.resize(Math.max(totalW, 120), Math.max(totalH, 80));
}
// Single component (no variants) with optional properties
function makeComponent(name, build, opts) {
  opts = opts || {};
  const c = figma.createComponent(); c.name = name; c.fills = [];
  build(c);
  c.description = opts.desc || '';
  const keys = {};
  (opts.text || []).forEach(function (t) {
    const k = c.addComponentProperty(t.prop, 'TEXT', t.def); keys[t.prop] = k;
    ownFind(c, function (n) { return n.type === 'TEXT' && n.name === t.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { characters: k }); });
  });
  (opts.bool || []).forEach(function (b) {
    const k = c.addComponentProperty(b.prop, 'BOOLEAN', b.def); keys[b.prop] = k;
    ownFind(c, function (n) { return n.name === b.node; }).forEach(function (n) { n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { visible: k }); });
  });
  tag(c);
  S.sets[name] = { comp: c, keys: keys, axes: [] };
  S.counts.components++;
  return c;
}
// Compose a component's body: c is the ComponentNode; o is the frame options; children nodes
function body(c, o, children) {
  c.layoutMode = o.dir === 'V' ? 'VERTICAL' : 'HORIZONTAL';
  c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'AUTO';
  applyBox(c, o);
  const p = o.pad; let pt, pr, pb, pl;
  if (Array.isArray(p)) { pt = p[0]; pr = p[1]; pb = p[2]; pl = p[3]; } else { pt = pr = pb = pl = p; }
  if (o.px !== undefined) { pl = pr = o.px; } if (o.py !== undefined) { pt = pb = o.py; }
  bindNum(c, 'paddingTop', pt); bindNum(c, 'paddingRight', pr); bindNum(c, 'paddingBottom', pb); bindNum(c, 'paddingLeft', pl);
  if (o.gap === 'auto') c.primaryAxisAlignItems = 'SPACE_BETWEEN'; else bindNum(c, 'itemSpacing', o.gap);
  if (o.align) c.counterAxisAlignItems = ALIGN[o.align];
  if (o.justify) c.primaryAxisAlignItems = JUSTIFY[o.justify];
  if (o.w !== undefined || o.h !== undefined) {
    c.resize(numVal(o.w !== undefined ? o.w : 100), numVal(o.h !== undefined ? o.h : 100));
    if (o.w === undefined) c.layoutSizingHorizontal = 'HUG';
    if (o.h === undefined) c.layoutSizingVertical = 'HUG';
    if (typeof o.h === 'string') c.setBoundVariable('height', dimVar(o.h));
    if (typeof o.w === 'string') c.setBoundVariable('width', dimVar(o.w));
  }
  if (o.wrap) { c.layoutWrap = 'WRAP'; if (o.rowGap !== undefined) bindNum(c, 'counterAxisSpacing', o.rowGap); }
  c.clipsContent = !!o.clip;
  (children || []).forEach(function (ch) { if (ch) add(c, ch); });
  return c;
}

// ---------------------------------------------------------------- instances
function inst(name, props, o) {
  props = props || {}; o = o || {};
  const rec = S.sets[name]; if (!rec) throw new Error('Unknown component ' + name);
  let comp = rec.comp;
  if (rec.set) {
    const want = {}; rec.axes.forEach(function (a) { if (props[a] !== undefined) want[a] = props[a]; });
    comp = rec.set.children.filter(function (c) { return Object.keys(want).every(function (a) { return c.variantProperties[a] === want[a]; }); })[0];
    if (!comp) throw new Error('No variant of ' + name + ' matching ' + JSON.stringify(want));
  }
  const i = comp.createInstance(); S.counts.instances++;
  const set = {};
  Object.keys(props).forEach(function (k) {
    if (rec.axes.indexOf(k) >= 0) return;
    const key = rec.keys[k]; if (!key) throw new Error('Unknown property ' + k + ' on ' + name);
    let v = props[k];
    if (v && typeof v === 'object' && v.icon) v = S.icons[v.icon].id;
    set[key] = v;
  });
  if (Object.keys(set).length) i.setProperties(set);
  if (o.name) i.name = o.name;
  setMeta(i, o);
  if (o.w) i.resize(o.w, i.height);
  return i;
}

// ---------------------------------------------------------------- documentation helpers
function para(str, w, color) { return text(str, 'Body/Default', color || 'text/secondary', { w: w || 640 }); }
function bullets(items, w) {
  return frame({ name: 'List', dir: 'V', gap: 'space/1-5' }, items.map(function (s) {
    return frame({ name: 'Item', dir: 'H', gap: 'space/2' }, [text('•', 'Body/Default', 'text/muted'), text(s, 'Body/Default', 'text/secondary', { w: (w || 360) - 16 })]);
  }));
}
function tableRow(r, widths, last) {
  return frame({ name: 'Row', dir: 'H', stroke: last ? null : 'border/row', sides: ['bottom'] }, r.map(function (cell, i) {
    if (cell && cell.type) { return frame({ name: 'Cell', dir: 'H', px: 'space/3', py: 'space/2', w: widths[i], align: 'center' }, [cell]); }
    return frame({ name: 'Cell', dir: 'H', px: 'space/3', py: 'space/2', w: widths[i] }, [text(String(cell), i === 0 ? 'Body/Medium' : 'Body/Small', i === 0 ? 'text/primary' : 'text/secondary', { w: widths[i] - 24 })]);
  }));
}
function table(cols, rows, widths) {
  const t = frame({ name: 'Table', dir: 'V', stroke: 'border/default', radius: 'radius/control', clip: true, fill: 'bg/surface' });
  add(t, frame({ name: 'Header', dir: 'H', fill: 'bg/subtle', stroke: 'border/default', sides: ['bottom'] }, cols.map(function (c, i) { return frame({ name: c, dir: 'H', px: 'space/3', py: 'space/2', w: widths[i] }, [text(c, 'Body/Small Strong', 'text/muted', { w: widths[i] - 24 })]); })));
  rows.forEach(function (r, ri) { add(t, tableRow(r, widths, ri === rows.length - 1)); });
  return t;
}
function pageShell(page, title, subtitle) {
  const root = frame({ name: title, dir: 'V', gap: 'space/10', pad: [64, 80, 96, 80], fill: 'bg/page', w: 1600 });
  add(root, frame({ name: 'Page header', dir: 'V', gap: 'space/3' }, [
    text('MondaPac Design System', 'Caption/Overline', 'text/link'),
    text(title, 'Display/Hero', 'text/primary'),
    subtitle ? para(subtitle, 960) : null,
  ]));
  page.appendChild(root); root.x = 0; root.y = 0;
  return root;
}
function docSection(root, title, desc) {
  const s = frame({ name: title, dir: 'V', gap: 'space/5', sizeH: 'FILL' }, [
    frame({ name: 'Section header', dir: 'V', gap: 'space/2', stroke: 'border/default', sides: ['top'], pad: [24, 0, 0, 0], sizeH: 'FILL' }, [
      text(title, 'Heading/H1', 'text/primary'), desc ? para(desc, 960) : null,
    ]),
  ]);
  add(root, s);
  return s;
}
// A component block: set (left) + doc panel (right)
function componentBlock(root, set, doc) {
  const section = docSection(root, doc.title, doc.summary);
  // Usage notes sit to the right of the set; when the set is wide they move below it as columns.
  const wide = set.width + 24 + 360 > 1440;
  const groups = [['When to use', doc.use], ['Properties', doc.props], ['Accessibility', doc.a11y], ['Avoid', doc.dont]].filter(function (g) { return g[1]; })
    .map(function (g) { return frame({ name: g[0], dir: 'V', gap: 'space/2', w: 312 }, [text(g[0], 'Heading/H2'), bullets(g[1], 312)]); });
  const panel = frame({ name: 'Usage', dir: wide ? 'H' : 'V', wrap: wide, gap: wide ? 'space/8' : 'space/4', rowGap: wide ? 'space/4' : undefined, pad: 'space/6', w: wide ? Math.min(1440, Math.max(set.width, 720)) : 360, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, groups);
  const row = frame({ name: 'Component + usage', dir: wide ? 'V' : 'H', gap: 'space/6', align: 'start' });
  row.appendChild(set);
  if (groups.length) add(row, panel); else panel.remove();
  add(section, row);
  return section;
}
