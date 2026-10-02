'use strict';
// Runs the plugin against the strict mock in several scenarios and audits the result.
const fs = require('fs');
const path = require('path');
const { makeFigma } = require('./mock');
const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'code.js'), 'utf8');
// Token files to compare with: the repo's docs/design/tokens, or repo-tokens/ next to the plugin.
const TOKENS = [path.join(ROOT, '..', '..', 'tokens'), path.join(ROOT, 'repo-tokens')].find((d) => fs.existsSync(path.join(d, 'tokens.css')));
let failures = 0;
process.on('unhandledRejection', (e) => { console.error('✕ UNHANDLED REJECTION', e && e.stack ? e.stack : e); failures++; });

function start(opts) {
  const M = makeFigma(opts);
  // Figma runs plugin code strictly: assigning unknown properties to nodes throws.
  new Function('figma', '__html__', '"use strict";\n' + CODE)(M.figma, '<html></html>');
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
  return { all: all, sets: sets };
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
  check(secs.length === 22, '22 sections (got ' + secs.length + ')');
  const lightColl = [...M.COLLS.values()].find((c) => c.name === 'Color');
  const lightBound = darkPage.findAll((n) => n.type !== 'TEXT' || true).filter((n) => n.y >= 0 && n.parent !== darkPage ? true : n.parent === darkPage && n.type === 'FRAME' && n.height > 400)
    .filter((n) => (n._fills || []).concat(n._strokes || []).some((p) => p.boundVariables && M.VARS.get(p.boundVariables.color.id).variableCollectionId === lightColl.id));
  const screens = darkPage.children.filter((n) => n.type === 'FRAME' && n.getPluginData('theme') === 'dark');
  check(screens.length === 3, 'dark preview has 3 themed screens');
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
  r = await send(M, { type: 'export', version: '1.0.0' });
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
  check(M.ROOT.children.length === 26, 'upgrade split sections into 26 pages (got ' + M.ROOT.children.length + ': ' + M.ROOT.children.map((p) => p.name + '(' + p.children.length + ')').join(', ') + ')');
  const orphan = []; M.ROOT.children.forEach((p) => p.findAll(() => true).forEach((n) => (n._fills || []).concat(n._strokes || []).forEach((pp) => { if (pp.boundVariables && !M.VARS.get(pp.boundVariables.color.id)) orphan.push(pathOf(n)); })));
  check(orphan.length === 0, 'no layer is bound to a deleted variable after upgrade (' + orphan.length + ')');
  r = await send(M, { type: 'export', version: '1.0.0' });
  if (r.done) compareExport(r.done.files, 'after upgrade');

  // 2 · Professional plan (modes allowed from the start)
  console.log('\n■ Scenario 2 · Professional plan (modes)');
  M = start({ maxModes: 4 });
  r = await send(M, { type: 'build' });
  check(!r.err, 'build finished' + (r.err ? ': ' + r.err.message + '\n' + r.err.stack : ''));
  check(M.ROOT.children.length === 26, 'full layout uses 26 pages (got ' + M.ROOT.children.length + ')');
  audit(M, 's2');
  r = await send(M, { type: 'export', version: '1.0.0' });
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

  console.log('\n' + (failures ? '✕ ' + failures + ' check(s) failed' : '✓ all checks passed'));
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error('✕ harness crashed', e && e.stack ? e.stack : e); process.exitCode = 1; });
