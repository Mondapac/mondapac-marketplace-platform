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
// An older library: built with the released 1.6.0 plugin, optionally taken back to 1.5.0 or 1.0.0, then the current plugin is loaded.
async function olderFile(opts, from) {
  const M = start(opts, OLD_CODE);
  const r = await send(M, { type: 'build' });
  check(!r.err, 'the 1.6.0 plugin builds the starting file' + (r.err ? ': ' + r.err.message : ''));
  let legacy = null; let n = 0;
  if (from === '1.0.0') n = downgradeTo10(M);
  else if (from === '1.5.0') legacy = downgradeTo15(M);
  load(M, CODE);
  return { M: M, legacy: legacy, coverFrames: n };
}
function countNamed(M, type, name) { return allNodes(M).filter((n) => n.type === type && n.name === name).length; }
function textCount(M, str) { return allNodes(M).filter((n) => n.type === 'TEXT' && n.characters === str).length; }
const hex8 = (c) => '#' + [c.r, c.g, c.b].concat(c.a === undefined || c.a === 1 ? [] : [c.a]).map((x) => ('0' + Math.round(x * 255).toString(16)).slice(-2).toUpperCase()).join('');
const setOf = (M, name) => allNodes(M).find((n) => n.type === 'COMPONENT_SET' && n.name === name);
const compOf = (M, name) => allNodes(M).find((n) => n.type === 'COMPONENT' && n.name === name && n.parent.type !== 'COMPONENT_SET');
const keysOf = (node) => Object.keys(node.componentPropertyDefinitions).map((k) => k.split('#')[0]);
const hostNamed = (M, name) => M.ROOT.children.find((p) => p.name === name) || M.ROOT.children.map((p) => p.children.find((n) => n.type === 'SECTION' && n.name === name)).find(Boolean);

async function updateScenario(label, opts, from) {
  console.log('\n■ ' + label);
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
  check(textCount(M, SPEC_VERSION) >= 2 && allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && n.findOne((x) => x.type === 'TEXT' && x.characters === SPEC_VERSION)).length === 1, 'one changelog row for ' + SPEC_VERSION + ' (and the cover shows it)');
  check(allNodes(M).some((n) => n.type === 'TEXT' && n.characters.indexOf('Auth (planned as 1.1.0 in identity ux.md 8.1).') === 0), 'the 1.7.0 changelog row starts "Auth (planned as 1.1.0 in identity ux.md 8.1)."');
  check(['1.5.0', '1.6.0'].every((v) => allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && n.findOne((x) => x.type === 'TEXT' && x.characters === v)).length === 1), 'one changelog row each for 1.5.0 and 1.6.0');
  check(['size/topbar-phone', 'size/auth-card'].every((v) => allNodes(M).filter((n) => n.type === 'FRAME' && n.name === 'Row' && n.findOne((x) => x.type === 'TEXT' && x.characters === v)).length === 1), 'one size table row each for size/topbar-phone and size/auth-card');
  check(M.ROOT.getPluginData('version') === SPEC_VERSION, 'file version is ' + SPEC_VERSION);
  const after = allNodes(M);
  const gone = before.filter((n) => n.removed || !M.byId.has(n.id));
  if (from15) check(gone.length === legacy.ids.size && gone.length === 15 && gone.every((n) => legacy.ids.has(n.id)), 'the only deletions are the 3 old phone topbar frames and their layers (' + gone.length + ')');
  else check(gone.length === 0, 'no existing node was deleted or replaced (' + gone.length + ')');
  const scrimIds = new Set(legacy ? legacy.scrims : []);
  const changed = before.filter((n) => M.byId.has(n.id) && !scrimIds.has(n.id) && !inputVariants.has(n.id) && snap(n) !== beforeSnap.get(n.id) && !(n.type === 'TEXT' && (n.characters.indexOf(SPEC_VERSION) >= 0 || /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(n.characters))));
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
  r = await send(M, { type: 'export', version: SPEC_VERSION });
  if (r.done) { compareExport(r.done.files, label + ' export'); check(r.done.files['color.light.json'].includes('"$value": "#11182780"') && r.done.files['color.dark.json'].includes('"$value": "#00000099"') && r.done.files['tokens.css'].includes('--mp-color-bg-scrim: #11182780;') && r.done.files['tokens.css'].includes('--mp-size-topbar-phone: 56px;') && r.done.files['tokens.css'].includes('--mp-color-text-on-showcase-muted: #FFFFFFBD;') && r.done.files['tokens.css'].includes('--mp-size-auth-card: 400px;'), 'export writes bg/scrim and text/on-showcase-muted as hex8, size/topbar-phone and size/auth-card'); }
  return M;
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
  audit(M, 's2');
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

  // 5, 6 · Update library on 1.0.0, 1.5.0 and 1.6.0 files (Starter layout, then modes layout)
  await updateScenario('Scenario 5a · Update library on a 1.0.0 file (Starter plan, parallel collections)', { maxModes: 1, maxPages: 3 }, '1.0.0');
  await updateScenario('Scenario 5b · Update library on a 1.5.0 file (Starter plan, parallel collections)', { maxModes: 1, maxPages: 3 }, '1.5.0');
  await updateScenario('Scenario 5c · Update library on a 1.6.0 file (Starter plan, parallel collections)', { maxModes: 1, maxPages: 3 }, '1.6.0');
  await updateScenario('Scenario 6a · Update library on a 1.0.0 file (modes, full page layout)', { maxModes: 4 }, '1.0.0');
  await updateScenario('Scenario 6b · Update library on a 1.5.0 file (modes, full page layout)', { maxModes: 4 }, '1.5.0');
  await updateScenario('Scenario 6c · Update library on a 1.6.0 file (modes, full page layout)', { maxModes: 4 }, '1.6.0');

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
  console.log('\n■ Scenario 8 · In-place fix guards (1.5.0 file)');
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
  console.log('\n■ Scenario 9 · 1.7.0 update guards (1.6.0 file)');
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

  console.log('\n' + (failures ? '✕ ' + failures + ' check(s) failed' : '✓ all checks passed'));
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error('✕ harness crashed', e && e.stack ? e.stack : e); process.exitCode = 1; });
