'use strict';
// Runs the plugin against the strict mock in several scenarios and audits the result.
const fs = require('fs');
const path = require('path');
const { makeFigma } = require('./mock');
const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'code.js'), 'utf8');
// Token files to compare with: the repo's docs/design/tokens, or repo-tokens/ next to the plugin.
const TOKENS = [path.join(ROOT, '..', '..', 'tokens'), path.join(ROOT, 'repo-tokens')].find((d) => fs.existsSync(path.join(d, 'tokens.css')));
const SPEC_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec.json'), 'utf8')).version;
let failures = 0;
process.on('unhandledRejection', (e) => { console.error('✕ UNHANDLED REJECTION', e && e.stack ? e.stack : e); failures++; });

function start(opts, code) {
  const M = makeFigma(opts);
  // Figma runs plugin code strictly: assigning unknown properties to nodes throws.
  new Function('figma', '__html__', '"use strict";\n' + (code || CODE))(M.figma, '<html></html>');
  return M;
}
async function send(M, msg) {
  M.OUT.messages.length = 0;
  await M.figma.ui.onmessage(msg);
  const err = M.OUT.messages.find((m) => m.type === 'error');
  const done = M.OUT.messages.find((m) => m.type === 'done' || m.type === 'export');
  return { err: err, done: done, all: M.OUT.messages.slice() };
}
function check(cond, label) { if (cond) console.log('  ✓ ' + label); else { console.log('  ✕ ' + label); failures++; } }
function pathOf(n) { const p = []; for (let x = n; x && x.type !== 'DOCUMENT'; x = x.parent) p.unshift(x.name); return p.join(' › '); }

function audit(M, label) {
  const pages = M.ROOT.children;
  const all = []; pages.forEach((p) => p.findAll(() => true).forEach((n) => all.push(n)));
  const by = {}; all.forEach((n) => { by[n.type] = (by[n.type] || 0) + 1; });
  console.log('  nodes ' + all.length + ' ' + JSON.stringify(by));
  console.log('  pages ' + pages.map((p) => p.name + '(' + p.children.length + ')').join(', '));
  const eff = (n) => { for (let x = n; x; x = x._src) if (x._style) return x._style; return null; };
  const noStyle = all.filter((n) => n.type === 'TEXT' && !eff(n));
  check(noStyle.length === 0, 'every text layer uses a text style (' + noStyle.length + ' without)' + (noStyle.length ? ': ' + noStyle.slice(0, 3).map(pathOf).join(' | ') : ''));
  const raw = [];
  all.forEach((n) => {
    ['_fills', '_strokes'].forEach((k) => (n[k] || []).forEach((p) => {
      if (p.boundVariables) return;
      if (n.type === 'COMPONENT_SET' && k === '_strokes') return; // Figma's purple variant frame
      raw.push(pathOf(n) + ' [' + k + ']');
    }));
  });
  check(raw.length === 0, 'every paint is bound to a variable (' + raw.length + ' raw)' + (raw.length ? ': ' + raw.slice(0, 5).join(' | ') : ''));
  // Variable scopes must match how each token is used, or designers cannot pick it in Figma.
  const need = {}; const where = {}; const kindOf = (n, k) => (k === '_strokes' ? 'STROKE_COLOR' : n.type === 'TEXT' ? 'TEXT_FILL' : ['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET', 'SECTION'].includes(n.type) ? 'FRAME_FILL' : 'SHAPE_FILL');
  all.forEach((n) => ['_fills', '_strokes'].forEach((k) => (n[k] || []).forEach((p) => {
    if (!p.boundVariables || / · (light|dark)$/.test(n.name)) return; // colour-page swatches show every token
    const v = M.VARS.get(p.boundVariables.color.id); if (!v || M.COLLS.get(v.variableCollectionId).name.indexOf('Color') !== 0) return;
    const sc = kindOf(n, k); const ok = v.scopes.includes('ALL_SCOPES') || v.scopes.includes(sc) || (sc !== 'STROKE_COLOR' && v.scopes.includes('ALL_FILLS'));
    if (!ok) { need[v.name] = need[v.name] || new Set(); need[v.name].add(sc); where[v.name + sc] = where[v.name + sc] || pathOf(n).split(' › ').slice(-3).join(' › ') + ' (' + n.type + ')'; }
  })));
  const miss = Object.keys(need).map((k) => k + ' needs ' + [...need[k]].map((sc) => sc + ' e.g. ' + where[k + sc]).join(' ; '));
  check(miss.length === 0, 'variable scopes cover every use (' + miss.length + ' tokens)' + (miss.length ? ':\n      ' + miss.join('\n      ') : ''));
  const area = all.find((n) => n.name === 'service-area');
  check(area && area._fills[0] && area._fills[0].opacity === 0.04, 'tinted fills keep their opacity after binding (service-area 4%)');
  const sets = all.filter((n) => n.type === 'COMPONENT_SET');
  const comps = all.filter((n) => n.type === 'COMPONENT' && n.parent.type !== 'COMPONENT_SET');
  console.log('  component sets ' + sets.length + ', standalone components ' + comps.length + ', variants ' + all.filter((n) => n.type === 'COMPONENT' && n.parent.type === 'COMPONENT_SET').length + ', instances ' + (by.INSTANCE || 0));
  const unused = [];
  sets.concat(comps).forEach((s) => {
    Object.keys(s._defs).forEach((k) => {
      const used = s.findAll((n) => { const r = n._refs; return r && (r.visible === k || r.characters === k || r.mainComponent === k); }).length;
      if (!used) unused.push(s.name + '.' + k.split('#')[0]);
    });
  });
  check(unused.length === 0, 'every component property is wired to a layer' + (unused.length ? ': ' + unused.join(', ') : ''));
  const noDesc = sets.concat(comps).filter((s) => !s.name.startsWith('Icon/') && !s.description);
  check(noDesc.length === 0, 'every component has a description' + (noDesc.length ? ': ' + noDesc.map((s) => s.name).join(', ') : ''));
  return { all: all, sets: sets, comps: comps.length, variants: all.filter((n) => n.type === 'COMPONENT' && n.parent.type === 'COMPONENT_SET').length };
}

function compareExport(files, label) {
  const dir = TOKENS;
  Object.keys(files).forEach((name) => {
    const want = fs.readFileSync(path.join(dir, name), 'utf8');
    const got = files[name];
    if (want === got) { check(true, label + ' ' + name + ' matches the repo token file'); return; }
    const a = want.split('\n'), b = got.split('\n'); let i = 0; while (i < a.length && a[i] === b[i]) i++;
    check(false, label + ' ' + name + ' differs at line ' + (i + 1) + ':\n      repo: ' + a[i] + '\n      figma: ' + b[i]);
  });
}


// ---- Update library: older files come from the released 1.6.0 plugin (test/fixtures/code-1.6.0.js, the code.js of
// commit 073501d), built in the mock and then switched to the current code. 1.0.0 and 1.5.0 files are simulated by
// taking the later additions out of that 1.6.0 build: 1.0.0 lacks everything from 1.5.0 and 1.6.0; 1.5.0 lacks the
// 1.6.0 items and still has the old loose phone topbar frame and the text/primary 50% scrim in its phone templates.
const OLD_CODE = fs.readFileSync(path.join(__dirname, 'fixtures', 'code-1.6.0.js'), 'utf8');
// The code.js of release 1.7.0 "Auth" (test/fixtures/code-1.7.0.js, copied before the 1.8.0 work): Update library of 1.8.0 refuses files below 1.7.0, so
// the older files are first brought to 1.7.0 with this plugin (the paths 1.7.0 supported), and then to 1.8.0 with the current code.
const CODE_170 = fs.readFileSync(path.join(__dirname, 'fixtures', 'code-1.7.0.js'), 'utf8');
function load(M, code) { new Function('figma', '__html__', '"use strict";\n' + code)(M.figma, '<html></html>'); return M; }
const NEW_TEMPLATES = ['Seller · Home (phone)', 'Seller · Menu open (phone)', 'Admin · Menu open (phone)'];
const SETS_150 = ['NavDrawer', 'BottomTabBar'];
const SETS_160 = ['PhoneTopbar'];
const NEW_170 = ['BrandMark', 'Field', 'ReasonQuote', 'Menu', 'MenuItem', 'AuthShowcase'];
const ICONS_170 = ['eye-off', 'lock', 'mail', 'key', 'user', 'log-out', 'copy', 'smartphone', 'trash'];
const S1_FRAMES = ['Seller · Your seller account · Awaiting approval', 'Seller · Your seller account · Changes needed', 'Seller · Your seller account · Not approved', 'Seller · Your seller account · Awaiting approval (phone)'];
const DARK_170 = ['Auth · Seller · A1 Sign in · Dark', 'Auth · Admin · A1 Sign in · Dark', 'Seller · Your seller account · Changes needed · Dark'];
const AUTH_FRAMES = 45; // 24 Seller and 17 Admin frames at 1280, 4 phone frames at 360
function allNodes(M) { const out = []; M.ROOT.children.forEach((p) => p.findAll(() => true).forEach((n) => out.push(n))); return out; }
function removeVars(M, collPrefix, names) { [...M.COLLS.values()].filter((c) => c.name.indexOf(collPrefix) === 0).forEach((c) => { c.variableIds.map((id) => M.VARS.get(id)).filter((v) => names.includes(v.name)).forEach((v) => v.remove()); }); }
function removeRows(M, texts) { allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && !n.removed && n.findOne((x) => x.type === 'TEXT' && texts.includes(x.characters))).forEach((n) => n.remove()); }
function removeSets(M, names) { allNodes(M).filter((n) => n.type === 'FRAME' && names.includes(n.name) && n.parent.name === 'Navigation & shell').forEach((n) => n.remove()); }
function removeMenuIcon(M) { allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'menu' && n.parent && n.parent.name === 'Icons').forEach((n) => n.remove()); }
function setCover(M, version) { const cover = allNodes(M).filter((n) => n.type === 'FRAME' && (n.name === 'Version' || n.name === 'Updated') && n.children.length === 2); cover.forEach((f) => { f.children[1].characters = f.name === 'Version' ? version : (version === '1.0.0' ? '1 Oct 2026' : f.children[1].characters); }); return cover.length; }
function downgradeTo10(M) {
  allNodes(M).filter((n) => n.type === 'FRAME' && NEW_TEMPLATES.includes(n.name) && !n.removed).forEach((n) => n.remove());
  removeSets(M, SETS_150.concat(SETS_160));
  removeVars(M, 'Dimension', ['size/bottom-bar', 'size/topbar-phone']);
  removeVars(M, 'Color', ['bg/scrim']);
  removeMenuIcon(M);
  removeRows(M, ['size/bottom-bar', 'size/topbar-phone', '1.5.0', '1.6.0']);
  const n = setCover(M, '1.0.0');
  M.ROOT.setPluginData('version', '1.0.0');
  return n;
}
// The 1.5.0 loose topbar: horizontal, 56 high, with the four layers the plugin named.
function legacyFrame(M) {
  const old = M.figma.createFrame(); old.name = 'Topbar · phone'; old.layoutMode = 'HORIZONTAL'; old.resize(360, 56);
  ['menu-button', 'panel-name', 'notifications', 'account-button'].forEach((n) => { const k = M.figma.createRectangle(); k.name = n; old.appendChild(k); });
  return old;
}
// A 1.5.0 file: PhoneTopbar instances become the old loose frame, scrims go back to text/primary at 50%.
function downgradeTo15(M) {
  const colorColl = [...M.COLLS.values()].find((c) => c.name === 'Color');
  const textPrimary = [...M.VARS.values()].find((v) => v.name === 'text/primary' && v.variableCollectionId === colorColl.id);
  const legacy = { ids: new Set(), frames: 0, scrims: [] };
  allNodes(M).filter((n) => n.type === 'FRAME' && NEW_TEMPLATES.includes(n.name)).forEach((scr) => {
    const tb = scr.children.find((c) => c.type === 'INSTANCE' && c.name === 'PhoneTopbar');
    const old = legacyFrame(M);
    scr.insertChild(0, old); tb.remove();
    legacy.ids.add(old.id); old.children.forEach((k) => legacy.ids.add(k.id)); legacy.frames++;
    const scrim = scr.children.find((c) => c.type === 'FRAME' && c.name === 'scrim');
    if (scrim) { const p = M.figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', textPrimary); p.opacity = 0.5; scrim.fills = [p]; legacy.scrims.push(scrim.id); }
  });
  const nd = allNodes(M).find((n) => n.type === 'COMPONENT_SET' && n.name === 'NavDrawer'); nd.description = nd.description.replace('scrim (bg/scrim; the scrim belongs', 'scrim (text/primary at 50%; the scrim belongs');
  removeSets(M, SETS_160);
  removeVars(M, 'Dimension', ['size/topbar-phone']);
  removeVars(M, 'Color', ['bg/scrim']);
  removeMenuIcon(M);
  removeRows(M, ['size/topbar-phone', '1.6.0']);
  setCover(M, '1.5.0');
  M.ROOT.setPluginData('version', '1.5.0');
  return legacy;
}
// An older library: built with the released 1.6.0 plugin, optionally taken back to 1.5.0 or 1.0.0, then the 1.7.0 plugin is loaded (it updates
// those files to 1.7.0). A 1.7.0 file is built by the 1.7.0 plugin itself. The caller loads the current code for the 1.8.0 step.
async function olderFile(opts, from) {
  if (from === '1.7.0') {
    const M = start(opts, CODE_170);
    const r = await send(M, { type: 'build' });
    check(!r.err, 'the 1.7.0 plugin builds the starting file' + (r.err ? ': ' + r.err.message : ''));
    return { M: M, legacy: null, coverFrames: 0 };
  }
  const M = start(opts, OLD_CODE);
  const r = await send(M, { type: 'build' });
  check(!r.err, 'the 1.6.0 plugin builds the starting file' + (r.err ? ': ' + r.err.message : ''));
  let legacy = null; let n = 0;
  if (from === '1.0.0') n = downgradeTo10(M);
  else if (from === '1.5.0') legacy = downgradeTo15(M);
  load(M, CODE_170);
  return { M: M, legacy: legacy, coverFrames: n };
}
function countNamed(M, type, name) { return allNodes(M).filter((n) => n.type === type && n.name === name).length; }
function textCount(M, str) { return allNodes(M).filter((n) => n.type === 'TEXT' && n.characters === str).length; }
const hex8 = (c) => '#' + [c.r, c.g, c.b].concat(c.a === undefined || c.a === 1 ? [] : [c.a]).map((x) => ('0' + Math.round(x * 255).toString(16)).slice(-2).toUpperCase()).join('');
const setOf = (M, name) => allNodes(M).find((n) => n.type === 'COMPONENT_SET' && n.name === name);
const compOf = (M, name) => allNodes(M).find((n) => n.type === 'COMPONENT' && n.name === name && n.parent.type !== 'COMPONENT_SET');
const keysOf = (node) => Object.keys(node.componentPropertyDefinitions).map((k) => k.split('#')[0]);
const hostNamed = (M, name) => M.ROOT.children.find((p) => p.name === name) || M.ROOT.children.map((p) => p.children.find((n) => n.type === 'SECTION' && n.name === name)).find(Boolean);

async function updateTo170(label, opts, from) {
  console.log('\n■ ' + label + ' · step 1: to 1.7.0 with the 1.7.0 plugin');
  const from10 = from === '1.0.0', from15 = from === '1.5.0', from16 = from === '1.6.0';
  const F = await olderFile(opts, from); const M = F.M; const legacy = F.legacy;
  if (from10) check(F.coverFrames === 2, 'simulated a 1.0.0 library (new sets, templates, tokens, icon, changelog rows and version removed)');
  if (from15) check(legacy.frames === 3 && legacy.scrims.length === 2, 'simulated a 1.5.0 library (3 loose topbar frames, 2 text/primary 50% scrims, no 1.6.0 items)');
  if (!from16) check(countNamed(M, 'COMPONENT_SET', 'PhoneTopbar') === 0 && allNodes(M).filter((n) => n.name === 'Icon/menu').length === 0 && ![...M.VARS.values()].some((v) => v.name === 'bg/scrim' || v.name === 'size/topbar-phone'), 'the file has none of the 1.6.0 items');
  if (from10) check(countNamed(M, 'COMPONENT_SET', 'NavDrawer') === 0 && countNamed(M, 'COMPONENT_SET', 'BottomTabBar') === 0 && !allNodes(M).some((n) => n.name === 'Seller · Home (phone)'), '1.0.0 library has none of the 1.5.0 items either');
  check(NEW_170.every((n) => !setOf(M, n) && !compOf(M, n)) && !hostNamed(M, 'Templates · Auth') && ![...M.VARS.values()].some((v) => v.name === 'bg/qr' || v.name === 'size/auth-card') && M.ROOT.getPluginData('version') === from, 'the ' + from + ' file has none of the 1.7.0 items');
  const nPages = M.ROOT.children.length;
  const vars = (name) => [...M.VARS.values()].filter((v) => v.name === name);
  const before = allNodes(M); const beforeIds = new Set(before.map((n) => n.id)); const nVars = M.VARS.size;
  // A table row gets its bottom divider when a row is added below it, so a Row's strokes (and their binding) are not compared.
  const snap = (n) => JSON.stringify([n.name, n.fills, n.name === 'Row' ? null : n.strokes, n.name === 'Row' ? null : n.boundVariables, n.type === 'TEXT' ? n.characters : null]);
  const beforeSnap = new Map(before.map((n) => [n.id, snap(n)]));
  const inputVariants = new Map(setOf(M, 'Input').children.map((c) => [c.id, c.name]));
  const oldSidebar = setOf(M, 'Sidebar'); const sidebarSnap = oldSidebar.findAll(() => true).map((n) => n.id + n.name).join();
  let r = await send(M, { type: 'update' });
  check(!r.err, 'Update library finished' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  if (r.done) console.log('    ' + r.done.report.join('\n    '));
  const warn = (r.done ? r.done.report : []).filter((l) => l.indexOf('⚠') === 0 || l.indexOf('ℹ skipped') === 0);
  check(warn.length === 0, 'no warnings or skips in the update report');
  const added = r.done ? r.done.added : [];
  check(countNamed(M, 'COMPONENT_SET', 'NavDrawer') === 1 && countNamed(M, 'COMPONENT_SET', 'BottomTabBar') === 1 && countNamed(M, 'COMPONENT_SET', 'PhoneTopbar') === 1, 'NavDrawer, BottomTabBar and PhoneTopbar exist once each');
  check(NEW_TEMPLATES.every((n) => allNodes(M).filter((x) => x.type === 'FRAME' && x.name === n).length === 1), 'the 3 phone templates exist once each');
  const nColl = opts.maxModes > 1 ? 1 : 2;
  const n15 = from10 ? 3 : (from15 ? 2 : 0); // bg/scrim, size/bottom-bar, size/topbar-phone
  const dc = [...M.COLLS.values()].find((c) => c.name === 'Dimension');
  [['size/bottom-bar', 64], ['size/topbar-phone', 56], ['size/auth-card', 400]].forEach(function (d) {
    const vs = vars(d[0]);
    check(vs.length === nColl && vs.every((v) => v.scopes.join() === 'WIDTH_HEIGHT' && v.codeSyntax.WEB === 'var(--mp-size-' + d[0].slice(5) + ')'), d[0] + ' exists in ' + nColl + ' Dimension collection(s) with scope and code syntax');
    const v0 = vs.find((v) => v.variableCollectionId === dc.id);
    check(v0 && dc.modes.every((m) => v0.valuesByMode[m.modeId] === d[1] || v0.valuesByMode[m.modeId] === undefined), d[0] + ' is ' + d[1] + ' in desktop and touch');
  });
  const sc = vars('bg/scrim');
  check(sc.length === nColl && sc.every((v) => v.scopes.join() === 'FRAME_FILL,SHAPE_FILL' && v.codeSyntax.WEB === 'var(--mp-color-bg-scrim)' && v.description.indexOf('Overlay behind drawers and modals; alpha is part of the value') === 0), 'bg/scrim exists in ' + nColl + ' Color collection(s) with scope, code syntax and description');
  const cc = [...M.COLLS.values()].find((c) => c.name === 'Color'); const cd = [...M.COLLS.values()].find((c) => c.name === 'Color · Dark');
  const valOf = (name) => { const vs = vars(name); const l = vs.find((v) => v.variableCollectionId === cc.id); const d = cd ? vs.find((v) => v.variableCollectionId === cd.id) : l; return [l.valuesByMode[cc.modes[0].modeId], d.valuesByMode[(cd || cc).modes[cd ? 0 : 1].modeId]]; };
  const resolve = (val) => { while (val && val.type === 'VARIABLE_ALIAS') { const t = M.VARS.get(val.id); val = t.valuesByMode[M.COLLS.get(t.variableCollectionId).modes[0].modeId]; } return val; };
  let lv = valOf('bg/scrim');
  check(lv[0].type !== 'VARIABLE_ALIAS' && hex8(lv[0]) === '#11182780' && lv[1].type !== 'VARIABLE_ALIAS' && hex8(lv[1]) === '#00000099', 'bg/scrim holds the hex8 literals #11182780 (light) and #00000099 (dark), not aliases');
  // 1.7.0 tokens: 2 primitives (Primitives has one collection), 5 colours and 1 dimension in each of nColl collections
  check(vars('color/blue/780').length === 1 && vars('color/teal/705').length === 1 && hex8(resolve(vars('color/blue/780')[0].valuesByMode[[...M.COLLS.values()].find((c) => c.name === 'Primitives').modes[0].modeId])) === '#0B1D2E', 'primitives blue/780 (#0B1D2E) and teal/705 added once');
  const want170 = { 'bg/qr': ['#FFFFFF', '#FFFFFF'], 'bg/auth-showcase-admin': ['#0B1D2E', '#0B1D2E'], 'bg/auth-showcase-seller': ['#06352E', '#06352E'], 'text/on-showcase': ['#FFFFFF', '#FFFFFF'], 'text/on-showcase-muted': ['#FFFFFFBD', '#FFFFFFBD'] };
  Object.keys(want170).forEach((name) => { lv = valOf(name).map(resolve); check(vars(name).length === nColl && hex8(lv[0]) === want170[name][0] && hex8(lv[1]) === want170[name][1], name + ' is ' + want170[name].join(' / ') + ' in ' + nColl + ' Color collection(s)'); });
  check(valOf('text/on-showcase-muted')[0].type !== 'VARIABLE_ALIAS', 'text/on-showcase-muted is a hex8 literal, not an alias');
  check(M.VARS.size === nVars + nColl * (n15 + 6) + 2, 'exactly ' + (nColl * (n15 + 6) + 2) + ' variables added (' + (M.VARS.size - nVars) + ')');
  check(allNodes(M).filter((n) => n.type === 'COMPONENT' && n.name === 'Icon/menu').length === 1 && ICONS_170.every((i) => allNodes(M).filter((n) => n.type === 'COMPONENT' && n.name === 'Icon/' + i).length === 1), 'icon menu and the 9 icons of 1.7.0 exist once each');
  const topbars = NEW_TEMPLATES.map((n) => allNodes(M).find((x) => x.type === 'FRAME' && x.name === n).children[0]);
  check(topbars.every((t) => t.type === 'INSTANCE' && t.name === 'PhoneTopbar') && !allNodes(M).some((n) => n.name === 'Topbar · phone'), 'every phone template starts with a PhoneTopbar instance and no loose topbar frame is left');
  const scrims = allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'scrim' && n.width === 360);
  const scrimV = sc.find((v) => v.variableCollectionId === cc.id);
  check(scrims.length === 2 && scrims.every((n) => n.fills.length === 1 && n.fills[0].boundVariables.color.id === scrimV.id && (n.fills[0].opacity === undefined || n.fills[0].opacity === 1)), 'both drawer scrims are bound to bg/scrim at 100% opacity');
  if (from15) {
    check(added.some((a) => a === 'bind drawer scrim to bg/scrim (2 templates)') && added.some((a) => a === 'swap phone topbar for PhoneTopbar (3 templates)'), 'the report names both in-place fixes');
    const ndesc = setOf(M, 'NavDrawer').description;
    check(added.includes('update NavDrawer scrim note') && ndesc.includes('scrim (bg/scrim; the scrim belongs') && !ndesc.includes('text/primary at 50%'), 'NavDrawer description scrim note updated in place and reported');
  } else check(!added.some((a) => /bind drawer scrim|swap phone topbar|NavDrawer scrim note/.test(a)), from + ' path has nothing of 1.5.0 to fix in place');
  // 1.7.0 components and additions to existing sets
  check(NEW_170.every((n) => (setOf(M, n) ? 1 : 0) + (compOf(M, n) ? 1 : 0) === 1 && countNamed(M, setOf(M, n) ? 'COMPONENT_SET' : 'COMPONENT', n) === 1), 'BrandMark, Field, ReasonQuote, Menu, MenuItem and AuthShowcase exist once each');
  check(NEW_170.every((n) => added.includes('component ' + n)), 'the report names each new component');
  const btn = setOf(M, 'Button'), inp = setOf(M, 'Input'), ck = setOf(M, 'ChecklistItem'), tb = setOf(M, 'Topbar');
  check(btn.children.length === 75 && btn.children.filter((c) => /Variant=Link/.test(c.name)).length === 15 && btn.children.filter((c) => /State=Loading/.test(c.name)).length === 15, 'Button has 75 variants: Link (15) and Loading (15) added');
  check(inp.children.length === 18 && inp.children.every((c) => /^Type=(Text|Password|Code), State=/.test(c.name)), 'Input has 18 variants, all named Type=…, State=…');
  check([...inputVariants.keys()].every((id) => M.byId.has(id) && M.byId.get(id).name === 'Type=Text, ' + inputVariants.get(id)), 'the 6 existing Input variants are kept and only named Type=Text');
  check(ck.children.length === 4 && ['Show actions', 'Action'].every((k) => keysOf(ck).includes(k)), 'ChecklistItem has Waiting and Needs attention, Show actions and Action');
  check(['Show search', 'Show notifications'].every((k) => keysOf(tb).includes(k)) && tb.children.every((v) => ['search', 'notifications'].every((nm) => { const n = v.findOne((x) => x.name === nm); return n && n.componentPropertyReferences && n.componentPropertyReferences.visible; })), 'Topbar has Show search and Show notifications, wired in both variants');
  check(['Button', 'Input', 'ChecklistItem', 'Topbar'].every((n) => added.includes('update ' + n + ' description')), 'the descriptions of Button, Input, ChecklistItem and Topbar take the 1.7.0 text');
  check(setOf(M, 'Sidebar') === oldSidebar && oldSidebar.findAll(() => true).map((n) => n.id + n.name).join() === sidebarSnap && !oldSidebar.findOne((n) => n.type === 'INSTANCE' && n.name === 'brand-mark'), 'the existing Sidebar is not rebuilt (it keeps its drawn brand mark)');
  const auth = hostNamed(M, 'Templates · Auth');
  check(auth && auth.children.filter((n) => n.type === 'FRAME' && n.getPluginData('mondapac-ds') === '1' && /^Auth · /.test(n.name)).length === AUTH_FRAMES, 'Templates · Auth has the ' + AUTH_FRAMES + ' Auth frames');
  if (opts.maxModes > 1) check(M.ROOT.children.length === nPages + 1 && M.ROOT.children.indexOf(auth) === M.ROOT.children.findIndex((p) => p.name === 'Templates · Seller') + 1, 'a Templates · Auth page is added after Templates · Seller');
  else check(M.ROOT.children.length === 3 && auth.type === 'SECTION' && auth.parent.name === '3 · Templates & workspace', 'a Templates · Auth section is added to the templates page (Starter)');
  check(S1_FRAMES.every((n) => countNamed(M, 'FRAME', n) === 1) && DARK_170.every((n) => countNamed(M, 'FRAME', n) === 1 && allNodes(M).find((x) => x.name === n).getPluginData('theme') === 'dark'), 'the 4 S1 frames and the 3 new dark previews exist once each');
  check(textCount(M, '1.7.0') >= 2 && allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && n.findOne((x) => x.type === 'TEXT' && x.characters === '1.7.0')).length === 1, 'one changelog row for ' + '1.7.0' + ' (and the cover shows it)');
  check(allNodes(M).some((n) => n.type === 'TEXT' && n.characters.indexOf('Auth (planned as 1.1.0 in identity ux.md 8.1).') === 0), 'the 1.7.0 changelog row starts "Auth (planned as 1.1.0 in identity ux.md 8.1)."');
  check(['1.5.0', '1.6.0'].every((v) => allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && n.findOne((x) => x.type === 'TEXT' && x.characters === v)).length === 1), 'one changelog row each for 1.5.0 and 1.6.0');
  check(['size/topbar-phone', 'size/auth-card'].every((v) => allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && n.findOne((x) => x.type === 'TEXT' && x.characters === v)).length === 1), 'one size table row each for size/topbar-phone and size/auth-card');
  check(M.ROOT.getPluginData('version') === '1.7.0', 'file version is ' + '1.7.0');
  const after = allNodes(M);
  const gone = before.filter((n) => n.removed || !M.byId.has(n.id));
  if (from15) check(gone.length === legacy.ids.size && gone.length === 15 && gone.every((n) => legacy.ids.has(n.id)), 'the only deletions are the 3 old phone topbar frames and their layers (' + gone.length + ')');
  else check(gone.length === 0, 'no existing node was deleted or replaced (' + gone.length + ')');
  const scrimIds = new Set(legacy ? legacy.scrims : []);
  const changed = before.filter((n) => M.byId.has(n.id) && !scrimIds.has(n.id) && !inputVariants.has(n.id) && snap(n) !== beforeSnap.get(n.id) && !(n.type === 'TEXT' && (n.characters.indexOf('1.7.0') >= 0 || /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(n.characters))));
  check(changed.length === 0, 'no existing node changed its name, paints, bindings or text, apart from the cover version and date, the Input variant names' + (legacy ? ' and the 2 scrims' : '') + ' (' + changed.length + (changed.length ? ': ' + changed.slice(0, 5).map((n) => n.name).join(', ') : '') + ')');
  const fresh = after.filter((n) => !beforeIds.has(n.id));
  const tops = fresh.filter((n) => n.parent && beforeIds.has(n.parent.id)).map((n) => n.name);
  const okTops = new Set((from10 ? NEW_TEMPLATES.concat(SETS_150) : []).concat(from16 ? [] : SETS_160, from16 ? [] : ['menu'], ['Row'], ICONS_170, S1_FRAMES, DARK_170, ['BrandMark', 'Menu · MenuItem', 'AuthShowcase', 'ReasonQuote', 'Field', 'Templates · Auth']));
  const stray = tops.filter((n) => !okTops.has(n) && !/^(Variant|Type|State)=/.test(n));
  check(stray.length === 0, 'new layers sit only in the expected places (' + tops.length + ' roots' + (stray.length ? '; unexpected: ' + stray.join(', ') : '') + ')');
  check(after.length === before.length - gone.length + fresh.length, 'existing node count otherwise unchanged (' + before.length + ' - ' + gone.length + ' + ' + fresh.length + ' = ' + after.length + ')');
  const a = audit(M, label);
  check(a.sets.length === 35 && a.comps === 83 && a.variants === 295, 'the updated file has the same components as a new 1.7.0 build (35 sets, 83 standalone components, 295 variants)');
  const ar = await send(M, { type: 'audit' });
  const bad = ar.done ? ar.done.report.filter((l) => l.indexOf('⚠') === 0) : ['no audit'];
  check(bad.length === 0, 'Audit file has zero warnings after the update' + (bad.length ? ': ' + bad.join(' | ') : ''));
  // both themes: switch a phone template and an Auth frame to dark and check no paint is left on the light collection
  for (const name of ['Seller · Menu open (phone)', 'Auth · Seller · A2 Sign up']) {
    const src = allNodes(M).find((n) => n.type === 'FRAME' && n.name === name);
    const clone = src.clone(); clone.name = 'tmp dark';
    await M.figma.setCurrentPageAsync(clone.page()); M.figma.currentPage.selection = [clone];
    r = await send(M, { type: 'theme', theme: 'dark' });
    const lightColl = [...M.COLLS.values()].find((c) => c.name === 'Color');
    const leaks = [clone].concat(clone.findAll(() => true)).filter((n) => (n._fills || []).concat(n._strokes || []).some((p) => p.boundVariables && !n.instAncestor() && M.VARS.get(p.boundVariables.color.id).variableCollectionId === lightColl.id && !M.COLLS.get(lightColl.id).modes[1]));
    check(!r.err, 'Dark theme applies to ' + name + (r.err ? ': ' + r.err.message : ''));
    check(leaks.length === 0 || lightColl.modes.length > 1, 'dark copy of ' + name + ' uses only dark variables (' + leaks.length + ' light leftovers)');
    clone.remove();
  }
  // second run is a no-op
  const ids2 = new Set(after.filter((n) => !n.removed).map((n) => n.id)); const vars2 = M.VARS.size; const n2 = allNodes(M).length;
  r = await send(M, { type: 'update' });
  check(!r.err && r.done && r.done.added.length === 0, 'second Update library adds nothing' + (r.err ? ': ' + r.err.message : (r.done && r.done.added.length ? ': ' + r.done.added.join(', ') : '')));
  const after2 = allNodes(M);
  check(after2.length === n2 && after2.every((n) => ids2.has(n.id)) && M.VARS.size === vars2, 'second Update library changes no layer and no variable');
  return M;
}

// ---- Release 1.8.0 "Panel": what a new build and an updated file must both hold
const NEW_180 = ['Select', 'Textarea', 'CheckboxRow', 'Toast', 'DialogBody', 'Dialog', 'EmptyState'];
const VARIANTS_180 = { Select: 7, Textarea: 6, CheckboxRow: 10, Toast: 2, Dialog: 6, EmptyState: 3 };
const BODIES_180 = ['Template body · D1 Invite (Admin)', 'Template body · D1 Invite (Admin, list open)', 'Template body · D2 Change role (Admin)', 'Template body · D1 Invite (Seller)', 'Template body · D2 Change role (Seller)'];
const ADMIN_180 = ['Shared · Members · Admin', 'Shared · Members · Admin · Menu open', 'Shared · Members · Admin · Loading', 'Shared · Members · Admin · Load error', 'Shared · Members · Admin · View only',
  'Shared · Roles · Admin', 'Shared · Roles · Admin · No custom roles', 'Shared · No access · Admin', 'Shared · Account security · Admin', 'Shared · Account security · Admin · Errors',
  'Dialogs · Members · Admin', 'Dialogs · Confirm · Admin', 'Shared · Members · Admin (phone)', 'Shared · Not found · Admin (phone)', 'Dialog sheet · Change role (phone)'];
const SELLER_180 = ['Shared · Members · Seller', 'Shared · Members · Seller · Empty', 'Shared · Members · Seller · Loading', 'Shared · Members · Seller · Load error', 'Shared · Roles · Seller', 'Shared · Roles · Seller · No custom roles',
  'Shared · No access · Seller', 'Shared · Not found', 'Shared · Account security · Seller · Off', 'Shared · Account security · Seller · Link sent', 'Shared · Account security · Seller · On', 'Shared · Account security · Seller · Saved',
  'Dialogs · Team · Seller', 'Shared · Members · Seller (phone)', 'Shared · Roles · Seller (phone)', 'Shared · No access · Seller (phone)', 'Shared · Account security · Seller (phone)', 'Dialog sheet · Remove from team (phone)'];
const VIEW_ONLY_COPY = 'Your role can view people and roles but not change them.';
const FIELD_DESC_17 = 'Select or Textarea from 1.2.0';
let BUILD_COUNTS = null; // sets, standalone components and variants of a new 1.8.0 build (scenario 1); an updated file must match

const frameNamed = (M, name) => allNodes(M).filter((n) => n.type === 'FRAME' && n.name === name && n.getPluginData('mondapac-ds') === '1');
const instMain = (n) => (n._main ? n._main.name : '');
const tcVariants = (M) => setOf(M, 'TableCell').children;

// Facts that hold for every 1.8.0 file, built new or updated.
function state180(M, opts, label) {
  const nColl = opts.maxModes > 1 ? 1 : 2;
  const vars = (name) => [...M.VARS.values()].filter((v) => v.name === name);
  const dc = [...M.COLLS.values()].find((c) => c.name === 'Dimension');
  // Every component block fits the 1440 px page: the set is at most 1440 wide, the row and the Usage panel are laid out
  // for the set's width (real-Figma Audit after 1.7.0 found Input and AuthShowcase sticking out of their sections).
  const blocks = allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Component + usage' && n.children[0] && n.children[0].type === 'COMPONENT_SET');
  const misfit = blocks.filter((r) => {
    const set = r.children[0]; const wide = set.width + 24 + 360 > 1440; const panel = r.children.find((c) => c.name === 'Usage');
    return set.width > 1440 || r.layoutMode !== (wide ? 'VERTICAL' : 'HORIZONTAL') || (panel && (panel.layoutMode !== (wide ? 'HORIZONTAL' : 'VERTICAL') || Math.round(panel.width) !== (wide ? Math.min(1440, Math.max(Math.round(set.width), 720)) : 360)));
  }).map((r) => r.children[0].name);
  check(blocks.length > 20 && misfit.length === 0, label + ': all ' + blocks.length + ' component blocks fit the 1440 px page' + (misfit.length ? ' (not: ' + misfit.join(', ') + ')' : ''));
  // Starter layout: no two library sections on a page overlap (owner's file had page 3 sections on top of each other after updates).
  const secOver = [];
  M.ROOT.children.filter((pg) => pg.getPluginData('layout') === 'compact').forEach((pg) => {
    const ss = pg.children.filter((n) => n.type === 'SECTION');
    ss.forEach((a, i) => ss.slice(i + 1).forEach((b) => { if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) secOver.push(a.name + ' / ' + b.name); }));
  });
  check(secOver.length === 0, label + ': no two sections on a Starter page overlap' + (secOver.length ? ' (' + secOver.join(', ') + ')' : ''));
  check(['Input', 'AuthShowcase'].every((n) => setOf(M, n).width <= 1440) && setOf(M, 'Input').children.every((c) => setOf(M, 'Input').children.filter((k) => Math.abs(k.x - c.x) < 0.5).every((k) => k.variantProperties.Type === c.variantProperties.Type)), label + ': Input has one column per Type and AuthShowcase one variant per row (' + Math.round(setOf(M, 'Input').width) + ' and ' + Math.round(setOf(M, 'AuthShowcase').width) + ' px wide)');
  [['size/dialog-sm', 400], ['size/dialog-md', 560]].forEach((d) => {
    const vs = vars(d[0]); const v0 = vs.find((v) => v.variableCollectionId === dc.id);
    check(vs.length === nColl && vs.every((v) => v.scopes.join() === 'WIDTH_HEIGHT' && v.codeSyntax.WEB === 'var(--mp-' + d[0].replace('/', '-') + ')') && v0 && dc.modes.every((m) => v0.valuesByMode[m.modeId] === d[1] || v0.valuesByMode[m.modeId] === undefined), label + ': ' + d[0] + ' is ' + d[1] + ' (desktop and touch) with scope WIDTH_HEIGHT and code syntax');
  });
  check(NEW_180.every((n) => (setOf(M, n) ? 1 : 0) + (compOf(M, n) ? 1 : 0) === 1 && countNamed(M, setOf(M, n) ? 'COMPONENT_SET' : 'COMPONENT', n) === 1), label + ': Select, Textarea, CheckboxRow, Toast, DialogBody, Dialog and EmptyState exist once each');
  check(Object.keys(VARIANTS_180).every((n) => setOf(M, n).children.length === VARIANTS_180[n]), label + ': variant counts ' + Object.keys(VARIANTS_180).map((n) => n + ' ' + VARIANTS_180[n]).join(', '));
  const dlgSet = setOf(M, 'Dialog');
  check(dlgSet.children.map((c) => c.name).sort().join('|') === ['Size=Sm, Tone=Default, Layout=Centred', 'Size=Sm, Tone=Destructive, Layout=Centred', 'Size=Md, Tone=Default, Layout=Centred', 'Size=Md, Tone=Destructive, Layout=Centred', 'Size=Sm, Tone=Default, Layout=Sheet', 'Size=Sm, Tone=Destructive, Layout=Sheet'].sort().join('|'), label + ': Dialog has Centred by Sm and Md by Default and Destructive, and Sheet by Default and Destructive (no Sheet by Md)');
  const dk = keysOf(dlgSet);
  check(['Title', 'Show secondary', 'Content'].every((k) => dk.includes(k)) && dlgSet.children.every((c) => c.findOne((n) => n.name === 'title' && n.componentPropertyReferences && n.componentPropertyReferences.characters) && c.findOne((n) => n.name === 'content' && n.componentPropertyReferences && n.componentPropertyReferences.mainComponent) && c.findOne((n) => n.name === 'secondary' && n.componentPropertyReferences && n.componentPropertyReferences.visible) && c.findOne((n) => n.name === 'primary').isExposedInstance && c.findOne((n) => n.name === 'secondary').isExposedInstance), label + ': Dialog Title, Show secondary and Content are wired in all 6 variants, and primary and secondary are exposed Buttons');
  const contentKey = Object.keys(dlgSet.componentPropertyDefinitions).find((k) => k.split('#')[0] === 'Content');
  check(dlgSet.componentPropertyDefinitions.Size.variantOptions.join() === 'Sm,Md' && compOf(M, 'DialogBody') && dlgSet.componentPropertyDefinitions[contentKey].defaultValue === compOf(M, 'DialogBody').id, label + ': the Dialog Content slot defaults to DialogBody');
  const sheet = dlgSet.children.find((c) => /Layout=Sheet/.test(c.name));
  check(sheet.width === 360 && sheet.topLeftRadius > 0 && sheet.bottomLeftRadius === 0 && sheet.findOne((n) => n.name === 'footer').children.map((n) => n.name).join() === 'primary,secondary' && dlgSet.children.find((c) => /Layout=Centred/.test(c.name)).findOne((n) => n.name === 'footer').children.map((n) => n.name).join() === 'secondary,primary', label + ': the Sheet is 360 wide with square bottom corners and the primary button first; the Centred footer has Cancel first');
  const wOf = (name) => dlgSet.children.find((c) => c.name === name).width;
  check(wOf('Size=Sm, Tone=Default, Layout=Centred') === 400 && wOf('Size=Md, Tone=Default, Layout=Centred') === 560 && dlgSet.children.find((c) => /Size=Md, Tone=Default/.test(c.name)).boundVariables.width && dlgSet.children.find((c) => /Size=Md, Tone=Default/.test(c.name)).boundVariables.width.id === vars('size/dialog-md')[0].id, label + ': Dialog Sm is 400 and Md is 560 wide, bound to size/dialog-sm and size/dialog-md');
  const ts = setOf(M, 'Toast');
  check(ts.children.every((c) => c.width === 400 && c.boundVariables.width && c.findOne((n) => n.name === 'action').visible === false) && keysOf(ts).join() === ['Message', 'Action', 'Show action', 'Tone'].filter((k) => keysOf(ts).includes(k)).join(), label + ': Toast is size/dialog-sm wide and its action is off');
  // TableCell State=Loading
  const tc = setOf(M, 'TableCell');
  const loading = tc.children.filter((c) => /State=Loading/.test(c.name));
  check(tc.children.length === 16 && loading.length === 5 && !tc.children.some((c) => c.name === 'Type=Header, State=Loading') && tc.componentPropertyDefinitions.State.variantOptions.join() === 'Default,Selected,Loading', label + ': TableCell has 16 variants, 5 of them State=Loading (no Header), and State reads Default, Selected, Loading');
  const same = loading.every((l) => { const d = tc.children.find((c) => c.name === l.name.replace('Loading', 'Default')); return d && d.width === l.width && d.height === l.height && l.fills.length === 1 && l.fills[0].boundVariables.color.id === d.fills[0].boundVariables.color.id && JSON.stringify(l.strokes.map((p) => p.boundVariables.color.id)) === JSON.stringify(d.strokes.map((p) => p.boundVariables.color.id)) && l.strokeBottomWeight === d.strokeBottomWeight; });
  const muted = M.VARS.get([...M.VARS.values()].find((v) => v.name === 'bg/muted' && v.variableCollectionId === [...M.COLLS.values()].find((c) => c.name === 'Color').id).id);
  const shapes = loading.every((l) => { const sh = l.findAll((n) => n.type !== 'FRAME' || n.name !== 'lines'); return sh.length > 0 && sh.every((n) => n.type === 'RECTANGLE' && n.fills.length === 1 && n.fills[0].boundVariables.color.id === muted.id) && !l.findOne((n) => n.type === 'TEXT'); });
  check(same && shapes, label + ': each Loading variant has the size, fill and bottom border of its Default and only bg/muted rectangles (no text)');
  const two = loading.find((l) => /Two-line/.test(l.name)).findAll((n) => n.type === 'RECTANGLE');
  check(two.length === 2 && two[0].layoutSizingHorizontal === 'FILL' && two[1].width === 72 && loading.find((l) => /Actions/.test(l.name)).findOne((n) => n.type === 'RECTANGLE').width === 18 && loading.find((l) => /Number/.test(l.name)).findOne((n) => n.type === 'RECTANGLE').width === 40, label + ': skeleton shapes follow the spec (two-line: FILL bar and a 72 px bar; number 40 px; actions a 18 px circle)');
  check(tc.description.includes('Loading shows skeleton bars; build rows from it for 8 skeleton rows'), label + ': the TableCell description explains Loading');
  // Field Control: Input, Select and Textarea as preferred swap values
  const fld = compOf(M, 'Field'); const ck = Object.keys(fld.componentPropertyDefinitions).find((k) => k.split('#')[0] === 'Control');
  const pv = (fld.componentPropertyDefinitions[ck].preferredValues || []).map((x) => x.key).sort().join();
  check(pv === ['Input', 'Select', 'Textarea'].map((n) => setOf(M, n).key).sort().join() && fld.description.includes('Select or Textarea from 1.8.0'), label + ': the Field Control slot lists Input, Select and Textarea as preferred values; the description says 1.8.0');
  check(!fld.description.includes(FIELD_DESC_17), label + ': Field no longer says "from 1.2.0"');
  // templates
  const admin = hostNamed(M, 'Templates · Admin'), seller = hostNamed(M, 'Templates · Seller');
  const once = (host, names) => names.every((n) => host.children.filter((c) => c.type === 'FRAME' && c.name === n && c.getPluginData('mondapac-ds') === '1').length === 1);
  check(once(admin, ADMIN_180) && once(seller, SELLER_180), label + ': the ' + ADMIN_180.length + ' Admin and ' + SELLER_180.length + ' Seller Panel frames exist once each on the right templates host');
  check(BODIES_180.every((n) => countNamed(M, 'COMPONENT', n) === 1 && compOf(M, n).description.indexOf('Template body') === 0 && (admin.children.includes(compOf(M, n)) || seller.children.includes(compOf(M, n)))), label + ': the 5 template-body components exist once each, with a description, on the templates hosts');
  const dm = frameNamed(M, 'Dialogs · Members · Admin')[0];
  const dialogs = dm.findAll((n) => n.type === 'INSTANCE' && /^D\d/.test(n.name) && n.parent === dm.findOne((x) => x.name === 'dialogs'));
  check(dialogs.length === 3 && dialogs.every((d) => /Layout=Centred/.test(instMain(d)) && /Size=Sm/.test(instMain(d))) && dialogs.every((d, i) => d.findOne((n) => n.name === 'content')._main.name === [BODIES_180[0], BODIES_180[1], BODIES_180[2]][i]), label + ': Dialogs · Members · Admin has D1, D1 with the list open and D2 (Centred Sm), each with its template body in the Content slot');
  const open = dialogs[1];
  check(open.findAll((n) => n.name === 'control').some((n) => instMain(n) === 'State=Open') && open.findOne((n) => n.type === 'INSTANCE' && n.name === 'role-list') && open.findAll((n) => n.type === 'INSTANCE' && /State=Selected/.test(instMain(n))).length === 1 && open.findAll((n) => n.type === 'INSTANCE' && /State=Disabled/.test(instMain(n)) && /MenuItem|^item-/.test(n.name)).length === 1, label + ': the open list shows Select State=Open, a Menu with one selected row (check) and one disabled row');
  const cf = frameNamed(M, 'Dialogs · Confirm · Admin')[0];
  const cdl = cf.findAll((n) => n.type === 'INSTANCE' && n.parent && n.parent.name === 'dialogs');
  const dest = cdl.filter((d) => /Tone=Destructive/.test(instMain(d)));
  check(cdl.length === 5 && dest.length === 4 && dest.every((d) => /State=Focus/.test(instMain(d.findOne((n) => n.name === 'secondary'))) && /Variant=Destructive/.test(instMain(d.findOne((n) => n.name === 'primary')))) && cdl.filter((d) => /Tone=Default/.test(instMain(d))).every((d) => !/State=Focus/.test(instMain(d.findOne((n) => n.name === 'secondary')))), label + ': 5 confirm dialogs; the 4 Destructive ones (incl. Reset two-step verification) have a Destructive primary and Cancel focused');
  check(cdl.some((d) => d.findOne((n) => n.type === 'TEXT' && n.characters === 'Keep invitation')) && cdl.some((d) => d.findOne((n) => n.type === 'TEXT' && n.characters === 'Reset')), label + ': the Cancel invitation dialog says "Keep invitation" and the reset dialog exists');
  const sh = frameNamed(M, 'Dialog sheet · Remove from team (phone)')[0];
  const shd = sh.findOne((n) => n.type === 'INSTANCE' && /Layout=Sheet/.test(instMain(n)));
  check(sh.width === 360 && sh.height === 780 && shd && /Tone=Destructive/.test(instMain(shd)) && shd.width === 360 && Math.round(shd.y + shd.height) === 780 && sh.findOne((n) => n.name === 'scrim'), label + ': the remove-from-team sheet is a 360 by 780 frame with a scrim and a Destructive Sheet docked at the bottom');
  // no active Sidebar item, Not found without a resource name, view-only copy, load error copy, toast
  const noActive = ['Shared · Members · Admin', 'Shared · Roles · Seller', 'Shared · No access · Admin', 'Shared · Not found', 'Shared · Account security · Seller · On'].every((n) => { const sb = frameNamed(M, n)[0].findOne((x) => x.name === 'Sidebar'); return sb && !sb.findAll((x) => x.type === 'INSTANCE' && /^State=Active/.test(instMain(x))).length; });
  check(noActive && frameNamed(M, 'Shared · Members · Seller (phone)').length === 1, label + ': the Panel pages mark no Sidebar item as active');
  const nf = frameNamed(M, 'Shared · Not found')[0];
  const nfText = nf.findOne((n) => n.name === 'Content').findAll((n) => n.type === 'TEXT').map((n) => n.characters).join(' | ') + ' | ' + nf.findOne((n) => n.type === 'INSTANCE' && n.name === 'Topbar').findAll((n) => n.name === 'crumb').map((n) => n.characters).join();
  check(nfText.includes('We can’t find that page') && nfText.includes('It may have been removed, or the link may be wrong.') && nfText.includes('Go to Home') && !/Kuraby|Yusuf|Finance|Amina|MP-/.test(nfText) && nfText.endsWith('Not found'), label + ': Not found has the copy and names no resource (content and crumb)');
  const vo = frameNamed(M, 'Shared · Members · Admin · View only')[0];
  const voTexts = vo.findAll((n) => n.type === 'TEXT' && n.characters === VIEW_ONLY_COPY);
  const inv = vo.findAll((n) => n.type === 'INSTANCE' && /State=Disabled/.test(instMain(n)) && n.findOne((x) => x.type === 'TEXT' && x.characters === 'Invite admin'));
  const menuItems = vo.findAll((n) => n.type === 'INSTANCE' && /State=Disabled/.test(instMain(n)) && /^item-/.test(n.name));
  check(voTexts.length === 4 && inv.length === 1 && menuItems.length === 3, label + ': View only: "Invite admin" is disabled, the helper "' + VIEW_ONLY_COPY + '" sits under the title and on the 3 disabled menu items');
  const le = frameNamed(M, 'Shared · Members · Seller · Load error')[0];
  check(le.findAll((n) => n.type === 'TEXT').some((n) => n.characters === 'We couldn’t load this list') && le.findAll((n) => n.type === 'TEXT').some((n) => n.characters === 'Try again') && le.findAll((n) => n.type === 'INSTANCE' && n.name === 'load-error' && /Tone=Critical/.test(instMain(n))).length === 1 && !le.findOne((n) => n.type === 'INSTANCE' && n.name === 'empty-state'), label + ': Load error is an InfoBanner Critical "We couldn’t load this list" with "Try again" (not an empty state)');
  const ld = frameNamed(M, 'Shared · Members · Admin · Loading')[0];
  const ls = frameNamed(M, 'Shared · Members · Seller · Loading')[0];
  check(ld.findAll((n) => n.type === 'INSTANCE' && /State=Loading/.test(instMain(n))).length === 32 && ls.findAll((n) => n.type === 'INSTANCE' && /State=Loading/.test(instMain(n))).length === 40 && ld.findAll((n) => n.type === 'INSTANCE' && /Type=Header/.test(instMain(n))).length === 4, label + ': the Loading frames keep the real header and have 8 skeleton rows (32 and 40 Loading cells)');
  const sv = frameNamed(M, 'Shared · Account security · Seller · Saved')[0];
  check(sv.findOne((n) => n.type === 'INSTANCE' && n.name === 'Toast' && /Tone=Success/.test(instMain(n))) && sv.findAll((n) => n.type === 'TEXT').some((n) => n.characters === 'Password changed. You’ve been signed out on your other devices.'), label + ': the Saved frame shows the Success Toast');
  const emp = frameNamed(M, 'Shared · Roles · Admin · No custom roles')[0];
  check(emp.findOne((n) => n.type === 'INSTANCE' && /Size=Compact/.test(instMain(n))) && emp.findAll((n) => n.type === 'TEXT').some((n) => n.characters === 'No custom roles yet'), label + ': No custom roles uses EmptyState Compact');
  const na = frameNamed(M, 'Shared · No access · Seller')[0].findOne((n) => n.type === 'INSTANCE' && /Size=Page/.test(instMain(n)));
  check(na && na.findAll((n) => n.type === 'TEXT').some((n) => n.characters === 'You don’t have access to this page'), label + ': No access uses EmptyState Page');
  // all Panel frames: copy that must not be there
  const all = ADMIN_180.map((n) => frameNamed(M, n)[0]).concat(SELLER_180.map((n) => frameNamed(M, n)[0]));
  const txt = all.map((f) => f.findAll((n) => n.type === 'TEXT').map((n) => n.characters).join('\n')).join('\n');
  check(!/Placeholder:/.test(txt) && !/Reject this seller|Reason for the seller|Leave without saving/.test(txt), label + ': no 1.8.3 content (Sellers list, role editor, D4 to D6, unsaved-changes dialog) in the 1.8.0 Panel frames');
}

// ---- Release 1.8.1 "Audit fixes for the Panel pages": what a new build and an updated file must both hold
// The code.js of release 1.8.0 (test/fixtures/code-1.8.0.js, the plugin as released at 5d2e100): its Panel pages hug their content with no minimum height,
// the admin phone members screen has 5 cards and the CheckboxRow set is 2960 wide. Update library of 1.8.1 repairs those in place.
const CODE_180 = fs.readFileSync(path.join(__dirname, 'fixtures', 'code-1.8.0.js'), 'utf8');
const CODE_181 = fs.readFileSync(path.join(__dirname, 'fixtures', 'code-1.8.1.js'), 'utf8'); // the released 1.8.1 plugin, for the 1.8.2 update scenario
const SHELL_ADMIN = ADMIN_180.filter((n) => !/\(phone\)|^Dialogs/.test(n));
const SHELL_SELLER = SELLER_180.filter((n) => !/\(phone\)|^Dialogs/.test(n));
const FIXED_900 = ['Shared · No access · Admin', 'Shared · No access · Seller', 'Shared · Not found', 'Shared · Account security · Seller · Saved']; // built with a fixed 900 height
const ADMIN_PHONE = 'Shared · Members · Admin (phone)';
const OVERFLOW_CARDS = ['Noor Hassan', 'Sam Okafor'];
const lastBottom = (n) => { const kids = (n.children || []).filter((c) => c.visible && c._layoutPositioning !== 'ABSOLUTE'); return kids; };
// Height a vertical auto-layout frame's relative children ask for (padding, gaps, children), from the mock's sizes.
const stackHeight = (f) => { const k = lastBottom(f); return f.paddingTop + f.paddingBottom + k.reduce((a, c) => a + c.height, 0) + f.itemSpacing * Math.max(0, k.length - 1); };
const phoneMain = (M) => frameNamed(M, ADMIN_PHONE)[0].children.find((c) => c.name === 'Main');
const cbParts = (M) => { const set = setOf(M, 'CheckboxRow'); const row = set.parent; return { set: set, row: row, usage: row.children.find((c) => c.name === 'Usage') }; };
const shellFrames = (M) => SHELL_ADMIN.concat(SHELL_SELLER).map((n) => frameNamed(M, n)[0]);

// Top-level children of every page and of every section on it (the nodes the canvas layout is made of).
function topLevel(M) { const out = []; M.ROOT.children.forEach((p) => { p.children.forEach((n) => { out.push([p.name, n]); if (n.type === 'SECTION') n.children.forEach((c) => out.push([p.name + ' › ' + n.name, c])); }); }); return out; }
const overlapsOf = (M) => { const by = {}; topLevel(M).forEach((e) => { (by[e[0]] = by[e[0]] || []).push(e[1]); }); const out = []; Object.keys(by).forEach((k) => { const a = by[k]; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) { const p = a[i], q = a[j]; if (p.x + p.width > q.x + 0.5 && q.x + q.width > p.x + 0.5 && p.y + p.height > q.y + 0.5 && q.y + q.height > p.y + 0.5) out.push(k + ': ' + p.name + ' / ' + q.name); } }); return out; };
const posOf = (M) => new Map(topLevel(M).map((e) => [e[1].id, e[1].x + ',' + e[1].y]));
// Everything an update could change on a layer, as JSON; bounds leaves out the place and size (a Starter section may grow or move).
const SNAP_KEYS = ['type', 'name', 'parent', 'index', 'x', 'y', 'width', 'height', 'visible', 'fills', 'strokes', 'boundVariables', 'sizingH', 'sizingV', 'props', 'characters'];
function encodeSnap(o, bounds) {
  const out = {}; SNAP_KEYS.filter((k) => !(bounds && ['x', 'y', 'width', 'height'].includes(k))).forEach((k) => { out[k] = o[k] === undefined ? null : o[k]; });
  return JSON.stringify(out);
}
function fullSnap(n, bounds) {
  const get = (k) => { try { return n[k]; } catch (e) { return '!'; } };
  return encodeSnap({
    type: n.type, name: n.name, parent: n.parent ? n.parent.id : null, index: n.parent && n.parent.children ? n.parent.children.indexOf(n) : -1, x: get('x'), y: get('y'), width: get('width'), height: get('height'),
    visible: n.visible, fills: get('fills'), strokes: get('strokes'), boundVariables: get('boundVariables'), sizingH: get('layoutSizingHorizontal'), sizingV: get('layoutSizingVertical'),
    props: n.type === 'INSTANCE' ? n.componentProperties : null, characters: n.type === 'TEXT' ? n.characters : null }, bounds);
}
function snapDiff(nodes, was) {
  return nodes.slice(0, 6).map((n) => { const a = JSON.parse(was.get(n.id) || '{}'), b = JSON.parse(fullSnap(n)); return n.type + ' ' + n.name + ' [' + SNAP_KEYS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).join(',') + ']'; }).join('; ');
}
// The changelog table gets a row for each release (and the row above it a divider), so its layers are left to the changelog checks.
function inChangelog(n) { for (let p = n; p; p = p.parent) { if (p.name === 'Changelog' || p.name === 'changelog') return true; } return false; }

// Facts that hold for every 1.8.1 file, built new or repaired.
function state181(M, label, skipOverlap) {
  const ov = skipOverlap ? [] : overlapsOf(M);
  check(skipOverlap || ov.length === 0, label + ': ' + (skipOverlap ? 'overlap check skipped (update path: see the report check)' : 'no two top-level children of a page or section overlap') + ' (' + ov.length + (ov.length ? ': ' + ov.slice(0, 3).join(' | ') : '') + ')');
  const shell = shellFrames(M);
  const low = shell.filter((f) => f.height < 900 - 0.5);
  check(shell.length === 22 && low.length === 0, label + ': every Panel desktop page is at least 900 high (' + shell.length + ' pages, ' + low.length + ' lower' + (low.length ? ': ' + low.map((f) => f.name + ' ' + f.height).join(', ') : '') + ')');
  const hugging = shell.filter((f) => !FIXED_900.includes(f.name));
  check(hugging.length === 18 && hugging.every((f) => f.minHeight === 900 && f.layoutSizingVertical === 'HUG') && FIXED_900.every((n) => { const f = frameNamed(M, n)[0]; return f.height === 900 && f.layoutSizingVertical === 'FIXED'; }), label + ': the 18 hugging Panel pages have minHeight 900, the 4 fixed pages stay 900 high');
  const panelNames = SHELL_ADMIN.concat(SHELL_SELLER, SHELL_183, [EDITOR_PHONE]); const extraMin = topLevel(M).map((e) => e[1]).filter((n) => n.minHeight && !panelNames.includes(n.name));
  check(extraMin.length === 0, label + ': no top-level frame outside the Panel desktop pages has a minimum height' + (extraMin.length ? ' (' + extraMin.map((n) => n.name).join(', ') + ')' : ''));
  check(shell.every((f) => f.children[0].name === 'Sidebar' && f.children[0].layoutSizingVertical === 'FILL'), label + ': the Sidebar still fills the height of each Panel page');
  const main = phoneMain(M); const phone = main.parent;
  const cards = main.children.filter((c) => c.type === 'FRAME' && ['head', 'role', 'badges'].join() === c.children.map((k) => k.name).join());
  check(cards.length === 3 && cards.map((c) => c.name).join() === 'Layla Haddad,Omar Saleh,Amira Said' && !OVERFLOW_CARDS.some((n) => main.children.some((c) => c.name === n)), label + ': the admin phone members screen shows 3 cards (' + cards.map((c) => c.name).join(', ') + ')');
  const room = phone.height - phone.children.find((c) => c.name === 'PhoneTopbar').height;
  check(stackHeight(main) <= room + 0.5, label + ': the admin phone members cards fit in the phone Main (' + Math.round(stackHeight(main)) + ' of ' + Math.round(room) + ' px)');
  const sellerPhone = frameNamed(M, 'Shared · Members · Seller (phone)')[0]; const sm = sellerPhone.children.find((c) => c.name === 'Main');
  check(sm.children.filter((c) => ['Yusuf Karimi', 'Amina Rahman', 'Tariq Nasser'].includes(c.name)).length === 3, label + ': the seller phone members screen keeps its 3 cards');
  const cb = cbParts(M);
  check(cb.set.width <= 1440 && cb.row.width >= cb.set.width - 0.5 && cb.usage.width <= cb.row.width + 0.5 && cb.set.children.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.width <= cb.set.width + 0.5 && c.y + c.height <= cb.set.height + 0.5), label + ': the CheckboxRow set (' + Math.round(cb.set.width) + ' wide) and its Usage panel (' + Math.round(cb.usage.width) + ') fit the documentation row (' + Math.round(cb.row.width) + ')');
  const col = (n) => Math.round(cb.set.children.find((c) => c.name === n).x);
  check(col('Value=Unchecked, State=Default') === col('Value=Unchecked, State=Hover') && col('Value=Unchecked, State=Default') < col('Value=Checked, State=Default') && cb.set.children.length === 10, label + ': CheckboxRow has Value in 2 columns and State in 5 rows, still 10 variants');
  // A size-only check of the same kind the Audit does: no child of a fixed-size vertical frame asks for more height than the frame has.
  const tooTall = [];
  [main].concat(shell).forEach((f) => f.findAll((n) => n.type === 'FRAME' && n.layoutMode === 'VERTICAL' && n.layoutSizingVertical === 'FIXED' && !n.instAncestor()).concat([f]).forEach((n) => { if (n.layoutSizingVertical === 'FIXED' && stackHeight(n) > n.height + 1.5 && n.layoutMode === 'VERTICAL') tooTall.push(pathOf(n).split(' › ').slice(-3).join(' › ') + ' +' + Math.round(stackHeight(n) - n.height)); }));
  check(tooTall.length === 0, label + ': no vertical frame of a Panel page asks for more height than it has (' + tooTall.length + (tooTall.length ? ': ' + tooTall.slice(0, 3).join(' | ') : '') + ')');
}

// ---- Release 1.8.3 "Panel follow-up": the Sellers list (P1), the role editor (B3), dialogs D4 to D6 and the unsaved-changes dialog. New frames only.
// The code.js of release 1.8.2 (test/fixtures/code-1.8.2.js, the plugin as merged at 15ec3ff), for the 1.8.3 update scenario.
const CODE_182 = fs.readFileSync(path.join(__dirname, 'fixtures', 'code-1.8.2.js'), 'utf8');
const P1 = 'Admin · Sellers (Phase 2)';
const P1_FRAMES = [P1, P1 + ' · Menu open', P1 + ' · View only', P1 + ' · Loading', P1 + ' · Empty', P1 + ' · Load error'];
const EDITOR_ADMIN = ['Custom', 'Default', 'System', 'Duplicate', 'Errors'].map((s) => 'Shared · Role editor · Admin · ' + s);
const EDITOR_SELLER = ['Custom', 'Ready-made', 'Owner', 'New role · early catalogue'].map((s) => 'Shared · Role editor · Seller · ' + s);
const EDITOR_PHONE = 'Shared · Role editor · Seller (phone)';
const ADMIN_183 = P1_FRAMES.concat(EDITOR_ADMIN, ['Dialogs · Sellers · Admin', 'Dialogs · Role editor · Admin', P1 + ' (phone)', 'Dialog sheet · Reject (phone)']);
const SELLER_183 = EDITOR_SELLER.concat([EDITOR_PHONE]);
const SHELL_183 = P1_FRAMES.concat(EDITOR_ADMIN, EDITOR_SELLER);
const BODIES_183 = ['Template body · D4 Reject', 'Template body · D4 Reject (error)', 'Template body · D4 View reason', 'Template body · D5 Suspend', 'Template body · D6 Add seller'];
const ADDED_183 = ['templates Panel 1.8.3 · Admin (' + ADMIN_183.length + ' frames, ' + BODIES_183.length + ' template bodies)', 'templates Panel 1.8.3 · Seller (' + SELLER_183.length + ' frames)'];
const NOT_HELD_COPY = 'You can’t give a permission you don’t have.';
const NOT_HELD_CHANGE_COPY = 'You can’t change a permission you don’t have.';
const PROTECTED_ADMIN_COPY = 'Only a Platform owner can give this permission.';
const PROTECTED_SELLER_COPY = 'Only the shop owner can do this. It can’t be given to team members yet.';
const SELLERS_VIEW_ONLY_COPY = 'Your role can view sellers but not change them.';
const textsOf = (n) => n.findAll((x) => x.type === 'TEXT' && x.visible !== false && !hiddenAbove(x, n)).map((x) => x.characters);
function hiddenAbove(x, root) { for (let p = x; p && p !== root; p = p.parent) if (p.visible === false) return true; return false; }
const instsOf = (n, re) => n.findAll((x) => x.type === 'INSTANCE' && re.test(instMain(x)));
const rowsOf = (f) => f.findAll((n) => n.type === 'FRAME' && n.name === 'Row' && n.parent && n.parent.name === 'Seller list');
const permRowsOf = (f) => f.findAll((n) => n.type === 'INSTANCE' && /^permission · /.test(n.name));
const propOf = (i, name) => { const k = Object.keys(i.componentProperties || {}).find((x) => x.split('#')[0] === name); return k ? i.componentProperties[k].value : undefined; };

// Facts that hold for every 1.8.3 file, built new or updated.
function state183(M, label) {
  const admin = hostNamed(M, 'Templates · Admin'), seller = hostNamed(M, 'Templates · Seller');
  const once = (host, names) => names.filter((n) => host.children.filter((c) => c.type === 'FRAME' && c.name === n && c.getPluginData('mondapac-ds') === '1').length !== 1);
  const miss = once(admin, ADMIN_183).concat(once(seller, SELLER_183));
  check(miss.length === 0, label + ': the ' + ADMIN_183.length + ' Admin and ' + SELLER_183.length + ' Seller frames of 1.8.3 exist once each on the right templates host' + (miss.length ? ' (not: ' + miss.join(', ') + ')' : ''));
  if (miss.length) return;
  const F = (n) => frameNamed(M, n)[0];
  check(BODIES_183.every((n) => countNamed(M, 'COMPONENT', n) === 1 && compOf(M, n).description.indexOf('Template body') === 0 && admin.children.includes(compOf(M, n))), label + ': the 5 template bodies of D4 to D6 exist once each, with a description, on Templates · Admin');
  const shells = SHELL_183.map(F);
  check(shells.every((f) => f.minHeight === 900 && f.layoutSizingVertical === 'HUG' && f.height >= 900 && f.children[0].name === 'Sidebar' && f.children[0].layoutSizingVertical === 'FILL'), label + ': the ' + shells.length + ' desktop pages of 1.8.3 hug their content, are at least 900 high and keep a full-height Sidebar');
  // P1
  const p1 = F(P1);
  const active = (f) => f.findOne((x) => x.name === 'Sidebar').findAll((x) => x.type === 'INSTANCE' && /^State=Active/.test(instMain(x))).map((x) => x.name);
  check(P1_FRAMES.every((n) => active(F(n)).join() === 'nav-sellers'), label + ': the Sellers pages mark Sellers as the active Sidebar item');
  const heads = p1.findOne((x) => x.name === 'Header row').children.map((c) => textsOf(c).join(''));
  const p1Main = p1.findOne((x) => x.name === 'Main');
  check(heads.join('|') === 'Seller|Status|Since|' && !/KPI strip|BulkActionBar/.test(p1.findAll(() => true).map((x) => x.name).join('|')) && !textsOf(p1Main).some((t) => /Certif|Health|Orders/.test(t)), label + ': P1 has the columns Seller, Status, Since and actions, and no KPI strip, bulk bar, certificate, health or order column');
  const tabs = p1.findOne((x) => x.name === 'tabs').children;
  check(tabs.map((t) => propOf(t, 'Label')).join('|') === 'Awaiting approval|Approved|Changes needed|Suspended|Invited|All' && tabs.filter((t) => /Selected=True/.test(instMain(t))).map((t) => propOf(t, 'Label')).join() === 'Awaiting approval', label + ': P1 has the six tabs with counts and opens on "Awaiting approval"');
  check(rowsOf(p1).length === 3 && rowsOf(p1).every((r) => textsOf(r).some((t) => /@/.test(t))) && textsOf(p1).includes('Search sellers') && textsOf(p1).includes('Enter the full email address.') && textsOf(p1).includes('12 sellers in the Australia market'), label + ': P1 lists 3 sellers awaiting approval (owner name over email), the search with its help line and the count line');
  const mo = F(P1 + ' · Menu open');
  const badges = rowsOf(mo).map((r) => instsOf(r, /, Leading=/).map((b) => instMain(b) + ' ' + propOf(b, 'Label')).join());
  const want = [['Info', 'Awaiting approval'], ['Attention', 'Changes needed'], ['Success', 'Approved'], ['Success', 'Approved'], ['Critical', 'Suspended'], ['Neutral', 'Invited']];
  check(badges.length === 6 && want.every((w, i) => badges[i].indexOf('Tone=' + w[0] + ', Leading=Icon') === 0 && badges[i].endsWith(' ' + w[1])), label + ': the All tab shows each status as a Badge with an icon and a word (' + badges.join(' | ') + ')');
  const waits = (r) => textsOf(r).some((t) => /^Two-step reset waiting for the owner \(link expires .+\)$/.test(t));
  check(textsOf(mo).filter((t) => /^Two-step reset waiting for the owner \(link expires .+\)$/.test(t)).length === 1 && waits(rowsOf(mo)[3]) && !waits(rowsOf(mo)[2]), label + ': one approved row says the owner must still confirm a two-step reset, with the link expiry; the approved row with the open menu has none waiting');
  const menus = (f) => f.children.filter((c) => c.type === 'INSTANCE' && c.name === 'Row menu (open)');
  const items = (m) => m.findAll((x) => x.type === 'INSTANCE' && /^item-/.test(x.name) && x.visible !== false).map((x) => [instMain(x).replace('State=', ''), propOf(x, 'Label'), propOf(x, 'Show description') ? propOf(x, 'Description') : '']);
  // The mock does not measure text, so a menu's height is not checked against the frame; its right edge sits on the actions button's right edge.
  const inside = (f, m) => m.layoutPositioning === 'ABSOLUTE' && m.x >= 0 && m.y >= 0 && m.x + m.width <= f.width + 0.5 && m.y < f.height && Math.abs(m.x + m.width - (1440 - 32 - 12)) < 0.5;
  const mm = menus(mo);
  check(mm.length === 2 && JSON.stringify(items(mm[0])) === JSON.stringify([['Default', 'Approve', ''], ['Destructive', 'Reject…', '']]) && JSON.stringify(items(mm[1])) === JSON.stringify([['Default', 'Reset owner’s two-step verification…', ''], ['Destructive', 'Suspend…', '']]) && mm.every((m) => inside(mo, m)), label + ': Menu open shows the awaiting row menu (Approve, Reject…) and the approved row menu (Reset owner’s two-step verification…, Suspend…), inside the frame');
  const rowTop = (f, i) => { let y = 0; for (let n = rowsOf(f)[i]; n && n !== f; n = n.parent) { const p = n.parent; if (!p || !p.layoutMode || p.layoutMode === 'NONE') { y += n.y; continue; } const k = p.children.filter((c) => c.visible && c._layoutPositioning !== 'ABSOLUTE'); y += (p.layoutMode === 'VERTICAL' ? p.paddingTop + k.slice(0, k.indexOf(n)).reduce((a, c) => a + c.height + p.itemSpacing, 0) : p.paddingTop); } return y; };
  check(mm.length === 2 && mm[0].y >= rowTop(mo, 0) + 32 && mm[0].y <= rowTop(mo, 1) && mm[1].y >= rowTop(mo, 2) + 32 && mm[1].y <= rowTop(mo, 3), label + ': each menu opens under its own row (y ' + mm.map((m) => Math.round(m.y)).join(', ') + ')');
  const vo = F(P1 + ' · View only');
  const vm = menus(vo);
  check(instsOf(vo, /State=Disabled/).some((b) => textsOf(b).includes('Add seller')) && textsOf(vo).filter((t) => t === SELLERS_VIEW_ONLY_COPY).length === 3 && vm.length === 1 && items(vm[0]).every((it) => it[0] === 'Disabled' && it[2] === SELLERS_VIEW_ONLY_COPY) && inside(vo, vm[0]), label + ': View only: "Add seller" is disabled and the help line and both disabled menu items say "' + SELLERS_VIEW_ONLY_COPY + '"');
  check(instsOf(F(P1 + ' · Loading'), /State=Loading/).length === 32, label + ': Loading has 8 skeleton rows under the real header (32 Loading cells)');
  const em = F(P1 + ' · Empty');
  check(instsOf(em, /Size=Card/).length === 1 && textsOf(em).includes('No sellers are waiting') && textsOf(em).includes('You’re up to date.') && !textsOf(em).includes('Invite team member') && textsOf(em).includes('9 sellers in the Australia market'), label + ': Empty shows EmptyState Card "No sellers are waiting" with no action, and the counts drop the waiting sellers');
  const le = F(P1 + ' · Load error');
  check(instsOf(le, /Tone=Critical/).some((b) => b.name === 'load-error') && textsOf(le).includes('We couldn’t load this list') && textsOf(le).includes('Try again') && rowsOf(le).length === 0, label + ': Load error is an InfoBanner Critical with "Try again" in place of the list');
  const ph = F(P1 + ' (phone)'); const pm = ph.children.find((c) => c.name === 'Main');
  const room = ph.height - ph.children.find((c) => c.name === 'PhoneTopbar').height;
  check(ph.width === 360 && ph.height === 780 && ['Hana Yusuf', 'Bilal Ahmed', 'Mariam Khalil'].every((n) => pm.children.some((c) => c.name === n)) && stackHeight(pm) <= room + 0.5 && ph.getPluginData('density') === 'touch', label + ': the P1 phone frame stacks 3 seller cards that fit (' + Math.round(stackHeight(pm)) + ' of ' + Math.round(room) + ' px), touch density');
  // dialogs D4 to D6
  const ds = F('Dialogs · Sellers · Admin'); const row = ds.findOne((x) => x.name === 'dialogs');
  const dl = row.children.filter((c) => c.type === 'INSTANCE');
  const dOf = (n) => dl.find((d) => d.name === n);
  const sec = (d) => d.findOne((x) => x.name === 'secondary');
  check(dl.map((d) => d.name).join('|') === 'D4 Reject|D4 Reject · Error|D5 Suspend|D4 View reason|D6 Add seller' && ds.height >= 900 && row.y + row.height <= ds.height + 0.5 && ds.findOne((x) => x.name === 'scrim').height === ds.height, label + ': Dialogs · Sellers · Admin holds D4, D4 with its error, D5, the read-only D4 and D6 on a scrim as tall as the scene (' + Math.round(ds.height) + ' px)');
  check(['D4 Reject', 'D4 Reject · Error', 'D5 Suspend'].every((n) => /Size=Md, Tone=Destructive, Layout=Centred/.test(instMain(dOf(n)))) && /Size=Md, Tone=Default/.test(instMain(dOf('D4 View reason'))) && /Size=Sm, Tone=Default, Layout=Centred/.test(instMain(dOf('D6 Add seller'))), label + ': D4 and D5 are Md Destructive, the read-only D4 is Md Default and D6 is Sm Default');
  check(/State=Focus/.test(instMain(sec(dOf('D4 Reject')))) && /State=Focus/.test(instMain(sec(dOf('D5 Suspend')))) && sec(dOf('D4 View reason')).visible === false && textsOf(dOf('D4 View reason')).includes('Close'), label + ': D4 and D5 open with focus on Cancel; the read-only D4 has one button, "Close"');
  const pri = (d) => d.findOne((x) => x.name === 'primary');
  const dCopy = [['D4 Reject', 'Reject this seller application?', 'Reject application', 'Cancel'], ['D4 Reject · Error', 'Reject this seller application?', 'Reject application', 'Cancel'], ['D5 Suspend', 'Suspend this seller?', 'Suspend seller', 'Cancel'], ['D4 View reason', 'Reason for Ibrahim Musa', 'Close', null], ['D6 Add seller', 'Add a seller', 'Send invitation', 'Cancel']];
  const dBad = dCopy.filter((c) => propOf(dOf(c[0]), 'Title') !== c[1] || textsOf(pri(dOf(c[0]))).join() !== c[2] || (c[3] !== null && textsOf(sec(dOf(c[0]))).join() !== c[3]));
  check(dBad.length === 0, label + ': D4, D5 and D6 carry the ux.md titles and button labels (dialog.reject, dialog.suspend, dialog.add-seller; the read-only D4 title is a sample)' + (dBad.length ? ': ' + dBad.map((c) => c[0]).join(', ') : ''));
  const bodyOf = (n) => instMain(dOf(n).findOne((x) => x.name === 'content'));
  check(['D4 Reject', 'D4 Reject · Error', 'D5 Suspend', 'D4 View reason', 'D6 Add seller'].map(bodyOf).join('|') === ['Template body · D4 Reject', 'Template body · D4 Reject (error)', 'Template body · D5 Suspend', 'Template body · D4 View reason', 'Template body · D6 Add seller'].join('|'), label + ': each dialog holds its template body in the Content slot');
  const rejectBody = compOf(M, 'Template body · D4 Reject'), errBody = compOf(M, 'Template body · D4 Reject (error)');
  const fieldOf = (b) => b.findOne((x) => x.type === 'INSTANCE' && x.name === 'field-reason-for-the-seller');
  check(fieldOf(rejectBody) && /State=Default/.test(instMain(fieldOf(rejectBody).findOne((x) => x.name === 'control'))) && fieldOf(rejectBody).findOne((x) => x.name === 'control')._main.parent.name === 'Textarea' && propOf(fieldOf(rejectBody), 'Show counter') === true && propOf(fieldOf(rejectBody), 'Counter') === '0 / 1000' && textsOf(rejectBody).includes('Reason for the seller') && textsOf(rejectBody).includes('The shop owner sees this in an email and when they sign in. Say what was wrong and what to change. Don’t add internal notes.'), label + ': D4 has a Textarea "Reason for the seller" with the full helper and the counter');
  const d5 = compOf(M, 'Template body · D5 Suspend');
  check(textsOf(d5)[0] === 'Everyone on the seller’s team is signed out and can’t sign in until you lift the suspension.' && fieldOf(d5) && propOf(fieldOf(d5), 'Show error') === false, label + ': D5 states the consequence first, then asks for the reason as D4 does');
  check(/State=Error/.test(instMain(fieldOf(errBody).findOne((x) => x.name === 'control'))) && propOf(fieldOf(errBody), 'Show error') === true && textsOf(errBody).includes('Write a reason before you continue.'), label + ': the D4 error state shows "Write a reason before you continue." with the Textarea in State=Error');
  const vr = compOf(M, 'Template body · D4 View reason');
  const rq = vr.findOne((x) => x.type === 'INSTANCE' && x._main && x._main.name === 'ReasonQuote');
  check(rq && propOf(rq, 'Label') === 'Reason from MondaPac' && propOf(rq, 'Date') === 'Written on 3 Oct 2026' && textsOf(vr).includes('Written by') && textsOf(vr).includes('Layla Haddad'), label + ': the read-only D4 shows the reason (ReasonQuote "Reason from MondaPac", "Written on {date}") and its author');
  const d6 = compOf(M, 'Template body · D6 Add seller');
  check(textsOf(d6).includes('Owner’s name') && !textsOf(d6).includes('Seller name') && textsOf(d6).includes('The shop owner’s own name, not the business name. They add the store and business names when they set up.') && textsOf(d6).includes('We’ll email them a link to choose their own password. You never see or set it.') && textsOf(d6).includes('The account still needs approval after they accept.'), label + ': D6 asks for the "Owner’s name" (Hadi) and the email, with the password and approval notes');
  const sh = F('Dialog sheet · Reject (phone)'); const shd = sh.findOne((x) => x.type === 'INSTANCE' && /Layout=Sheet/.test(instMain(x)));
  check(sh.width === 360 && sh.height === 780 && shd && /Tone=Destructive/.test(instMain(shd)) && Math.round(shd.y + shd.height) === 780 && instMain(shd.findOne((x) => x.name === 'content')) === 'Template body · D4 Reject (error)', label + ': the Reject phone sheet is docked at the bottom of a 360 by 780 frame and shows the reason error');
  const un = F('Dialogs · Role editor · Admin'); const ud = un.findOne((x) => x.name === 'dialogs').children.filter((c) => c.type === 'INSTANCE');
  check(ud.length === 1 && /Tone=Destructive/.test(instMain(ud[0])) && textsOf(ud[0]).includes('Leave without saving?') && textsOf(ud[0]).includes('You have unsaved changes. They’ll be lost if you leave.') && textsOf(ud[0]).includes('Leave') && textsOf(sec(ud[0])).join() === 'Keep editing' && /State=Focus/.test(instMain(sec(ud[0]))), label + ': the unsaved-changes dialog has the approved copy and opens with focus on "Keep editing"');
  // role editor
  const ed = (n) => F(n);
  const counterOf = (f) => (f.findOne((x) => x.type === 'TEXT' && x.name === 'selected-count') || {}).characters;
  const cust = ed(EDITOR_ADMIN[0]); const pr = permRowsOf(cust);
  const st = (i) => instMain(i).replace(/, /g, ' ');
  check(pr.length === 14 && counterOf(cust) === '4 of 14 permissions selected' && pr.filter((i) => /Value=Checked/.test(instMain(i))).length === 4, label + ': the admin custom role shows the 14 catalogue rows and "4 of 14 permissions selected"');
  const prot = pr.filter((i) => propOf(i, 'Show badge') === true);
  const rowOf = (rows, lbl) => rows.filter((i) => propOf(i, 'Label') === lbl)[0];
  check(prot.length === 5 && prot.every((i) => /State=Disabled/.test(instMain(i)) && propOf(i, 'Description') === PROTECTED_ADMIN_COPY), label + ': 5 protected rows (badge, disabled, "' + PROTECTED_ADMIN_COPY + '")');
  // R1 both ways: a permission the admin does not hold can be neither given nor taken away, so a ticked one stays ticked (only Duplicate drops it).
  for (const f of [cust, ed(EDITOR_ADMIN[4])]) {
    const addRow = rowOf(permRowsOf(f), 'Add sellers'), deact = rowOf(permRowsOf(f), 'Deactivate customer accounts');
    check(/Value=Checked, State=Disabled/.test(instMain(addRow)) && propOf(addRow, 'Description') === NOT_HELD_CHANGE_COPY && /Value=Unchecked, State=Disabled/.test(instMain(deact)) && propOf(deact, 'Description') === NOT_HELD_COPY && permRowsOf(f).filter((i) => /State=Disabled/.test(instMain(i))).length === 7, label + ': ' + f.name + ': a ticked permission the admin does not hold stays ticked and locked ("' + NOT_HELD_CHANGE_COPY + '"); an unticked one is locked with "' + NOT_HELD_COPY + '"');
  }
  const sel = cust.findAll((x) => x.type === 'INSTANCE' && x.name === 'select-all-checkbox');
  check(sel.length === 5 && sel.map((c) => /Value=(\w+)/.exec(instMain(c))[1]).join() === 'Indeterminate,Unchecked,Checked,Unchecked,Checked' && sel.every((c) => /State=Default/.test(instMain(c))) && textsOf(cust).includes('Select all in Seller access'), label + ': each resource card has "Select all in {group}" with a three-state checkbox counted over the rows the admin can give (' + sel.map((c) => /Value=(\w+)/.exec(instMain(c))[1]).join(', ') + ')');
  const back = cust.findOne((x) => x.type === 'INSTANCE' && x.name === 'back'); const tr = (f) => f.findOne((x) => x.name === 'title-row');
  const h1Badge = (f) => [tr(f).children[0].characters, propOf(tr(f).children[1], 'Label')].join(' / ');
  check(back && propOf(back, 'Label') === 'Roles' && /Variant=Ghost/.test(instMain(back)) && h1Badge(cust) === 'Content editor / Custom' && h1Badge(ed(EDITOR_ADMIN[3])) === 'Copy of Seller reviewer / Custom' && ed(EDITOR_ADMIN[3]).findOne((x) => x.type === 'INSTANCE' && x.name === 'field-role-name') && textsOf(ed(EDITOR_ADMIN[3]).findOne((x) => x.name === 'field-role-name')).includes('Copy of Seller reviewer'), label + ': the editor has the "Roles" back link (Ghost), the role name as H1 with its type badge, and the duplicate is named "Copy of Seller reviewer"');
  const bar = (f) => f.findOne((x) => x.name === 'Action bar');
  check(bar(cust) && textsOf(bar(cust)).join() === 'Save role,Cancel' && bar(cust).parent.name === 'Column' && bar(cust).parent.children[bar(cust).parent.children.length - 1] === bar(cust) && textsOf(cust).includes('Roles') && textsOf(cust).includes('New features are never added to a custom role automatically. You choose when to add them.') && cust.findOne((x) => x.name === 'Content column').width === 760, label + ': the custom role has the back link, the R10 line, a 760 px content column and the Save role / Cancel bar at the end of the page');
  const dft = ed(EDITOR_ADMIN[1]), sys = ed(EDITOR_ADMIN[2]);
  check([dft, sys].every((f) => permRowsOf(f).length === 14 && permRowsOf(f).every((i) => /State=Read-only/.test(instMain(i))) && !bar(f) && !f.findOne((x) => x.name === 'select-all-checkbox') && !counterOf(f)) && permRowsOf(sys).every((i) => /Value=Checked/.test(instMain(i))) && textsOf(dft).includes('Duplicate') && textsOf(dft).includes('Default role from MondaPac.') && textsOf(sys).includes('System role.'), label + ': Default and System roles are read-only (no bar, no Select all), with their banners; Default offers Duplicate and System has every permission');
  const dup = ed(EDITOR_ADMIN[3]);
  check(textsOf(dup).includes('Some permissions weren’t copied because you can’t give them.') && dup.findOne((x) => x.name === 'banner').findOne((x) => x.name === 'body').visible === false && permRowsOf(dup).filter((i) => propOf(i, 'Label') === 'Add sellers').every((i) => /Value=Unchecked, State=Disabled/.test(instMain(i)) && propOf(i, 'Description') === NOT_HELD_COPY) && counterOf(dup) === '3 of 14 permissions selected' && permRowsOf(dup).filter((i) => /Value=Checked/.test(instMain(i))).length === 3, label + ': Duplicate names the copy, says why some permissions were not copied and leaves them unticked with the reason');
  const er = ed(EDITOR_ADMIN[4]);
  check(textsOf(er).includes('A role with this name already exists.') && instsOf(er, /State=Error/).some((i) => i.name === 'control'), label + ': Errors shows "A role with this name already exists." under the name field');
  const sc = ed(EDITOR_SELLER[0]); const sr = permRowsOf(sc);
  check(sr.length === 4 && counterOf(sc) === '2 of 4 permissions selected' && sr.filter((i) => propOf(i, 'Show badge') === true).every((i) => propOf(i, 'Description') === PROTECTED_SELLER_COPY && /State=Disabled/.test(instMain(i))) && sr.filter((i) => propOf(i, 'Show badge') === true).length === 2 && textsOf(sc).includes('Only a few permissions exist so far.'), label + ': the seller custom role has the 4 rows, the 2 protected ones say "' + PROTECTED_SELLER_COPY + '", and the early-catalogue banner shows');
  const nw = ed(EDITOR_SELLER[3]);
  check(counterOf(nw) === '0 of 4 permissions selected' && instsOf(bar(nw), /State=Default/).some((b) => textsOf(b).join() === 'Save role'), label + ': a new role with nothing ticked can still be saved');
  check(textsOf(ed(EDITOR_SELLER[1])).includes('Ready-made role from MondaPac.') && textsOf(ed(EDITOR_SELLER[2])).includes('Owner role.') && permRowsOf(ed(EDITOR_SELLER[2])).every((i) => /Value=Checked, State=Read-only/.test(instMain(i))), label + ': Ready-made and Owner roles are read-only with their banners');
  const ep = F(EDITOR_PHONE);
  check(ep.width === 360 && ep.minHeight === 780 && ep.height >= 780 && ep.layoutSizingVertical === 'HUG' && ep.children[ep.children.length - 1].name === 'Action bar' && ep.getPluginData('density') === 'touch' && permRowsOf(ep).length === 4, label + ': the seller phone editor is 360 wide, at least 780 high, touch density, with the bar at the bottom');
  // copy that must not be there
  const allTxt = ADMIN_183.concat(SELLER_183).map((n) => textsOf(F(n)).join('\n')).join('\n') + BODIES_183.map((n) => textsOf(compOf(M, n)).join('\n')).join('\n');
  const permTxt = ADMIN_183.concat(SELLER_183).map((n) => permRowsOf(F(n)).map((i) => propOf(i, 'Label') + ' ' + propOf(i, 'Description')).join('\n')).join('\n');
  check(!/Seller name|Your name|Placeholder:/.test(allTxt) && !/Australia|Halal|halal|AU\b|AUD/.test(permTxt), label + ': no "Seller name" or "Your name" label, and no Market or vertical name in a permission row');
}

// Step 2 of an update scenario: the 1.7.0 file gets 1.8.0 from the current code.
async function updateTo180(M, label, opts, from) {
  console.log('\n■ ' + label + ' · step 2: 1.7.0 to 1.8.0 with the current plugin');
  load(M, CODE);
  const nColl = opts.maxModes > 1 ? 1 : 2;
  const before = allNodes(M); const beforeIds = new Set(before.map((n) => n.id)); const nVars = M.VARS.size;
  const snap = (n) => JSON.stringify([n.name, n.fills, n.name === 'Row' ? null : n.strokes, n.name === 'Row' ? null : n.boundVariables, n.type === 'TEXT' ? n.characters : null]);
  const beforeSnap = new Map(before.map((n) => [n.id, snap(n)]));
  const tc0 = setOf(M, 'TableCell'); const tcBefore = tc0.children.map((c) => [c.id, c.name, c.x, c.y, c.width, c.height].join('|'));
  const tcInst = (X) => allNodes(X).filter((n) => n.type === 'INSTANCE' && n._main && n._main.parent && n._main.parent.name === 'TableCell' && n._main.parent.type === 'COMPONENT_SET');
  const instBefore = new Map(tcInst(M).map((n) => [n.id, JSON.stringify([n._main.id, n.componentProperties, n.width, n.height])]));
  const sidebar0 = setOf(M, 'Sidebar'); const sbSnap = sidebar0.findAll(() => true).map((n) => n.id + n.name).join();
  const fieldDesc0 = compOf(M, 'Field').description;
  check(NEW_180.every((n) => !setOf(M, n) && !compOf(M, n)) && ![...M.VARS.values()].some((v) => v.name === 'size/dialog-sm' || v.name === 'size/dialog-md') && tc0.children.length === 11 && instBefore.size > 0 && fieldDesc0.includes(FIELD_DESC_17) && frameNamed(M, 'Shared · Members · Admin').length === 0, 'the 1.7.0 file has none of the 1.8.0 items (TableCell has 11 variants and ' + instBefore.size + ' instances)');
  let r = await send(M, { type: 'update' });
  check(!r.err, 'Update library finished' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  if (r.done) console.log('    ' + r.done.report.join('\n    '));
  const warn = (r.done ? r.done.report : []).filter((l) => l.indexOf('⚠') === 0 || l.indexOf('ℹ skipped') === 0);
  check(warn.length === 0, 'no warnings or skips in the update report');
  const added = r.done ? r.done.added : [];
  check(NEW_180.every((n) => added.includes('component ' + n)) && added.includes('variants added to TableCell (5): State=Loading') && added.includes('update TableCell description') && added.includes('update Field description') && added.includes('Field Control: preferred values Input, Select, Textarea') && added.includes('templates Panel · Admin (' + ADMIN_180.length + ' frames, 3 template bodies)') && added.includes('templates Panel · Seller (' + SELLER_180.length + ' frames, 2 template bodies)') && added.includes(ADDED_183[0]) && added.includes(ADDED_183[1]), 'the report names every addition, including "variants added to TableCell (5)" and the 1.8.3 frames');
  check(added.includes('variable size/dialog-sm' + (opts.maxModes > 1 ? ' (Desktop and Touch modes)' : ' (Dimension and Dimension · Touch)')) && added.includes('size table row size/dialog-sm') && added.includes('size table row size/dialog-md') && added.includes('changelog row 1.8.0') && added.includes('changelog row 1.8.1') && added.includes('changelog row 1.8.3') && added.includes('file version ' + SPEC_VERSION), 'the report names the tokens, size table rows, changelog row and the file version');
  check(M.VARS.size === nVars + 2 * nColl, 'exactly ' + (2 * nColl) + ' variables added (' + (M.VARS.size - nVars) + ')');
  state180(M, opts, 'updated');
  state181(M, 'updated', true); // overlaps of the update path are checked just below: reported, not absent
  state183(M, 'updated');
  { const rep = r.done ? r.done.report : []; const ovs = overlapsOf(M); const un = ovs.filter((o) => { const parts = o.split(': ')[1].split(' / '); return !rep.some((l) => l.indexOf('\u2139 overlap: ' + parts[0] + ' and ' + parts[1]) === 0); });
    check(un.length === 0, 'updated: every overlap of top-level nodes (' + ovs.length + ', e.g. Starter sections that grew) is reported, none is fixed by moving' + (un.length ? ' (unreported: ' + un.slice(0, 3).join(' | ') + ')' : '')); }
  check(M.ROOT.getPluginData('version') === SPEC_VERSION && SPEC_VERSION === '1.8.3', 'file version is ' + SPEC_VERSION);
  check(textCount(M, SPEC_VERSION) >= 2 && allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && n.findOne((x) => x.type === 'TEXT' && x.characters === SPEC_VERSION)).length === 1, 'one changelog row for ' + SPEC_VERSION + ' (and the cover shows it)');
  check(['size/dialog-sm', 'size/dialog-md'].every((v) => allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && n.findOne((x) => x.type === 'TEXT' && x.characters === v)).length === 1), 'one size table row each for size/dialog-sm and size/dialog-md');
  // the in-place edit of TableCell: nothing existing was renamed, moved, resized or changed
  const tc1 = setOf(M, 'TableCell');
  check(tc1 === tc0 && tcBefore.every((k) => tc1.children.some((c) => [c.id, c.name, c.x, c.y, c.width, c.height].join('|') === k)), 'the 11 existing TableCell variants keep their ids, names, positions and sizes');
  const fresh = tc1.children.filter((c) => !beforeIds.has(c.id));
  check(fresh.length === 5 && fresh.every((c) => /State=Loading/.test(c.name)) && fresh.every((c) => c.x > Math.max.apply(null, tc0.children.filter((k) => beforeIds.has(k.id)).map((k) => k.x + k.width)) - 0.5), 'the 5 new variants are State=Loading and sit in a new column to the right of the existing ones');
  const instAfter = new Map(tcInst(M).filter((n) => instBefore.has(n.id)).map((n) => [n.id, JSON.stringify([n._main.id, n.componentProperties, n.width, n.height])]));
  check(instAfter.size === instBefore.size && [...instBefore].every((e) => instAfter.get(e[0]) === e[1]), 'all ' + instBefore.size + ' existing TableCell instances keep their main component, property values and size');
  check(setOf(M, 'Sidebar') === sidebar0 && sidebar0.findAll(() => true).map((n) => n.id + n.name).join() === sbSnap, 'the existing Sidebar is not touched');
  const after = allNodes(M);
  const gone = before.filter((n) => n.removed || !M.byId.has(n.id));
  check(gone.length === 0, 'no existing node was deleted or replaced (' + gone.length + ')');
  // The Usage panels beside Input and AuthShowcase are re-fitted to the re-laid-out sets (layout fix for 1.7.0).
  const refit = new Set(['Input', 'AuthShowcase'].map((k) => setOf(M, k)).filter((x) => x && x.parent && x.parent.name === 'Component + usage').map((x) => (x.parent.children.find((c) => c.name === 'Usage') || {}).id));
  const changed = before.filter((n) => M.byId.has(n.id) && !refit.has(n.id) && snap(n) !== beforeSnap.get(n.id) && !(n.type === 'TEXT' && (n.characters.indexOf(SPEC_VERSION) >= 0 || /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(n.characters))));
  check(changed.length === 0, 'no existing node changed its name, paints, bindings or text, apart from the cover version and date and the Usage panels of Input and AuthShowcase (' + changed.length + (changed.length ? ': ' + changed.slice(0, 5).map((n) => n.name).join(', ') : '') + ')');
  const freshNodes = after.filter((n) => !beforeIds.has(n.id));
  const tops = freshNodes.filter((n) => n.parent && beforeIds.has(n.parent.id)).map((n) => n.name);
  const okTops = new Set(NEW_180.concat(ADMIN_180, SELLER_180, BODIES_180, ADMIN_183, SELLER_183, BODIES_183, ['Row', 'Select', 'Dialog', 'DialogBody']));
  const stray = tops.filter((n) => !okTops.has(n) && !/^(Variant|Type|State|Size)=/.test(n));
  check(stray.length === 0, 'new layers sit only in the expected places (' + tops.length + ' roots' + (stray.length ? '; unexpected: ' + stray.join(', ') : '') + ')');
  const a = audit(M, label);
  check(BUILD_COUNTS && a.sets.length === BUILD_COUNTS.sets && a.comps === BUILD_COUNTS.comps && a.variants === BUILD_COUNTS.variants, 'the updated file has the same components as a new 1.8.0 build (' + a.sets.length + ' sets, ' + a.comps + ' standalone components, ' + a.variants + ' variants)');
  const ar = await send(M, { type: 'audit' });
  const bad = ar.done ? ar.done.report.filter((l) => l.indexOf('⚠') === 0) : ['no audit'];
  check(bad.length === 0, 'Audit file has zero warnings after the update' + (bad.length ? ': ' + bad.join(' | ') : ''));
  for (const name of ['Shared · Members · Seller', 'Dialogs · Members · Admin', 'Dialog sheet · Change role (phone)']) {
    const src = frameNamed(M, name)[0];
    const clone = src.clone(); clone.name = 'tmp dark';
    await M.figma.setCurrentPageAsync(clone.page()); M.figma.currentPage.selection = [clone];
    r = await send(M, { type: 'theme', theme: 'dark' });
    const lightColl = [...M.COLLS.values()].find((c) => c.name === 'Color');
    const leaks = [clone].concat(clone.findAll(() => true)).filter((n) => (n._fills || []).concat(n._strokes || []).some((p) => p.boundVariables && !n.instAncestor() && M.VARS.get(p.boundVariables.color.id).variableCollectionId === lightColl.id && !M.COLLS.get(lightColl.id).modes[1]));
    check(!r.err && (leaks.length === 0 || lightColl.modes.length > 1), 'Dark theme applies to ' + name + ' and leaves no light variable (' + leaks.length + ' left)' + (r.err ? ': ' + r.err.message : ''));
    clone.remove();
  }
  // second run is a no-op
  const ids2 = new Set(after.filter((n) => !n.removed).map((n) => n.id)); const vars2 = M.VARS.size; const n2 = allNodes(M).length;
  r = await send(M, { type: 'update' });
  check(!r.err && r.done && r.done.added.length === 0, 'second Update library adds nothing' + (r.err ? ': ' + r.err.message : (r.done && r.done.added.length ? ': ' + r.done.added.join(', ') : '')));
  const after2 = allNodes(M);
  check(after2.length === n2 && after2.every((n) => ids2.has(n.id)) && M.VARS.size === vars2 && tc1.children.length === 16, 'second Update library changes no layer, variant or variable');
  r = await send(M, { type: 'export', version: SPEC_VERSION });
  if (r.done) { compareExport(r.done.files, label + ' export'); check(r.done.files['tokens.css'].includes('--mp-size-dialog-sm: 400px;') && r.done.files['tokens.css'].includes('--mp-size-dialog-md: 560px;') && r.done.files['dimension.touch.json'].includes('"dialog-md"') && r.done.files['dimension.desktop.json'].includes('"dialog-md"'), 'export writes size/dialog-sm and size/dialog-md (byte for byte with docs/design/tokens)'); }
  return M;
}

async function updateScenario(label, opts, from) {
  console.log('\n■ ' + label);
  let M;
  if (from === '1.7.0') { M = (await olderFile(opts, '1.7.0')).M; check(M.ROOT.getPluginData('version') === '1.7.0', 'built a 1.7.0 library with the 1.7.0 plugin'); }
  else M = await updateTo170(label, opts, from);
  return updateTo180(M, label, opts, from);
}

(async function main() {
  // Icon data: every icon must be distinct and well formed (a broken extraction once made 14 icons identical).
  console.log('\n■ Icon data');
  const ICONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'icons.json'), 'utf8'));
  const seen = {}; const dup = []; const bad = [];
  Object.keys(ICONS).forEach((k) => { const v = ICONS[k]; if (seen[v]) dup.push(k + '=' + seen[v]); seen[v] = k; if (!/^<svg [^>]*>(<(path|circle|rect|line|polyline|polygon|ellipse)\b[^<]*><\/\2>|<(path|circle|rect)\b[^<]*\/>)+<\/svg>$/.test(v)) bad.push(k); });
  check(dup.length === 0, Object.keys(ICONS).length + ' icons are all different' + (dup.length ? ': ' + dup.join(', ') : ''));
  check(bad.length === 0, 'every icon is a clean SVG' + (bad.length ? ': ' + bad.join(', ') : ''));

  // 1 · Starter plan (1 mode), all fonts available
  console.log('\n■ Scenario 1 · Starter plan, IBM Plex available');
  let t = Date.now();
  let M = start({ maxModes: 1, maxPages: 3 });
  let r = await send(M, { type: 'build' });
  check(!r.err, 'build finished without error' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  if (r.done) { console.log('  report:\n    ' + r.done.report.join('\n    ')); }
  const warn = (r.done ? r.done.report : []).filter((l) => l.indexOf('⚠') === 0);
  check(warn.length === 0, 'no warnings in the report');
  console.log('  time ' + (Date.now() - t) + ' ms');
  const a1 = audit(M, 's1');
  BUILD_COUNTS = { sets: a1.sets.length, comps: a1.comps, variants: a1.variants };
  console.log('  a new build holds ' + BUILD_COUNTS.sets + ' sets, ' + BUILD_COUNTS.comps + ' standalone components and ' + BUILD_COUNTS.variants + ' variants');
  state180(M, { maxModes: 1 }, 'new build (Starter)');
  state181(M, 'new build (Starter)');
  state183(M, 'new build (Starter)');
  // dark preview: no paint should still use the light Color collection
  const findHost = (name) => M.ROOT.children.find((p) => p.name === name) || M.ROOT.children.map((p) => p.children.find((n) => n.type === 'SECTION' && n.name === name)).find(Boolean);
  const darkPage = findHost('Templates · Dark preview');
  check(M.ROOT.children.length === 3, 'Starter layout uses 3 pages (got ' + M.ROOT.children.length + ': ' + M.ROOT.children.map((p) => p.name).join(', ') + ')');
  const secs = []; M.ROOT.children.forEach((p) => p.children.forEach((n) => { if (n.type === 'SECTION') secs.push(n.name + ' ' + Math.round(n.width) + '×' + Math.round(n.height) + ' @' + Math.round(n.x) + ',' + Math.round(n.y)); }));
  console.log('  sections: ' + secs.join(' | '));
  check(secs.length === 23, '23 sections (got ' + secs.length + ')');
  const lightColl = [...M.COLLS.values()].find((c) => c.name === 'Color');
  const lightBound = darkPage.findAll((n) => n.type !== 'TEXT' || true).filter((n) => n.y >= 0 && n.parent !== darkPage ? true : n.parent === darkPage && n.type === 'FRAME' && n.height > 400)
    .filter((n) => (n._fills || []).concat(n._strokes || []).some((p) => p.boundVariables && M.VARS.get(p.boundVariables.color.id).variableCollectionId === lightColl.id));
  const screens = darkPage.children.filter((n) => n.type === 'FRAME' && n.getPluginData('theme') === 'dark');
  check(screens.length === 6, 'dark preview has 6 themed screens');
  const darkArea = darkPage.findAll((n) => n.name === 'service-area')[0];
  check(darkArea && darkArea._fills[0].opacity === 0.04, 'theme switching keeps paint opacity (dark service-area 4%)');
  const leaks = []; screens.forEach((s) => [s].concat(s.findAll(() => true)).forEach((n) => (n._fills || []).concat(n._strokes || []).forEach((p) => { if (p.boundVariables && M.VARS.get(p.boundVariables.color.id).variableCollectionId === lightColl.id) leaks.push(pathOf(n)); })));
  check(leaks.length === 0, 'dark screens use only dark variables (' + leaks.length + ' light leftovers)' + (leaks.length ? ': ' + leaks.slice(0, 4).join(' | ') : ''));
  r = await send(M, { type: 'audit' });
  check(!r.err && r.done, 'audit command runs' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  if (r.done) console.log('    ' + r.done.report.filter((l) => !/^    /.test(l)).join('\n    '));
  // second build without force must refuse
  r = await send(M, { type: 'build' });
  check(r.err && /already has/.test(r.err.message), 'second build without Rebuild is refused');
  // export
  r = await send(M, { type: 'export', version: SPEC_VERSION });
  check(!r.err, 'export finished' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  if (r.done) compareExport(r.done.files, 'starter');
  // theme commands on a selection
  const adminHost = findHost('Templates · Admin'); const adminPage = adminHost.page();
  await M.figma.setCurrentPageAsync(adminPage);
  adminPage.selection = [adminHost.children.find((n) => n.type === 'FRAME' && n.width > 1000)];
  r = await send(M, { type: 'theme', theme: 'dark' }); check(!r.err, 'Dark theme on selection' + (r.err ? ': ' + r.err.message : ''));
  r = await send(M, { type: 'theme', theme: 'light' }); check(!r.err, 'Light theme on selection' + (r.err ? ': ' + r.err.message : ''));
  r = await send(M, { type: 'density', density: 'touch' }); check(!r.err, 'Touch density on selection' + (r.err ? ': ' + r.err.message : ''));
  r = await send(M, { type: 'density', density: 'desktop' }); check(!r.err, 'Desktop density on selection' + (r.err ? ': ' + r.err.message : ''));
  // rebuild
  r = await send(M, { type: 'build', force: true });
  check(!r.err, 'Rebuild finished' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  check(M.ROOT.children.length === 3, 'Rebuild leaves 3 pages (got ' + M.ROOT.children.length + ')');
  check([...M.COLLS.values()].length === 7, 'Rebuild leaves 7 collections (got ' + M.COLLS.size + ')');
  // upgrade after plan change
  r = await send(M, { type: 'upgrade' });
  check(r.err && /Starter/.test(r.err.message), 'upgrade on Starter explains the limit');
  M.setMaxModes(4); M.setMaxPages(Infinity);
  r = await send(M, { type: 'upgrade' });
  check(!r.err, 'Upgrade to modes' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  if (r.done) console.log('    ' + r.done.report.join('\n    '));
  check([...M.COLLS.values()].map((c) => c.name).sort().join(',') === 'Color,Dimension,Motion,Primitives,Typography', 'parallel collections removed after upgrade');
  check(M.ROOT.children.length === 27, 'upgrade split sections into 27 pages (got ' + M.ROOT.children.length + ': ' + M.ROOT.children.map((p) => p.name + '(' + p.children.length + ')').join(', ') + ')');
  const orphan = []; M.ROOT.children.forEach((p) => p.findAll(() => true).forEach((n) => (n._fills || []).concat(n._strokes || []).forEach((pp) => { if (pp.boundVariables && !M.VARS.get(pp.boundVariables.color.id)) orphan.push(pathOf(n)); })));
  check(orphan.length === 0, 'no layer is bound to a deleted variable after upgrade (' + orphan.length + ')');
  r = await send(M, { type: 'export', version: SPEC_VERSION });
  if (r.done) compareExport(r.done.files, 'after upgrade');

  // 2 · Professional plan (modes allowed from the start)
  console.log('\n■ Scenario 2 · Professional plan (modes)');
  M = start({ maxModes: 4 });
  r = await send(M, { type: 'build' });
  check(!r.err, 'build finished' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  check(M.ROOT.children.length === 27, 'full layout uses 27 pages (got ' + M.ROOT.children.length + ')');
  const a2 = audit(M, 's2');
  check(a2.sets.length === BUILD_COUNTS.sets && a2.comps === BUILD_COUNTS.comps && a2.variants === BUILD_COUNTS.variants, 'the modes layout builds the same components as the Starter layout');
  state180(M, { maxModes: 4 }, 'new build (modes)');
  state181(M, 'new build (modes)');
  state183(M, 'new build (modes)');
  r = await send(M, { type: 'export', version: SPEC_VERSION });
  if (r.done) compareExport(r.done.files, 'modes');

  // 3 · IBM Plex not available
  console.log('\n■ Scenario 3 · IBM Plex missing (fallback fonts)');
  M = start({ maxModes: 1, maxPages: 3, fonts: ['Inter|Regular', 'Inter|Medium', 'Inter|Semi Bold', 'Inter|Bold', 'Roboto Mono|Regular', 'Roboto Mono|Medium'] });
  r = await send(M, { type: 'build' });
  check(!r.err, 'build finished with fallback fonts' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  if (r.done) console.log('    ' + r.done.report.filter((l) => l.indexOf('⚠') === 0).slice(0, 3).join('\n    ') + ' …');

  // 4 · Non-empty file
  console.log('\n■ Scenario 4 · Non-empty file');
  M = start({ maxModes: 1 });
  M.figma.createFrame();
  r = await send(M, { type: 'build' });
  check(r.err && /empty/.test(r.err.message), 'build refuses a non-empty file');

  // 5, 6 · Update library on 1.0.0, 1.5.0, 1.6.0 and 1.7.0 files (Starter layout, then modes layout). The first three go to 1.7.0 with the 1.7.0 plugin, then every file to 1.8.0
  await updateScenario('Scenario 5a · Update library on a 1.0.0 file (Starter plan, parallel collections)', { maxModes: 1, maxPages: 3 }, '1.0.0');
  await updateScenario('Scenario 5b · Update library on a 1.5.0 file (Starter plan, parallel collections)', { maxModes: 1, maxPages: 3 }, '1.5.0');
  await updateScenario('Scenario 5c · Update library on a 1.6.0 file (Starter plan, parallel collections)', { maxModes: 1, maxPages: 3 }, '1.6.0');
  await updateScenario('Scenario 5d · Update library on a 1.7.0 file (Starter plan, parallel collections)', { maxModes: 1, maxPages: 3 }, '1.7.0');
  await updateScenario('Scenario 6a · Update library on a 1.0.0 file (modes, full page layout)', { maxModes: 4 }, '1.0.0');
  await updateScenario('Scenario 6b · Update library on a 1.5.0 file (modes, full page layout)', { maxModes: 4 }, '1.5.0');
  await updateScenario('Scenario 6c · Update library on a 1.6.0 file (modes, full page layout)', { maxModes: 4 }, '1.6.0');
  await updateScenario('Scenario 6d · Update library on a 1.7.0 file (modes, full page layout)', { maxModes: 4 }, '1.7.0');

  // 7 · Update library refuses files it must not touch
  console.log('\n■ Scenario 7 · Update library guards');
  M = start({ maxModes: 1 });
  r = await send(M, { type: 'update' });
  check(r.err && /empty/.test(r.err.message), 'Update library refuses an empty file');
  M = start({ maxModes: 1 });
  M.figma.createFrame();
  r = await send(M, { type: 'update' });
  check(r.err && /no MondaPac library/.test(r.err.message), 'Update library refuses a file without the library');
  M = start({ maxModes: 1, maxPages: 3 });
  r = await send(M, { type: 'build' });
  const n0 = allNodes(M).length;
  r = await send(M, { type: 'update' });
  check(!r.err && r.done.added.length === 0 && allNodes(M).length === n0, 'Update library on a current ' + SPEC_VERSION + ' file is a no-op');
  const drawerLists = () => allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'items' && n.parent && n.parent.type === 'COMPONENT' && n.parent.parent && n.parent.parent.name === 'NavDrawer');
  check(drawerLists().length === 2 && drawerLists().every((l) => l.itemSpacing === 0), 'NavDrawer item lists have no gap (both variants)');
  drawerLists().forEach((l) => { l.itemSpacing = 2; });
  r = await send(M, { type: 'update' });
  check(!r.err && r.done.added.some((a) => /fix NavDrawer item spacing \(2 variants\)/.test(a)) && drawerLists().every((l) => l.itemSpacing === 0) && allNodes(M).length === n0, 'Update library fixes the item gap of an earlier 1.5.0 NavDrawer without adding or removing layers');
  r = await send(M, { type: 'update' });
  check(!r.err && r.done.added.length === 0, 'and a second run is again a no-op');

  // 8 · the in-place phone template fixes touch only what the plugin made
  console.log('\n■ Scenario 8 · In-place fix guards (1.5.0 file, 1.7.0 plugin)');
  async function guardFile() {
    const F = await olderFile({ maxModes: 1, maxPages: 3 }, '1.5.0');
    const X = F.M; const lg = F.legacy;
    const tpl = (n) => allNodes(X).find((x) => x.type === 'FRAME' && x.name === n);
    const bar = (n) => tpl(n).children.find((c) => c.name === 'Topbar · phone' || c.name === 'PhoneTopbar');
    return { X, lg, tpl, bar };
  }
  let G = await guardFile();
  let X = G.X;
  // a. wrong shape in a tagged template; b. matching frame in an untagged screen; c. frame outside templates; d. topbar already gone; e. renamed template
  const wrong = G.bar('Seller · Home (phone)'); wrong.children[3].remove();
  G.tpl('Seller · Menu open (phone)').setPluginData('mondapac-ds', '');
  const sellerHost = G.tpl('Seller · Home (phone)').parent; const outside = legacyFrame(X); sellerHost.appendChild(outside);
  const gone = G.bar('Admin · Menu open (phone)'); gone.remove();
  const untaggedOld = G.bar('Seller · Menu open (phone)');
  r = await send(X, { type: 'update' });
  check(!r.err && r.done, 'update runs on the guard file without error' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  const rep = r.done ? r.done.report.concat(r.done.added) : [];
  check(!wrong.removed && wrong.parent === G.tpl('Seller · Home (phone)') && rep.includes('ℹ skipped Topbar · phone in Seller · Home (phone): not the plugin\'s frame'), 'a Topbar · phone frame with the wrong shape in a plugin template survives and is reported');
  check(!untaggedOld.removed && !rep.some((l) => /skipped Topbar · phone in Seller · Menu open/.test(l)), 'a matching frame inside an untagged screen survives');
  check(!outside.removed && outside.parent === sellerHost, 'a matching frame outside the templates survives');
  check(!G.tpl('Admin · Menu open (phone)').children.some((c) => c.name === 'PhoneTopbar'), 'a template whose old topbar is already gone does not get a PhoneTopbar re-added');
  check(!rep.some((l) => /swap phone topbar/.test(l)), 'no swap is reported when nothing qualified');
  check(rep.includes('bind drawer scrim to bg/scrim (1 templates)') || rep.some((l) => /bind drawer scrim to bg\/scrim \(\d templates\)/.test(l)), 'the scrim fix runs only on plugin templates (' + rep.filter((l) => /scrim to/.test(l)).join() + ')');
  r = await send(X, { type: 'update' });
  check(!r.err && r.done.added.length === 0, 'second update on the guard file adds nothing');
  // renamed template: skipped without a crash, its old frame stays
  G = await guardFile(); X = G.X;
  const renamed = G.tpl('Seller · Home (phone)'); const renamedBar = G.bar('Seller · Home (phone)'); renamed.name = 'My own home';
  r = await send(X, { type: 'update' });
  check(!r.err && !renamedBar.removed && renamedBar.parent === renamed, 'a renamed phone template is skipped without a crash and keeps its topbar frame' + (r.err ? ': ' + r.err.message : ''));
  check(r.done && r.done.added.includes('swap phone topbar for PhoneTopbar (2 templates)') && r.done.added.includes('bind drawer scrim to bg/scrim (2 templates)'), 'the report counts only the two templates that qualified');
  // a PhoneTopbar set that is not the plugin's: no swap, clash reported
  G = await guardFile(); X = G.X;
  const mine = X.figma.createComponent(); mine.name = 'Workspace=Admin';
  const theirs = X.figma.combineAsVariants([mine], X.figma.currentPage); theirs.name = 'PhoneTopbar';
  r = await send(X, { type: 'update' });
  check(!r.err && r.done && r.done.report.some((l) => /skipped phone topbar swap: a PhoneTopbar component set that is not the plugin's/.test(l)) && !r.done.added.some((l) => /swap phone topbar/.test(l)) && allNodes(X).filter((n) => n.name === 'Topbar · phone').length === 3, 'a PhoneTopbar set that is not the plugin\'s blocks the swap and is reported' + (r.err ? ': ' + r.err.message : ''));

  // 9 · 1.7.0 additions touch only the plugin's own sets, and fill in only what is missing
  console.log('\n■ Scenario 9 · 1.7.0 update guards (1.6.0 file, 1.7.0 plugin)');
  const STARTER = { maxModes: 1, maxPages: 3 };
  const reportOf = (res) => (res.done ? res.done.report.concat(res.done.added) : []);
  const noOpAgain = async (Y, what) => { const n = allNodes(Y).length; const res = await send(Y, { type: 'update' }); check(!res.err && res.done && res.done.added.length === 0 && allNodes(Y).length === n, what + ': a second run is a no-op' + (res.done && res.done.added.length ? ' (' + res.done.added.join(', ') + ')' : '')); };
  // a. an Input set that is not the plugin's: no Type axis, no Field, no Auth templates; the rest still arrives
  let Y = (await olderFile(STARTER, '1.6.0')).M;
  const foreignInput = setOf(Y, 'Input'); foreignInput.setPluginData('mondapac-ds', ''); const inputNames = foreignInput.children.map((c) => c.name).join();
  r = await send(Y, { type: 'update' });
  let rep9 = reportOf(r);
  check(!r.err && r.done, 'update runs with a foreign Input set' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  check(foreignInput.children.map((c) => c.name).join() === inputNames && foreignInput.children.length === 6, 'the foreign Input set keeps its 6 variants and names');
  check(rep9.some((l) => /ℹ skipped Input variants Password and Code: the Input set is not the plugin's/.test(l)) && rep9.some((l) => /ℹ skipped component Field: it needs the plugin's Input/.test(l)) && rep9.some((l) => /ℹ skipped Auth templates: they need the plugin's .*Input/.test(l)), 'Input, Field and the Auth templates are skipped and reported');
  check(!setOf(Y, 'Field') && !compOf(Y, 'Field') && !hostNamed(Y, 'Templates · Auth'), 'no Field and no Templates · Auth were made');
  check(setOf(Y, 'Button').children.length === 75 && compOf(Y, 'BrandMark') && S1_FRAMES.every((n) => countNamed(Y, 'FRAME', n) === 1), 'the other 1.7.0 additions (Button variants, BrandMark, S1 templates) still arrive');
  await noOpAgain(Y, 'foreign Input');
  // b. a Topbar set that is not the plugin's: no new Topbar properties and no S1 templates
  Y = (await olderFile(STARTER, '1.6.0')).M;
  const foreignTopbar = setOf(Y, 'Topbar'); foreignTopbar.setPluginData('mondapac-ds', '');
  r = await send(Y, { type: 'update' }); rep9 = reportOf(r);
  check(!r.err && !keysOf(foreignTopbar).includes('Show search') && rep9.some((l) => /ℹ skipped Topbar properties Show search and Show notifications/.test(l)), 'a foreign Topbar gets no properties and is reported' + (r.err ? ': ' + r.err.message : ''));
  check(S1_FRAMES.every((n) => countNamed(Y, 'FRAME', n) === 0) && rep9.some((l) => /ℹ skipped Seller · Your seller account templates: they need the plugin's Topbar/.test(l)), 'the S1 templates are skipped and reported');
  check(hostNamed(Y, 'Templates · Auth') && hostNamed(Y, 'Templates · Auth').children.filter((n) => /^Auth · /.test(n.name)).length === AUTH_FRAMES, 'the Auth templates (which do not use Topbar) are still added');
  await noOpAgain(Y, 'foreign Topbar');
  // c. a component named Field that is not the plugin's: Field and the Auth templates are skipped, the foreign one is untouched
  Y = (await olderFile(STARTER, '1.6.0')).M;
  const theirField = Y.figma.createComponent(); theirField.name = 'Field'; theirField.description = 'Our own field';
  r = await send(Y, { type: 'update' }); rep9 = reportOf(r);
  check(!r.err && countNamed(Y, 'COMPONENT', 'Field') === 1 && compOf(Y, 'Field') === theirField && theirField.description === 'Our own field', 'the foreign Field component is kept as it is and no second Field is made' + (r.err ? ': ' + r.err.message : ''));
  check(rep9.some((l) => /ℹ skipped component Field: a component named Field that is not the plugin's/.test(l)) && rep9.some((l) => /ℹ skipped Auth templates: they need the plugin's Field/.test(l)) && !hostNamed(Y, 'Templates · Auth'), 'Field and the Auth templates are skipped and reported');
  await noOpAgain(Y, 'foreign Field');
  // d. partly updated: some new Button variants and Auth frames deleted; only those come back
  Y = (await olderFile(STARTER, '1.6.0')).M;
  r = await send(Y, { type: 'update' });
  check(!r.err && r.done && r.done.added.length > 0, 'first update of the partial file');
  const gone9 = ['Variant=Link, Size=Sm, State=Disabled', 'Variant=Ghost, Size=Md, State=Loading'];
  setOf(Y, 'Button').children.filter((c) => gone9.includes(c.name)).forEach((c) => c.remove());
  const authHost = hostNamed(Y, 'Templates · Auth');
  const goneFrames = ['Auth · Seller · A3 Check your email', 'Auth · Admin · A5 Forgot password · Sent'].map((n) => authHost.children.find((c) => c.name === n)).filter(Boolean);
  const goneNames = goneFrames.map((f) => f.name); goneFrames.forEach((f) => f.remove());
  check(setOf(Y, 'Button').children.length === 73 && goneNames.length === 2, 'removed 2 Button variants and 2 Auth frames (' + goneNames.join(', ') + ')');
  r = await send(Y, { type: 'update' });
  const add9 = r.done ? r.done.added : [];
  check(!r.err && add9.length === 2 && add9.includes('Button variants (2): Variant=Link and State=Loading') && add9.includes('templates Auth (2 frames)'), 'the update re-adds only those (' + add9.join(', ') + ')');
  check(setOf(Y, 'Button').children.length === 75 && gone9.every((n) => setOf(Y, 'Button').children.filter((c) => c.name === n).length === 1) && goneNames.every((n) => authHost.children.filter((c) => c.name === n).length === 1), 'Button has 75 variants again and each frame exists once');
  await noOpAgain(Y, 'partial file');

  // 10 · release 1.8.0: what Update library refuses, skips and repairs (1.7.0 files)
  console.log('\n■ Scenario 10 · 1.8.0 update guards');
  const rep10 = (res) => (res.done ? res.done.report.concat(res.done.added) : []);
  const fileOf = async () => { const Y = (await olderFile(STARTER, '1.7.0')).M; load(Y, CODE); return Y; };
  const noOp10 = async (Y, what) => { const n = allNodes(Y).length; const res = await send(Y, { type: 'update' }); check(!res.err && res.done && res.done.added.length === 0 && allNodes(Y).length === n, what + ': a second run is a no-op' + (res.done && res.done.added.length ? ' (' + res.done.added.join(', ') + ')' : '')); };
  // a. a file below 1.7.0 is refused, with nothing touched
  let Z = (await olderFile(STARTER, '1.6.0')).M; load(Z, CODE);
  let nz = allNodes(Z).length, vz = Z.VARS.size;
  r = await send(Z, { type: 'update' });
  check(r.err && /below 1\.7\.0/.test(r.err.message) && /run 1\.7\.0 first/.test(r.err.message) && allNodes(Z).length === nz && Z.VARS.size === vz && Z.ROOT.getPluginData('version') === '1.6.0', 'a 1.6.0 file is refused with "run 1.7.0 first" and nothing is changed' + (r.err ? '' : ' (no error)'));
  Z = (await olderFile(STARTER, '1.0.0')).M; load(Z, CODE);
  r = await send(Z, { type: 'update' });
  check(r.err && /below 1\.7\.0/.test(r.err.message), 'a 1.0.0 file is refused too');
  // b. the version says 1.7.0 but items of 1.7.0 are missing
  Z = await fileOf(); compOf(Z, 'Field').name = 'Field copy'; setOf(Z, 'MenuItem').name = 'MenuItem copy';
  nz = allNodes(Z).length; vz = Z.VARS.size;
  r = await send(Z, { type: 'update' });
  check(r.err && /needs release 1\.7\.0 items/.test(r.err.message) && /Field/.test(r.err.message) && /MenuItem with State=Selected/.test(r.err.message) && /run 1\.7\.0 first/i.test(r.err.message) && allNodes(Z).length === nz && Z.VARS.size === vz, 'a 1.7.0 file without Field and MenuItem is refused, naming them, with nothing changed' + (r.err ? ': ' + r.err.message : ''));
  Z = await fileOf(); Z.ROOT.setPluginData('version', '1.6.0');
  r = await send(Z, { type: 'update' });
  check(r.err && /below 1\.7\.0/.test(r.err.message), 'a file whose version says 1.6.0 is refused even when it has the 1.7.0 items');
  // c. a component named Select that is not the plugin's: not touched, no second Select, the templates wait
  Z = await fileOf();
  const theirSelect = Z.figma.createComponent(); theirSelect.name = 'Select'; theirSelect.description = 'Our own select';
  r = await send(Z, { type: 'update' }); let rp = rep10(r);
  check(!r.err && countNamed(Z, 'COMPONENT', 'Select') === 1 && compOf(Z, 'Select') === theirSelect && theirSelect.description === 'Our own select' && !setOf(Z, 'Select'), 'the foreign Select is kept as it is and no second Select is made' + (r.err ? ': ' + r.err.message : ''));
  check(rp.some((l) => /ℹ skipped component Select: a component named Select that is not the plugin's/.test(l)) && rp.some((l) => /ℹ skipped Panel templates: they need the plugin's .*Select/.test(l)) && frameNamed(Z, 'Shared · Members · Admin').length === 0, 'Select and the Panel templates are skipped and reported');
  check(setOf(Z, 'Dialog') && setOf(Z, 'Toast') && setOf(Z, 'Textarea') && setOf(Z, 'EmptyState') && setOf(Z, 'TableCell').children.length === 16 && !rp.some((l) => /Field Control/.test(l)), 'the other components and TableCell Loading still arrive; the Field Control keeps its values');
  await noOp10(Z, 'foreign Select');
  // d. a TableCell set that is not the plugin's: no variants, no Loading templates
  Z = await fileOf(); setOf(Z, 'TableCell').setPluginData('mondapac-ds', '');
  r = await send(Z, { type: 'update' }); rp = rep10(r);
  check(!r.err && setOf(Z, 'TableCell').children.length === 11 && rp.some((l) => /ℹ skipped TableCell State=Loading: the TableCell set is not the plugin's/.test(l)) && rp.some((l) => /ℹ skipped Panel templates: they need the plugin's .*TableCell/.test(l)) && frameNamed(Z, 'Shared · Members · Seller').length === 0, 'a foreign TableCell gets no Loading variants; the Panel templates are skipped and reported' + (r.err ? ': ' + r.err.message : ''));
  check(setOf(Z, 'Select') && setOf(Z, 'Dialog') && setOf(Z, 'EmptyState') && !rp.some((l) => /update TableCell description/.test(l)), 'the new components still arrive and the foreign TableCell description is left alone');
  await noOp10(Z, 'foreign TableCell');
  // e. partly updated: two Loading variants, two Loading frames and a template body are gone; only they come back
  Z = await fileOf();
  r = await send(Z, { type: 'update' });
  check(!r.err && r.done && r.done.added.length > 0, 'first update of the partial file');
  const tcz = setOf(Z, 'TableCell');
  const lostV = tcz.children.filter((c) => ['Type=Number, State=Loading', 'Type=Actions, State=Loading'].includes(c.name)); lostV.forEach((c) => c.remove());
  const lostF = ['Shared · Members · Admin · Loading', 'Shared · Members · Seller · Loading'].map((n) => frameNamed(Z, n)[0]); const lostN = lostF.map((f) => f.name); lostF.forEach((f) => f.remove());
  check(tcz.children.length === 14 && lostV.length === 2 && lostN.length === 2, 'removed 2 Loading variants and 2 Loading frames');
  r = await send(Z, { type: 'update' }); const add10 = r.done ? r.done.added.filter((a) => !/^section .* moved /.test(a)) : []; // a section that grew may push the next ones along (restackSections)
  check(!r.err && add10.length === 3 && add10.includes('variants added to TableCell (2): State=Loading') && add10.includes('templates Panel · Admin (1 frames)') && add10.includes('templates Panel · Seller (1 frames)'), 'the update re-adds only those (' + add10.join(', ') + ')' + (r.err ? ': ' + r.err.message : ''));
  check(tcz.children.length === 16 && tcz.children.filter((c) => /State=Loading/.test(c.name)).length === 5 && lostN.every((n) => frameNamed(Z, n).length === 1) && BODIES_180.every((n) => countNamed(Z, 'COMPONENT', n) === 1), 'TableCell has 16 variants again, each Loading frame exists once and no template body was made twice');
  const lx = tcz.children.filter((c) => /State=Loading/.test(c.name)).map((c) => Math.round(c.x));
  check(lx.every((x) => x === lx[0]), 'the re-added variants join the existing Loading column');
  await noOp10(Z, 'partial file');
  // f. a Field Control that already has the preferred values, and a description that was changed by hand, are left alone
  Z = await fileOf(); compOf(Z, 'Field').description = 'My own Field note';
  r = await send(Z, { type: 'update' }); rp = rep10(r);
  check(!r.err && compOf(Z, 'Field').description === 'My own Field note' && !rp.some((l) => /update Field description/.test(l)) && rp.some((l) => /Field Control: preferred values/.test(l)), 'a Field description edited by hand is kept; the preferred values are still added');

  // 11 · release 1.8.1: a 1.8.0 file built the old way is repaired in place
  console.log('\n■ Scenario 11 · 1.8.1 audit fixes on a 1.8.0 file');
  for (const opts of [STARTER, { maxModes: 4 }]) {
    const tag11 = opts.maxModes > 1 ? '(modes)' : '(Starter)';
    const Q = start(opts, CODE_180);
    r = await send(Q, { type: 'build' });
    check(!r.err && Q.ROOT.getPluginData('version') === '1.8.0', 'the 1.8.0 plugin builds the starting file ' + tag11 + (r.err ? ': ' + r.err.message : ''));
    // the file really has what the Audit found
    check(shellFrames(Q).length === 22 && shellFrames(Q).every((f) => !f.minHeight), 'the 1.8.0 file has no minimum height on its Panel pages (the mock does not measure real text, so it cannot show how many are short)');
    check(phoneMain(Q).children.filter((c) => OVERFLOW_CARDS.includes(c.name)).length === 2 && stackHeight(phoneMain(Q)) > 724, 'the 1.8.0 admin phone members screen has 5 cards that ask for ' + Math.round(stackHeight(phoneMain(Q))) + ' px of 724');
    check(cbParts(Q).set.width > 2900, 'the 1.8.0 CheckboxRow set is ' + Math.round(cbParts(Q).set.width) + ' wide');
    load(Q, CODE);
    const ids0 = new Map(allNodes(Q).map((n) => [n.id, n.name])); const cardNodes = new Set(); OVERFLOW_CARDS.forEach((nm) => { const c = phoneMain(Q).children.find((k) => k.name === nm); cardNodes.add(c.id); c.findAll(() => true).forEach((k) => cardNodes.add(k.id)); });
    // the owner moved frames by hand: put one frame 20 px under a page that is about to grow, so the repair makes them overlap
    // the mock does not measure real text, so make one page short (as real Figma shows several): hide its Sidebar and Column content so it hugs to 600
    const grower = shellFrames(Q).find((f) => !FIXED_900.includes(f.name) && f.parent.name === 'Templates · Admin');
    if (grower) { grower.children[1].children.forEach((k) => { k.visible = false; }); grower.children[0].visible = false; grower.children[1].minHeight = 600; }
    const mover = frameNamed(Q, 'Dialogs · Confirm · Admin')[0];
    check(!!grower && !!mover && grower.height < 900 - 0.5, 'the 1.8.0 file has a Panel page made shorter than 900 and a frame to move by hand');
    if (grower && mover) { mover.x = grower.x; mover.y = grower.y + grower.height + 20; }
    const pos0 = posOf(Q);
    const heights0 = new Map(shellFrames(Q).map((f) => [f.id, f.height])); const nCb0 = cbParts(Q).set.children.map((c) => c.id).join();
    r = await send(Q, { type: 'update' });
    check(!r.err && r.done, 'Update library finished on the 1.8.0 file ' + tag11 + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
    const rp11 = r.done ? r.done.report.concat(r.done.added) : []; console.log('    ' + rp11.join('\n    '));
    // The 1.8.2 layout fixes (Input, AuthShowcase, Starter sections) run in the same update; scenario 12 checks them.
    const own181 = r.done ? r.done.added.filter((l) => !/^(Input|AuthShowcase) (variants laid out|documentation block)|^section .* moved /.test(l)) : [];
    check(r.done && own181.join('|') === ['fix minimum height 900 px of Panel pages (18 frames)', 'fix Shared · Members · Admin (phone): 2 member cards that do not fit removed', 'fix CheckboxRow layout (Value in columns, State in rows)'].concat(ADDED_183, ['changelog row 1.8.1', 'changelog row 1.8.2', 'changelog row 1.8.3', 'cover version', 'file version ' + SPEC_VERSION]).join('|') && !rp11.some((l) => /^⚠|^ℹ (?!overlap:)/.test(l)), 'the report names the three fixes, the changelog row and the version, with no warning or skip (' + (r.done ? r.done.added.join(', ') : '') + ')');
    state181(Q, '1.8.0 file repaired ' + tag11, true);
    state183(Q, '1.8.0 file updated ' + tag11);
    const gone11 = [...ids0.keys()].filter((id) => !Q.byId.has(id));
    check(gone11.length === cardNodes.size && gone11.every((id) => cardNodes.has(id)), 'the only deletions are the 2 member cards and their layers (' + gone11.length + ')');
    check(shellFrames(Q).every((f) => heights0.has(f.id)), 'no Panel page was replaced (same ids)');
    check(cbParts(Q).set.children.map((c) => c.id).join() === nCb0, 'the 10 CheckboxRow variants keep their ids');
    // Update library never moves a frame; an overlap that the repair causes is reported, not fixed. Only a Starter section that grew onto the next one moves (1.8.2, reported).
    const pos1 = posOf(Q); const moved = [...pos0.keys()].filter((id) => Q.byId.has(id) && pos1.get(id) !== pos0.get(id)).map((id) => Q.byId.get(id));
    const unreported = moved.filter((n) => !(n.type === 'SECTION' && r.done.added.some((l) => l.indexOf('section ' + n.name + ' moved ') === 0)));
    check(unreported.length === 0, 'no top-level node of any page or section moved during the update, except Starter sections reported as moved (' + moved.length + ' moved' + (unreported.length ? '; unreported: ' + unreported.map((n) => n.name).join(', ') : '') + ')');
    const ovl = overlapsOf(Q);
    check(grower && mover && ovl.some((o) => o.indexOf(grower.name) >= 0 && o.indexOf(mover.name) >= 0) && rp11.some((l) => (l.indexOf('\u2139 overlap: ' + grower.name + ' and ' + mover.name + ' on ') === 0 || l.indexOf('\u2139 overlap: ' + mover.name + ' and ' + grower.name + ' on ') === 0) && /Templates \u00b7 Admin; move one by hand$/.test(l)), 'the overlap the repair caused is reported by name and left as it is (' + ovl.length + ' overlaps)');
    const n11 = allNodes(Q).length; const idsAfter = new Set(allNodes(Q).map((n) => n.id));
    r = await send(Q, { type: 'update' });
    check(!r.err && r.done && r.done.added.length === 0 && allNodes(Q).length === n11 && allNodes(Q).every((n) => idsAfter.has(n.id)) && !r.done.report.some((l) => /^ℹ/.test(l)), 'a second run adds nothing, changes no layer and reports nothing to skip');
    r = await send(Q, { type: 'audit' });
    check(!r.err && r.done.report.filter((l) => l.indexOf('⚠') === 0).length === 0, 'Audit file has zero warnings after the repair');
    r = await send(Q, { type: 'export', version: SPEC_VERSION });
    if (r.done) compareExport(r.done.files, '1.8.1 repaired ' + tag11 + ' export');
  }
  // guards: hand-edited and foreign nodes are skipped and reported, never deleted
  {
    const Q = start(STARTER, CODE_180);
    r = await send(Q, { type: 'build' }); load(Q, CODE);
    const handMin = frameNamed(Q, 'Shared · Roles · Admin')[0]; handMin.minHeight = 600;
    const handFixed = frameNamed(Q, 'Shared · Members · Seller · Load error')[0]; handFixed.layoutSizingVertical = 'FIXED'; handFixed.resize(handFixed.width, 500);
    const wrongShape = frameNamed(Q, 'Shared · Roles · Seller')[0]; wrongShape.children[1].name = 'Content';
    const untagged = frameNamed(Q, 'Shared · Members · Admin · Loading')[0]; untagged.setPluginData('mondapac-ds', '');
    const noorCard = phoneMain(Q).children.find((c) => c.name === 'Noor Hassan'); noorCard.findAll((n) => n.type === 'TEXT').forEach((t) => { if (t.characters === 'Noor Hassan') t.characters = 'Noor H.'; });
    const samCard = phoneMain(Q).children.find((c) => c.name === 'Sam Okafor');
    const cbSet = cbParts(Q).set; const cbVariant = cbSet.children[3]; cbVariant.name = 'My variant';
    r = await send(Q, { type: 'update' }); const rg = r.done ? r.done.report.concat(r.done.added) : [];
    check(!r.err && r.done, 'update runs on the file with hand-edited nodes' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
    check(handMin.minHeight === 600 && rg.some((l) => l === 'ℹ skipped minimum height of Shared · Roles · Admin: it has its own minimum height (600 px)'), 'a page with its own minimum height keeps it and is reported');
    check(Math.round(handFixed.height) === 500 && !handFixed.minHeight && rg.some((l) => /ℹ skipped minimum height of Shared · Members · Seller · Load error: its height is fixed at 500 px/.test(l)), 'a page fixed by hand keeps its height and is reported');
    check(!wrongShape.minHeight && rg.some((l) => l === 'ℹ skipped minimum height of Shared · Roles · Seller: it is not the plugin\'s page shape'), 'a page whose Column was renamed is left alone and reported');
    check(!untagged.minHeight && !rg.some((l) => /Members · Admin · Loading/.test(l)), 'an untagged lookalike frame is left alone, without a report');
    check(!noorCard.removed && noorCard.parent === phoneMain(Q) && rg.some((l) => l === 'ℹ skipped member card Noor Hassan on Shared · Members · Admin (phone): it is not the plugin\'s card'), 'a member card with changed content survives and is reported');
    check(samCard.removed && !phoneMain(Q).children.some((c) => c.name === 'Sam Okafor'), 'the plugin\'s own card beyond the ones that fit is still removed');
    check(cbSet.width > 2900 && cbVariant.x > 0 && rg.some((l) => l === 'ℹ skipped CheckboxRow layout: the set or its documentation row was changed by hand') && !rg.some((l) => /fix CheckboxRow/.test(l)), 'a CheckboxRow set with a renamed variant keeps its layout and is reported');
    const others = shellFrames(Q).filter((f) => f && ![handMin, handFixed, wrongShape, untagged].includes(f));
    check(others.every((f) => f.height >= 900 && (FIXED_900.includes(f.name) || f.minHeight === 900)), 'every other Panel page was repaired');
    const n12 = allNodes(Q).length;
    r = await send(Q, { type: 'update' });
    check(!r.err && r.done.added.length === 0 && allNodes(Q).length === n12, 'a second run adds nothing (the skips are reported again)');
    // a foreign CheckboxRow (not tagged by the plugin) is not touched
    const R = start(STARTER, CODE_180);
    r = await send(R, { type: 'build' }); load(R, CODE);
    const foreignCb = cbParts(R).set; foreignCb.setPluginData('mondapac-ds', ''); const fx = foreignCb.children.map((c) => c.x).join();
    r = await send(R, { type: 'update' });
    check(!r.err && foreignCb.children.map((c) => c.x).join() === fx && foreignCb.width > 2900, 'a CheckboxRow set that is not the plugin\'s is not re-laid out');
  }

  // 12 · release 1.8.2: Input and AuthShowcase fit the page; Starter sections that an update grew no longer cover the next ones
  console.log('\n■ Scenario 12 · 1.8.2 layout fixes on a 1.8.1 file');
  for (const opts of [STARTER, { maxModes: 4 }]) {
    const tag12 = opts.maxModes > 1 ? '(modes)' : '(Starter)';
    const Q = start(opts, CODE_181);
    r = await send(Q, { type: 'build' });
    check(!r.err && Q.ROOT.getPluginData('version') === '1.8.1', 'the 1.8.1 plugin builds the starting file ' + tag12 + (r.err ? ': ' + r.err.message : ''));
    check(setOf(Q, 'Input').width > 1440 && setOf(Q, 'AuthShowcase').width > 1440, 'the 1.8.1 file has the sets the Audit found too wide (Input ' + Math.round(setOf(Q, 'Input').width) + ', AuthShowcase ' + Math.round(setOf(Q, 'AuthShowcase').width) + ')');
    let seller = null, sandbox = null, sandboxAt = '', forms = null, archive = null, archiveAt = '';
    if (opts.maxModes === 1) {
      // what the owner's page 3 looked like: a section that grew covers the next one; another one was moved aside by hand
      const admin = hostNamed(Q, 'Templates · Admin'); seller = hostNamed(Q, 'Templates · Seller'); sandbox = hostNamed(Q, 'Sandbox');
      seller.y = admin.y + 200; sandbox.x = admin.x + admin.width + 2000; sandbox.y = admin.y; sandboxAt = sandbox.x + ',' + sandbox.y;
      // page 2 runs left to right: Forms & selection pushed onto Actions; Archive placed beside Dark preview (side by side, no overlap)
      const actions = hostNamed(Q, 'Actions'); forms = hostNamed(Q, 'Forms & selection'); forms.x = actions.x + 300;
      const dark = hostNamed(Q, 'Templates · Dark preview'); archive = hostNamed(Q, 'Archive'); archive.x = dark.x + dark.width + 600; archive.y = dark.y; archiveAt = archive.x + ',' + archive.y;
    }
    load(Q, CODE);
    const ids0 = new Set(allNodes(Q).map((n) => n.id)); const inputIds = setOf(Q, 'Input').children.map((c) => c.id + c.name).sort().join();
    r = await send(Q, { type: 'update' });
    check(!r.err && r.done, 'Update library finished on the 1.8.1 file ' + tag12 + (r.err ? ': ' + r.err.message : ''));
    const add12 = r.done ? r.done.added : []; console.log('    ' + add12.join('\n    '));
    check(['Input variants laid out to fit the page', 'AuthShowcase variants laid out to fit the page'].every((t) => add12.some((l) => l.indexOf(t) === 0)) && add12.includes('changelog row 1.8.2') && add12.includes('file version ' + SPEC_VERSION) && !r.done.report.some((l) => /^(⚠|ℹ)/.test(l)), 'the report names the Input and AuthShowcase fixes, the changelog row and the version, with no warning or skip');
    state180(Q, opts, '1.8.1 file updated ' + tag12);
    check([...ids0].every((id) => Q.byId.has(id)) && setOf(Q, 'Input').children.map((c) => c.id + c.name).sort().join() === inputIds, 'nothing was deleted and the 18 Input variants keep their ids and names');
    if (seller) {
      check(add12.includes('section Templates · Seller moved down so it no longer overlaps the section before it') && sandbox.x + ',' + sandbox.y === sandboxAt, 'the covered section moved down; the section arranged by hand stayed where it was');
      const act = hostNamed(Q, 'Actions');
      check(add12.includes('section Forms & selection moved right so it no longer overlaps the section before it') && forms.x >= act.x + act.width + 240 - 0.5, 'on the left-to-right components page the covered section moved right');
      check(archive.x + ',' + archive.y === archiveAt && !add12.some((l) => /^section Archive /.test(l)), 'a section placed beside another (no overlap) stayed where it was');
    }
    const n12 = allNodes(Q).length;
    r = await send(Q, { type: 'update' });
    check(!r.err && r.done && r.done.added.length === 0 && allNodes(Q).length === n12, 'a second run adds and moves nothing');
    r = await send(Q, { type: 'audit' });
    check(!r.err && r.done.report.filter((l) => l.indexOf('⚠') === 0).length === 0, 'Audit file has zero warnings after the update');
    r = await send(Q, { type: 'export', version: SPEC_VERSION });
    if (r.done) compareExport(r.done.files, '1.8.2 updated ' + tag12 + ' export');
  }
  {
    // an Input set that is not the plugin's is not re-laid out
    const Q = start(STARTER, CODE_181);
    r = await send(Q, { type: 'build' }); load(Q, CODE);
    const fin = setOf(Q, 'Input'); fin.setPluginData('mondapac-ds', ''); const fx = fin.children.map((c) => c.x).join();
    r = await send(Q, { type: 'update' });
    check(!r.err && fin.children.map((c) => c.x).join() === fx && fin.width > 1440, 'an Input set that is not the plugin\'s is not re-laid out');
    const Q2 = start(STARTER, CODE_181);
    r = await send(Q2, { type: 'build' }); load(Q2, CODE);
    const fas = setOf(Q2, 'AuthShowcase'); fas.setPluginData('mondapac-ds', ''); const fax = fas.children.map((c) => c.x + ',' + c.y).join();
    r = await send(Q2, { type: 'update' });
    check(!r.err && fas.children.map((c) => c.x + ',' + c.y).join() === fax && fas.width > 1440 && !r.done.added.some((l) => /^AuthShowcase /.test(l)), 'an AuthShowcase set that is not the plugin\'s is not re-laid out');
  }

  // 13 · release 1.8.3: a 1.8.2 file gets the Panel follow-up frames, in rows below what each templates host holds; nothing existing changes
  console.log('\n■ Scenario 13 · 1.8.3 Panel follow-up on a 1.8.2 file');
  for (const opts of [STARTER, { maxModes: 4 }]) {
    const tag13 = opts.maxModes > 1 ? '(modes)' : '(Starter)';
    const Q = start(opts, CODE_182);
    r = await send(Q, { type: 'build' });
    check(!r.err && Q.ROOT.getPluginData('version') === '1.8.2' && ADMIN_183.concat(SELLER_183).every((n) => frameNamed(Q, n).length === 0), 'the 1.8.2 plugin builds the starting file, without any 1.8.3 frame ' + tag13 + (r.err ? ': ' + r.err.message : ''));
    // the owner placed a frame by hand below everything on Templates · Admin
    const adminHost = hostNamed(Q, 'Templates · Admin');
    const mover = frameNamed(Q, 'Dialogs · Confirm · Admin')[0];
    mover.y = Math.max.apply(null, adminHost.children.map((c) => c.y + c.height)) + 400; const moverAt = mover.x + ',' + mover.y;
    if (adminHost.type === 'SECTION') adminHost.resizeWithoutConstraints(adminHost.width, mover.y + mover.height + 240);
    load(Q, CODE);
    const before = allNodes(Q); const ids0 = new Set(before.map((n) => n.id));
    const snap0 = new Map(before.map((n) => [n.id, fullSnap(n)]));
    const pos0 = posOf(Q);
    r = await send(Q, { type: 'update' });
    check(!r.err && r.done, 'Update library finished on the 1.8.2 file ' + tag13 + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
    const add13 = r.done ? r.done.added : []; console.log('    ' + add13.join('\n    '));
    const own13 = add13.filter((l) => !/^section .* moved /.test(l));
    check(own13.join('|') === ADDED_183.concat(['changelog row 1.8.3', 'cover version', 'file version 1.8.3']).join('|') && !r.done.report.some((l) => /^(⚠|ℹ)/.test(l)), 'the report names the 1.8.3 frames, the changelog row and the version, with no warning, skip or overlap (' + own13.join(', ') + ')');
    state180(Q, opts, '1.8.2 file updated ' + tag13);
    state181(Q, '1.8.2 file updated ' + tag13);
    state183(Q, '1.8.2 file updated ' + tag13);
    const gone = [...ids0].filter((id) => !Q.byId.has(id));
    check(gone.length === 0, 'nothing was deleted (' + gone.length + ')');
    // Every property that matters, on every existing layer: only the cover version and date, and the size and place of a Starter section, may change.
    const changed = before.filter((n) => Q.byId.has(n.id) && fullSnap(n) !== snap0.get(n.id) && !(n.type === 'TEXT' && (n.characters === SPEC_VERSION || /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(n.characters))) && !(n.type === 'SECTION' && fullSnap(n, true) === encodeSnap(JSON.parse(snap0.get(n.id)), true)) && !inChangelog(n));
    check(changed.length === 0, 'no existing layer changed (type, name, parent, order, place, size, visibility, paints, bindings, sizing, properties, text), apart from the cover version and date, the changelog table and Starter section bounds (' + changed.length + (changed.length ? ': ' + snapDiff(changed, snap0) : '') + ')');
    const pos1 = posOf(Q); const moved = [...pos0.keys()].filter((id) => Q.byId.has(id) && pos1.get(id) !== pos0.get(id)).map((id) => Q.byId.get(id));
    check(moved.every((n) => n.type === 'SECTION' && add13.some((l) => l.indexOf('section ' + n.name + ' moved ') === 0)) && mover.x + ',' + mover.y === moverAt, 'no existing frame moved (the hand-placed one included); only Starter sections that the growth pushed are moved, and reported (' + moved.length + ')');
    const fresh = ADMIN_183.map((n) => frameNamed(Q, n)[0]).concat(BODIES_183.map((n) => compOf(Q, n)));
    check(fresh.every((f) => f.parent === mover.parent && f.y >= mover.y + mover.height + 240 - 0.5), 'the new Admin frames and template bodies sit in rows below the frame the owner placed lowest');
    const freshTops = allNodes(Q).filter((n) => !ids0.has(n.id) && n.parent && ids0.has(n.parent.id)).map((n) => n.name);
    const okTops = new Set(ADMIN_183.concat(SELLER_183, BODIES_183, ['Row']));
    check(freshTops.every((n) => okTops.has(n)), 'new layers are only the 1.8.3 frames, their template bodies and the changelog row (' + freshTops.length + ')');
    const all13 = allNodes(Q); const snap13 = new Map(all13.map((n) => [n.id, fullSnap(n)]));
    r = await send(Q, { type: 'update' });
    const again = allNodes(Q).filter((n) => !snap13.has(n.id) || fullSnap(n) !== snap13.get(n.id));
    check(!r.err && r.done && r.done.added.length === 0 && allNodes(Q).length === all13.length && again.length === 0, 'a second run adds, changes and moves nothing (' + again.length + (again.length ? ': ' + snapDiff(again, snap13) : '') + ')');
    r = await send(Q, { type: 'audit' });
    check(!r.err && r.done.report.filter((l) => l.indexOf('⚠') === 0).length === 0, 'Audit file has zero warnings after the update' + (r.done ? ': ' + r.done.report.filter((l) => /^⚠|^ {4}/.test(l)).slice(0, 6).join(' | ') : ''));
    r = await send(Q, { type: 'export', version: SPEC_VERSION });
    if (r.done) compareExport(r.done.files, '1.8.3 updated ' + tag13 + ' export');
  }
  {
    // a CheckboxRow that is not the plugin's, or whose variants were renamed: the 1.8.3 frames wait, and say why
    const Q = start(STARTER, CODE_182);
    r = await send(Q, { type: 'build' }); load(Q, CODE);
    setOf(Q, 'CheckboxRow').setPluginData('mondapac-ds', '');
    r = await send(Q, { type: 'update' }); let rp = r.done ? r.done.report : [];
    check(!r.err && rp.some((l) => /^ℹ skipped Panel 1\.8\.3 templates: they need the plugin's CheckboxRow/.test(l)) && ADMIN_183.concat(SELLER_183).every((n) => frameNamed(Q, n).length === 0) && BODIES_183.every((n) => !compOf(Q, n)), 'a CheckboxRow that is not the plugin\'s holds back every 1.8.3 frame, and the report says why');
    const Q2 = start(STARTER, CODE_182);
    r = await send(Q2, { type: 'build' }); load(Q2, CODE);
    setOf(Q2, 'CheckboxRow').children[3].name = 'My variant';
    r = await send(Q2, { type: 'update' }); rp = r.done ? r.done.report : [];
    check(!r.err && rp.some((l) => /^ℹ skipped Panel 1\.8\.3 templates: they need the plugin's CheckboxRow variants \(/.test(l)) && frameNamed(Q2, 'Shared · Role editor · Admin · Custom').length === 0, 'a CheckboxRow with a renamed variant holds back the 1.8.3 frames instead of failing' + (r.err ? ': ' + r.err.message : ''));
    const n2 = allNodes(Q2).length;
    r = await send(Q2, { type: 'update' });
    check(!r.err && r.done.added.length === 0 && allNodes(Q2).length === n2, 'a second run adds nothing');
    const guards = [
      ['a Textarea that is not the plugin\'s', (G) => setOf(G, 'Textarea').setPluginData('mondapac-ds', ''), /they need the plugin's .*\bTextarea\b/],
      ['a ReasonQuote that is not the plugin\'s', (G) => compOf(G, 'ReasonQuote').setPluginData('mondapac-ds', ''), /they need the plugin's .*\bReasonQuote\b/],
      ['a Dialog without its Sheet variant', (G) => { setOf(G, 'Dialog').children.find((c) => c.name === 'Size=Sm, Tone=Destructive, Layout=Sheet').name = 'My sheet'; }, /they need the plugin's .*Dialog variants \(.*Layout=Sheet/],
      // (renamed Loading variants are added back by the 1.8.0 step, so only a TableCell the plugin cannot extend leaves them out)
      ['a TableCell that is not the plugin\'s, so without its Loading variants', (G) => setOf(G, 'TableCell').setPluginData('mondapac-ds', ''), /they need the plugin's .*\bTableCell\b/],
    ];
    for (const g of guards) {
      const G = start(STARTER, CODE_182);
      r = await send(G, { type: 'build' }); load(G, CODE); g[1](G);
      r = await send(G, { type: 'update' }); rp = r.done ? r.done.report : [];
      const line = rp.find((l) => /^ℹ skipped Panel 1\.8\.3 templates: /.test(l)) || '';
      check(!r.err && g[2].test(line) && ADMIN_183.concat(SELLER_183).every((n) => frameNamed(G, n).length === 0) && BODIES_183.every((n) => !compOf(G, n)), g[0] + ' holds back every 1.8.3 frame, and the report says why (' + (r.err ? r.err.message : line) + ')');
    }
  }
  {
    // a 1.8.3 file that lost some frames and a template body: Update library puts back exactly those, and reuses the bodies that are there
    const Q = start(STARTER, CODE_182);
    r = await send(Q, { type: 'build' }); load(Q, CODE);
    r = await send(Q, { type: 'update' });
    const lost = [P1 + ' · Empty', 'Dialogs · Sellers · Admin', 'Shared · Role editor · Seller · Owner'];
    lost.forEach((n) => frameNamed(Q, n)[0].remove()); compOf(Q, 'Template body · D6 Add seller').remove();
    const keep = new Set(allNodes(Q).map((n) => n.id));
    r = await send(Q, { type: 'update' });
    const add = r.done ? r.done.added.filter((l) => !/^section .* moved /.test(l)) : [];
    check(!r.err && add.join('|') === 'templates Panel 1.8.3 · Admin (2 frames, 1 template bodies)|templates Panel 1.8.3 · Seller (1 frames)' && lost.every((n) => frameNamed(Q, n).length === 1) && ADMIN_183.concat(SELLER_183).every((n) => frameNamed(Q, n).length === 1), 'Update library puts back exactly the lost frames and the lost body (' + (r.err ? r.err.message : add.join(', ')) + ')');
    const bodies = allNodes(Q).filter((n) => n.type === 'COMPONENT' && BODIES_183.includes(n.name)).map((n) => n.name).sort();
    check(bodies.join('|') === BODIES_183.slice().sort().join('|') && instMain(frameNamed(Q, 'Dialogs · Sellers · Admin')[0].findAll((x) => x.type === 'INSTANCE' && x.name === 'D4 Reject')[0].findOne((x) => x.name === 'content')) === 'Template body · D4 Reject' && [...keep].every((id) => Q.byId.has(id)), 'each template body exists once: the rebuilt dialogs reuse the bodies that are there, and nothing else was removed');
  }

  console.log('\n' + (failures ? '✕ ' + failures + ' check(s) failed' : '✓ all checks passed'));
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error('✕ harness crashed', e && e.stack ? e.stack : e); process.exitCode = 1; });
