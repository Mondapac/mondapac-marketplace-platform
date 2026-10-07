// ---------------------------------------------------------------- pages & orchestration
const PAGES = [
  ['cover', 'Cover'], ['start', 'Getting started'], ['changelog', 'Changelog'],
  ['sep-foundations', '———— Foundations'], ['color', 'Colour'], ['type', 'Typography'], ['spacing', 'Spacing, size & radius'], ['elevation', 'Elevation & motion'], ['icons', 'Icons'], ['a11y', 'Accessibility'],
  ['sep-components', '———— Components'], ['actions', 'Actions'], ['forms', 'Forms & selection'], ['status', 'Status & feedback'], ['data', 'Data display'], ['tables', 'Tables & collections'], ['nav', 'Navigation & shell'], ['review', 'Review & detail'], ['board', 'Board & delivery'],
  ['sep-templates', '———— Templates'], ['tpl-admin', 'Templates · Admin'], ['tpl-seller', 'Templates · Seller'], ['tpl-dark', 'Templates · Dark preview'],
  ['sep-workspace', '———— Workspace'], ['sandbox', 'Sandbox'], ['archive', 'Archive'],
];
const COLLECTION_NAMES = ['Primitives', 'Color', 'Color · Dark', 'Dimension', 'Dimension · Touch', 'Typography', 'Motion'];

function post(msg) { try { figma.ui.postMessage(msg); } catch (e) { /* UI closed */ } }
let STEP = 0; let STEPS = 25;
function progress(label) { STEP++; post({ type: 'progress', step: STEP, total: STEPS, label: label }); }
function wait() { return new Promise(function (r) { setTimeout(r, 0); }); }

async function fileIsEmpty() {
  const colls = await figma.variables.getLocalVariableCollectionsAsync();
  const styles = (await figma.getLocalTextStylesAsync()).length + (await figma.getLocalEffectStylesAsync()).length + (await figma.getLocalPaintStylesAsync()).length;
  const pages = figma.root.children;
  const content = pages.some(function (p) { return p.children.length > 0; });
  return { empty: !content && pages.length === 1 && colls.length === 0 && styles === 0, hasLibrary: pages.some(function (p) { return p.getPluginData(PLUGIN_TAG) === 'page'; }) || colls.some(function (c) { return COLLECTION_NAMES.indexOf(c.name) >= 0; }) };
}

// Starter files allow 3 pages: the same content is grouped into canvas sections on 3 pages.
const COMPACT = [
  ['p-start', '1 · Start & foundations', 'H', ['cover', 'start', 'changelog', 'color', 'type', 'spacing', 'elevation', 'icons', 'a11y']],
  ['p-components', '2 · Components', 'H', ['actions', 'forms', 'status', 'data', 'tables', 'nav', 'review', 'board']],
  ['p-templates', '3 · Templates & workspace', 'V', ['tpl-admin', 'tpl-seller', 'tpl-dark', 'sandbox', 'archive']],
];
const TITLE = {}; PAGES.forEach(function (d) { TITLE[d[0]] = d[1]; });

// Remove everything this plugin generated (pages, variable collections, styles). Other pages are kept.
async function resetLibrary() {
  const tagged = figma.root.children.filter(function (p) { return p.getPluginData(PLUGIN_TAG) === 'page'; });
  let keep = tagged[0];
  if (!keep) { try { keep = figma.createPage(); } catch (e) { throw new Error('No free page in this file (Starter files have 3). Use a new design file.'); } }
  await figma.setCurrentPageAsync(keep);
  keep.children.slice().forEach(function (n) { n.remove(); });
  tagged.slice(1).forEach(function (p) { p.remove(); });
  keep.name = 'Building…'; keep.setPluginData(PLUGIN_TAG, ''); keep.setPluginData('layout', '');
  const colls = await figma.variables.getLocalVariableCollectionsAsync();
  colls.forEach(function (c) { if (COLLECTION_NAMES.indexOf(c.name) >= 0) c.remove(); });
  const names = {}; SPEC.type.forEach(function (t) { names[t.name] = 1; }); SPEC.effects.forEach(function (e) { names[e.name] = 1; });
  (await figma.getLocalTextStylesAsync()).forEach(function (s) { if (names[s.name]) s.remove(); });
  (await figma.getLocalEffectStylesAsync()).forEach(function (s) { if (names[s.name]) s.remove(); });
  return keep;
}

function tryCreatePages(n) {
  const made = [];
  try { for (let i = 0; i < n; i++) made.push(figma.createPage()); return made; }
  catch (e) { made.forEach(function (p) { p.remove(); }); return null; }
}
function makeSection(page, key) {
  const s = figma.createSection(); page.appendChild(s);
  s.name = TITLE[key]; s.setPluginData(PLUGIN_TAG, 'section'); s.setPluginData('key', key);
  s.fills = [paint('bg/subtle')]; s.strokes = [paint('border/default')];
  return s;
}
// Returns T[key] = { page, host }: host is the page itself (full layout) or a section (Starter layout).
async function createLayout(first) {
  const T = {};
  const extra = tryCreatePages(PAGES.length - 1);
  if (extra) {
    [first].concat(extra).forEach(function (p, i) {
      const d = PAGES[i]; p.name = d[1]; p.setPluginData(PLUGIN_TAG, 'page'); p.setPluginData('key', d[0]); p.setPluginData('layout', 'full');
      figma.root.insertChild(i, p); T[d[0]] = { page: p, host: p };
    });
    return { T: T, compact: false };
  }
  const pages = [first].concat(tryCreatePages(COMPACT.length - 1) || []);
  if (pages.length < COMPACT.length) throw new Error('This file needs ' + COMPACT.length + ' free pages. Use a new design file.');
  COMPACT.forEach(function (d, i) {
    const p = pages[i]; p.name = d[1]; p.setPluginData(PLUGIN_TAG, 'page'); p.setPluginData('key', d[0]); p.setPluginData('layout', 'compact');
    figma.root.insertChild(i, p);
    d[3].forEach(function (k) { T[k] = { page: p, host: makeSection(p, k) }; });
  });
  log('ℹ Starter plan: 3 pages per file, so each topic is a section on the canvas. After upgrading, "Upgrade to modes" also splits sections into pages.');
  return { T: T, compact: true };
}
// Fit each section to its content and line the sections up (left to right, or top to bottom for templates).
function arrangeSections(T) {
  COMPACT.forEach(function (d) {
    let pos = 0;
    d[3].forEach(function (k) {
      const s = T[k].host; let w = 0, h = 0;
      s.children.forEach(function (c) { c.x += 80; c.y += 120; w = Math.max(w, c.x + c.width); h = Math.max(h, c.y + c.height); });
      s.resizeWithoutConstraints(Math.max(480, w + 80), Math.max(320, h + 96));
      if (d[2] === 'H') { s.x = pos; s.y = 0; pos += s.width + 240; } else { s.x = 0; s.y = pos; pos += s.height + 240; }
    });
  });
}

async function onPage(target, label, fn) {
  await figma.setCurrentPageAsync(target.page);
  const r = await fn(target.host);
  await flush();
  progress(label);
  await wait();
  return r;
}

// Lay out finished screens left to right under a short header.
function templatesPage(host, title, subtitle, screens) {
  const head = frame({ name: title, dir: 'V', gap: 'space/3', pad: [0, 0, 0, 0], w: 1200 }, [
    text('MondaPac Design System', 'Caption/Overline', 'text/link'), text(title, 'Display/Hero'), para(subtitle, 1100),
  ]);
  head.fills = []; host.appendChild(head); head.x = 0; head.y = 0; tag(head);
  let x = 0;
  // Figma labels top-level frames with their names, so no separate caption is needed.
  screens.forEach(function (s) {
    host.appendChild(s); s.x = x; s.y = 240;
    x += s.width + 160;
  });
}

function notePage(host, title, subtitle, items) {
  const root = pageShell(host, title, subtitle);
  add(root, bullets(items, 1100));
  tag(root);
}

async function build(force) {
  STEP = 0; STEPS = 25; S.report = [];
  await figma.loadAllPagesAsync();
  const state = await fileIsEmpty();
  let first;
  if (!state.empty) {
    if (!force) { post({ type: 'error', message: state.hasLibrary ? 'This file already has the MondaPac library. Tick "Rebuild" to replace it.' : 'Run the build in a new, empty design file (or tick "Rebuild").' }); return; }
    first = await resetLibrary();
  } else first = figma.root.children[0];

  post({ type: 'status', label: 'Creating variables…' });
  await buildVariables(); progress('Variables'); await wait();
  await loadFonts(); await buildStyles(); await flush(); progress('Text and effect styles'); await wait();
  figma.root.setPluginData('version', SPEC.version);

  const L = await createLayout(first); const P = L.T;
  const iconsWrap = await onPage(P.icons, 'Icons', function (h) { return buildIcons(h); });

  await onPage(P.actions, 'Actions', buildActions);
  await onPage(P.forms, 'Forms & selection', buildForms);
  await onPage(P.status, 'Status & feedback', buildStatus);
  await onPage(P.data, 'Data display', buildDataDisplay);
  await onPage(P.tables, 'Tables & collections', buildTables);
  await onPage(P.nav, 'Navigation & shell', buildNavigation);
  await onPage(P.review, 'Review & detail', buildReview);
  await onPage(P.board, 'Board & delivery', buildBoard);

  await onPage(P.icons, 'Icons page', function (h) { return pageIcons(h, iconsWrap); });
  await onPage(P.color, 'Colour', pageColor);
  await onPage(P.type, 'Typography', pageTypography);
  await onPage(P.spacing, 'Spacing', pageSpacing);
  await onPage(P.elevation, 'Elevation & motion', pageElevation);
  await onPage(P.a11y, 'Accessibility', pageA11y);
  await onPage(P.start, 'Getting started', pageGettingStarted);

  const adminScreens = await onPage(P['tpl-admin'], 'Admin templates', function (h) {
    const list = [tplAdminHome(), tplAdminSellers(), tplAdminReview(), tplAdminPhoneMenu()];
    templatesPage(h, 'Templates · Admin', 'Full screens built only from library instances. Copy a template to start a new Admin screen; never detach the shell.', list);
    return list;
  });
  const sellerScreens = await onPage(P['tpl-seller'], 'Seller templates', function (h) {
    const list = [tplSellerHome(), tplSellerOrders(), tplSellerBoard(), tplSellerPhoneHome(), tplSellerPhoneMenu()];
    templatesPage(h, 'Templates · Seller', 'Same structure as Admin with seller navigation, features and permissions. The order board is the tablet layout (touch density).', list);
    return list;
  });
  await onPage(P['tpl-dark'], 'Dark preview', function (h) {
    const clones = [adminScreens[0], sellerScreens[1], sellerScreens[2]].map(function (s) { const c = s.clone(); c.name = s.name + ' · Dark'; return c; });
    templatesPage(h, 'Templates · Dark preview', S.modes.color
      ? 'These frames use the Dark mode of the Color collection. Select any frame and switch the mode in the Appearance panel to compare.'
      : 'Starter plan: these copies are bound to the "Color · Dark" collection. Use the plugin buttons Dark theme / Light theme on a selection to switch any frame.', clones);
    clones.forEach(function (c) { applyTheme(c, 'dark'); });
  });
  await onPage(P.sandbox, 'Sandbox', function (h) {
    notePage(h, 'Sandbox', 'Work in progress. Nothing here is part of the library yet.', [
      'Start every proposal as a frame named "Proposal · <component> · <ticket>" and link the ticket in the description.',
      'Build only with variables, text styles and existing components. Detached instances are not reviewed.',
      'Show every state (default, hover, focus, disabled, error), both themes and, for seller features, the touch density.',
      'After review, move the component to its library page, bump the version and add a Changelog row.',
    ]);
  });
  await onPage(P.archive, 'Archive', function (h) {
    notePage(h, 'Archive', 'Retired components. Keep them until no screen uses them, then delete in the next MAJOR version.', [
      'Rename a retired component to "Deprecated / <Name>" and write "Use <Replacement> instead (since vX.Y)" in its description.',
      'Move it to this page; existing instances keep working, the asset panel stops suggesting it.',
    ]);
  });
  await onPage(P.changelog, 'Changelog', pageChangelog);
  await onPage(P.cover, 'Cover', pageCover);

  if (L.compact) arrangeSections(P);
  await figma.setCurrentPageAsync(P.cover.page);
  figma.viewport.scrollAndZoomIntoView(L.compact ? [P.cover.host] : P.cover.page.children);
  log('✓ Components: ' + S.counts.components + ' components and sets (incl. ' + Object.keys(ICONS).length + ' icons), ' + S.counts.variants + ' variants, ' + S.counts.instances + ' instances in docs and templates.');
  if (S.modes.color) log('✓ Light/Dark and Desktop/Touch are variable modes.');
  log('✓ Layout: ' + (L.compact ? '3 pages with sections (Starter).' : PAGES.length + ' pages.'));
  post({ type: 'done', report: S.report, counts: S.counts, modes: S.modes });
}

// ---------------------------------------------------------------- update library (add what a newer plugin release brings)
// Idempotent: every step first checks whether its result already exists and only adds what is missing.
// It never deletes, renames or rebuilds anything, so designs made with the library keep working.
const PHONE_TEMPLATES = { 'tpl-seller': { names: ['Seller · Home (phone)', 'Seller · Menu open (phone)'], make: function () { return [tplSellerPhoneHome(), tplSellerPhoneMenu()]; } },
  'tpl-admin': { names: ['Admin · Menu open (phone)'], make: function () { return [tplAdminPhoneMenu()]; } } };

// Rebuild S.ts, S.es, S.icons and S.sets from what is already in the file.
async function hydrateLibrary() {
  S.ts = {}; S.es = {}; S.icons = {}; S.sets = {};
  (await figma.getLocalTextStylesAsync()).forEach(function (st) { S.ts[st.name] = st; });
  (await figma.getLocalEffectStylesAsync()).forEach(function (st) { S.es[st.name] = st; });
  figma.root.children.forEach(function (page) {
    page.findAll(function (n) { return n.type === 'COMPONENT_SET' || n.type === 'COMPONENT'; }).forEach(function (n) {
      if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') return;
      if (n.name.indexOf('Icon/') === 0) { if (n.type === 'COMPONENT' && !S.icons[n.name.slice(5)]) S.icons[n.name.slice(5)] = n; return; }
      if (S.sets[n.name]) return;
      const defs = n.componentPropertyDefinitions; const keys = {}; const axes = [];
      Object.keys(defs).forEach(function (k) { if (defs[k].type === 'VARIANT') axes.push(k); else keys[k.split('#')[0]] = k; });
      S.sets[n.name] = n.type === 'COMPONENT_SET' ? { set: n, keys: keys, axes: axes } : { comp: n, keys: keys, axes: [] };
    });
  });
}
// T[key] = { page, host } for the pages (full layout) or sections (Starter layout) the build made.
function findHosts() {
  const T = {};
  figma.root.children.forEach(function (p) {
    if (p.getPluginData(PLUGIN_TAG) !== 'page') return;
    const key = p.getPluginData('key');
    const secs = p.children.filter(function (n) { return n.type === 'SECTION' && n.getPluginData('key'); });
    if (p.getPluginData('layout') === 'compact') secs.forEach(function (n) { T[n.getPluginData('key')] = { page: p, host: n }; });
    else T[key] = { page: p, host: secs.filter(function (n) { return n.getPluginData('key') === key; })[0] || p };
  });
  return T;
}
function rightEdge(host) { let r = 0; host.children.forEach(function (c) { r = Math.max(r, c.x + c.width); }); return r; }
// A Starter section is a fixed-size box: grow it so new content stays inside.
function fitSection(host) {
  if (host.type !== 'SECTION') return;
  let w = host.width, h = host.height;
  host.children.forEach(function (c) { w = Math.max(w, c.x + c.width + 80); h = Math.max(h, c.y + c.height + 96); });
  host.resizeWithoutConstraints(w, h);
}
function appendTableRow(tbl, cells, widths) {
  const prev = tbl.children[tbl.children.length - 1];
  const row = tableRow(cells, widths, true); add(tbl, row);
  if (prev && prev.name === 'Row') { prev.strokes = [paint('border/row')]; prev.strokeAlign = 'INSIDE'; prev.strokeTopWeight = 0; prev.strokeLeftWeight = 0; prev.strokeRightWeight = 0; prev.strokeBottomWeight = 1; }
  return row;
}
function findTable(host, headers) {
  return host.findAll(function (n) { return n.type === 'FRAME' && n.name === 'Table' && n.children.length && n.children[0].name === 'Header' && n.children[0].children.map(function (c) { return c.name; }).join('|') === headers; })[0] || null;
}
function semverLess(a, b) { const x = String(a || '0').split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; }

async function updateLibrary() {
  STEP = 0; STEPS = 6; S.report = [];
  await figma.loadAllPagesAsync();
  const state = await fileIsEmpty();
  if (state.empty) { post({ type: 'error', message: 'This file is empty. Update library only adds to an existing MondaPac library; use Build library in a new file.' }); return; }
  if (!state.hasLibrary) { post({ type: 'error', message: 'This file has no MondaPac library. Use Build library in a new, empty design file.' }); return; }
  await loadState();
  await hydrateLibrary();
  const T = findHosts();
  const need = ['nav', 'tpl-seller', 'tpl-admin', 'changelog', 'spacing', 'cover'].filter(function (k) { return !T[k]; });
  const base = ['CountBadge', 'NavGroupLabel', 'IconButton', 'IdentityTile', 'QueueCard', 'Sidebar'].filter(function (k) { return !S.sets[k]; });
  if (need.length || base.length || !S.ts['Body/Default'] || !S.es['Focus/Ring']) {
    post({ type: 'error', message: 'This library is incomplete, so it cannot be updated safely. Missing: ' + need.concat(base).join(', ') + '. Restore it from version history or rebuild it in a new file.' }); return;
  }
  await loadFonts();
  const added = [];

  // 1 · tokens
  const missingVars = SPEC.dimension.filter(function (d) { return !S.dim[d.name]; });
  missingVars.forEach(function (d) { addDimensionVariable(d); added.push('variable ' + d.name + (S.dimModes.touchCollection ? ' (Dimension and Dimension · Touch)' : ' (Desktop and Touch modes)')); });

  // 2 · components, documented on the Navigation & shell page
  const have = { NavDrawer: !!S.sets.NavDrawer, BottomTabBar: !!S.sets.BottomTabBar };
  if (!have.NavDrawer || !have.BottomTabBar) {
    await onPage(T.nav, 'Navigation components', function (host) {
      let root = host.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'Navigation & shell'; })[0];
      if (!root) { const y = host.children.length ? Math.min.apply(null, host.children.map(function (c) { return c.y; })) : 0; const x = rightEdge(host) + 160; root = pageShell(host, 'Navigation & shell', 'One shell for both panels. The Sidebar variant decides the workspace; the menu items come from configuration and permissions.'); root.x = x; root.y = y; tag(root); }
      buildMobileNav(root, have);
      fitSection(host);
    });
    if (!have.NavDrawer) added.push('component NavDrawer');
    if (!have.BottomTabBar) added.push('component BottomTabBar');
  }

  // 3 · templates
  const tplKeys = Object.keys(PHONE_TEMPLATES);
  for (let i = 0; i < tplKeys.length; i++) {
    const key = tplKeys[i]; const def = PHONE_TEMPLATES[key];
    const present = T[key].host.children.map(function (c) { return c.name; });
    if (def.names.every(function (n) { return present.indexOf(n) >= 0; })) continue;
    await onPage(T[key], key === 'tpl-seller' ? 'Seller phone templates' : 'Admin phone template', function (host) {
      const ref = host.children.filter(function (n) { return n.type === 'FRAME' && n.height > 400; })[0];
      const y = ref ? ref.y : 240; let x = rightEdge(host) + 160;
      def.make().forEach(function (scr) {
        if (present.indexOf(scr.name) >= 0) { scr.remove(); return; }
        host.appendChild(scr); scr.x = x; scr.y = y; x += scr.width + 160; added.push('template ' + scr.name);
      });
      fitSection(host);
    });
  }

  // 4 · documentation pages (only edits what the release changed)
  const sizeTable = findTable(T.spacing.host, 'Token|Desktop|Touch|Use');
  const bar = SPEC.dimension.filter(function (d) { return d.name === 'size/bottom-bar'; })[0];
  if (sizeTable && bar && !sizeTable.findOne(function (n) { return n.type === 'TEXT' && n.characters === bar.name; })) {
    await onPage(T.spacing, 'Spacing page', function () { appendTableRow(sizeTable, [bar.name, bar.desktop + ' px', bar.touch + ' px', SIZE_USE[bar.name]], [260, 160, 160, 600]); fitSection(T.spacing.host); });
    added.push('size table row ' + bar.name);
  }
  const logTable = findTable(T.changelog.host, 'Version|Date|Changes');
  if (logTable && !logTable.findOne(function (n) { return n.type === 'TEXT' && n.characters === RELEASE.version; })) {
    await onPage(T.changelog, 'Changelog', function () { appendTableRow(logTable, [RELEASE.version, RELEASE.date, RELEASE.changes], CHANGELOG_WIDTHS); fitSection(T.changelog.host); });
    added.push('changelog row ' + RELEASE.version);
  }
  const meta = { Version: SPEC.version, Updated: RELEASE.date };
  const coverEdits = [];
  const coverOf = function (k) { const f = T.cover.host.findOne(function (n) { return n.type === 'FRAME' && n.name === k && n.children.length === 2; }); const t = f && f.children[1]; return t && t.type === 'TEXT' ? t : null; };
  if (coverOf('Version') && semverLess(coverOf('Version').characters, SPEC.version)) Object.keys(meta).forEach(function (k) { const t = coverOf(k); if (t) coverEdits.push([t, meta[k]]); });
  if (coverEdits.length) { await onPage(T.cover, 'Cover', function () { coverEdits.forEach(function (e) { e[0].characters = e[1]; }); }); added.push('cover version'); }

  await flush();
  if (semverLess(figma.root.getPluginData('version') || '1.0.0', SPEC.version)) { figma.root.setPluginData('version', SPEC.version); added.push('file version ' + SPEC.version); }
  if (!added.length) log('✓ Library is already at ' + SPEC.version + '. Nothing to add.');
  else { log('✓ Added to the library (' + SPEC.version + '):'); added.forEach(function (a) { log('    + ' + a); }); log('Nothing was deleted or rebuilt. Next: run Audit file, then Export tokens (expect a diff only for size/bottom-bar and the version line).'); }
  post({ type: 'done', report: S.report, added: added });
}

// ---------------------------------------------------------------- state for commands run on an existing file
async function loadState() {
  const colls = await figma.variables.getLocalVariableCollectionsAsync();
  const byName = {}; colls.forEach(function (c) { byName[c.name] = c; });
  if (!byName.Color || !byName.Dimension) throw new Error('This file has no MondaPac library. Build it first.');
  async function vars(c) { const out = {}; if (!c) return out; for (let i = 0; i < c.variableIds.length; i++) { const v = await figma.variables.getVariableByIdAsync(c.variableIds[i]); if (v) out[v.name] = v; } return out; }
  S.color = await vars(byName.Color); S.colorDark = await vars(byName['Color · Dark']);
  S.dim = await vars(byName.Dimension); S.dimTouch = await vars(byName['Dimension · Touch']);
  const cm = byName.Color.modes; const dm = byName.Dimension.modes;
  S.modes.color = cm.length > 1; S.modes.dim = dm.length > 1;
  S.colorModes = { collection: byName.Color, light: cm[0].modeId, dark: cm[1] ? cm[1].modeId : null, darkCollection: byName['Color · Dark'] || null, darkAlt: byName['Color · Dark'] ? byName['Color · Dark'].modes[0].modeId : null };
  S.dimModes = { collection: byName.Dimension, desktop: dm[0].modeId, touch: dm[1] ? dm[1].modeId : null, touchCollection: byName['Dimension · Touch'] || null, touchAlt: byName['Dimension · Touch'] ? byName['Dimension · Touch'].modes[0].modeId : null };
  return byName;
}
function pairMaps(a, b) { const ab = {}, ba = {}; Object.keys(a).forEach(function (k) { if (b[k]) { ab[a[k].id] = b[k]; ba[b[k].id] = a[k]; } }); return { ab: ab, ba: ba }; }

async function themeSelection(theme) {
  await loadState();
  const sel = figma.currentPage.selection;
  if (!sel.length) { post({ type: 'error', message: 'Select one or more frames first.' }); return; }
  sel.forEach(function (n) { applyTheme(n, theme); });
  post({ type: 'done', report: ['✓ ' + (theme === 'dark' ? 'Dark' : 'Light') + ' theme applied to ' + sel.length + ' layer(s).'] });
}
async function densitySelection(density) {
  await loadState();
  const sel = figma.currentPage.selection;
  if (!sel.length) { post({ type: 'error', message: 'Select one or more frames first.' }); return; }
  const m = pairMaps(S.dim, S.dimTouch);
  sel.forEach(function (n) {
    if (S.modes.dim) n.setExplicitVariableModeForCollection(S.dimModes.collection, density === 'touch' ? S.dimModes.touch : S.dimModes.desktop);
    else rebindTree(n, density === 'touch' ? m.ab : m.ba);
    n.setPluginData('density', density);
  });
  post({ type: 'done', report: ['✓ ' + (density === 'touch' ? 'Touch' : 'Desktop') + ' density applied to ' + sel.length + ' layer(s).'] });
}

// After a plan upgrade: merge "Color · Dark" and "Dimension · Touch" into modes, rebind every layer,
// and move the Starter sections onto their own pages.
async function upgradeModes() {
  await figma.loadAllPagesAsync();
  await loadState();
  const report = []; let blocked = false;
  const jobs = [];
  if (!S.modes.color && S.colorModes.darkCollection) jobs.push({ kind: 'theme', value: 'dark', main: S.colorModes.collection, alt: S.colorModes.darkCollection, altMode: S.colorModes.darkAlt, a: S.color, b: S.colorDark, modeName: 'Dark' });
  if (!S.modes.dim && S.dimModes.touchCollection) jobs.push({ kind: 'density', value: 'touch', main: S.dimModes.collection, alt: S.dimModes.touchCollection, altMode: S.dimModes.touchAlt, a: S.dim, b: S.dimTouch, modeName: 'Touch' });
  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j];
    const mode = tryAddMode(job.main, job.modeName);
    if (!mode) { blocked = true; report.push('ℹ ' + job.main.name + ': still one mode per collection on this plan.'); continue; }
    Object.keys(job.a).forEach(function (k) { const alt = job.b[k]; if (alt) job.a[k].setValueForMode(mode, alt.valuesByMode[job.altMode]); });
    const map = pairMaps(job.a, job.b).ba;
    let rebound = 0, switched = 0;
    figma.root.children.forEach(function (page) {
      page.findAll(function () { return true; }).forEach(function (n) {
        rebound += rebindNode(n, map);
        if (n.getPluginData(job.kind) === job.value) { try { n.setExplicitVariableModeForCollection(job.main, mode); switched++; } catch (e) { /* layer type has no modes */ } }
      });
    });
    const altName = job.alt.name; job.alt.remove();
    report.push('✓ ' + job.main.name + ': added mode "' + job.modeName + '", rebound ' + rebound + ' layers, switched ' + switched + ' frames, removed "' + altName + '".');
  }
  if (!jobs.length) report.push('✓ Variables already use modes.');
  // Split Starter sections into pages
  const compact = figma.root.children.filter(function (p) { return p.getPluginData(PLUGIN_TAG) === 'page' && p.getPluginData('layout') === 'compact'; });
  if (compact.length) {
    const made = tryCreatePages(PAGES.length);
    if (!made) { blocked = true; report.push('ℹ Pages: still limited to 3 per file; sections kept.'); }
    else {
      const sections = {};
      compact.forEach(function (p) { p.children.forEach(function (n) { if (n.type === 'SECTION' && n.getPluginData('key')) sections[n.getPluginData('key')] = n; }); });
      const at = figma.root.children.indexOf(compact[0]);
      made.forEach(function (p, i) {
        const d = PAGES[i]; p.name = d[1]; p.setPluginData(PLUGIN_TAG, 'page'); p.setPluginData('key', d[0]); p.setPluginData('layout', 'full');
        figma.root.insertChild(at + i, p);
        const sec = sections[d[0]]; if (sec) { p.appendChild(sec); sec.x = 0; sec.y = 0; }
      });
      await figma.setCurrentPageAsync(made[0]);
      compact.forEach(function (p) { if (!p.children.length) p.remove(); else p.name = p.name + ' (leftovers)'; });
      report.push('✓ Pages: moved ' + Object.keys(sections).length + ' sections onto ' + PAGES.length + ' pages.');
    }
  }
  if (blocked && !report.some(function (l) { return l.indexOf('✓ Color') === 0 || l.indexOf('✓ Pages') === 0 || l.indexOf('✓ Dimension') === 0; })) {
    post({ type: 'error', message: 'This file is still on the Starter plan limits (1 mode per collection, 3 pages). Upgrade the Figma plan, then run this again.', report: report }); return;
  }
  post({ type: 'done', report: report });
}

// ---------------------------------------------------------------- audit (design lint for the whole file)
async function auditFile() {
  await figma.loadAllPagesAsync();
  const KINDS = { raw: 'Paints not bound to a variable', text: 'Text without a text style', overflow: 'Layers sticking out of their parent', desc: 'Components without a description', focus: 'Focus variants without a focus ring' };
  const hits = {}; Object.keys(KINDS).forEach(function (k) { hits[k] = {}; });
  function where(n) { const p = []; for (let x = n; x && x.type !== 'PAGE'; x = x.parent) p.unshift(x.name); return p.slice(-4).join(' › '); }
  function hit(k, n, extra) { const key = where(n) + (extra ? ' ' + extra : ''); hits[k][key] = (hits[k][key] || 0) + 1; }
  let total = 0;
  figma.root.children.forEach(function (page) {
    page.findAll(function () { return true; }).forEach(function (n) {
      total++;
      const swatch = / · (light|dark)$/.test(n.name);
      if (!swatch && 'fills' in n && Array.isArray(n.fills)) n.fills.forEach(function (p) { if (p.type === 'SOLID' && p.visible !== false && !(p.boundVariables && p.boundVariables.color)) hit('raw', n, '(fill)'); });
      if (!swatch && n.type !== 'COMPONENT_SET' && 'strokes' in n && Array.isArray(n.strokes)) n.strokes.forEach(function (p) { if (p.type === 'SOLID' && p.visible !== false && !(p.boundVariables && p.boundVariables.color)) hit('raw', n, '(stroke)'); });
      if (n.type === 'TEXT' && !n.textStyleId) hit('text', n);
      if ((n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && n.parent.type !== 'COMPONENT_SET')) && !n.description && n.name.indexOf('Icon/') !== 0) hit('desc', n);
      if (n.type === 'COMPONENT' && n.parent.type === 'COMPONENT_SET' && /State=Focus/.test(n.name) && !(n.effects && n.effects.some(function (e) { return e.visible !== false; }))) hit('focus', n);
      const p = n.parent;
      // Only auto-layout parents: free-form compositions (maps, charts, badge overlays) overlap on purpose.
      if (n.visible && p && p.type !== 'PAGE' && p.type !== 'SECTION' && p.layoutMode && p.layoutMode !== 'NONE' && n.absoluteBoundingBox && p.absoluteBoundingBox && !(n.layoutPositioning === 'ABSOLUTE')) {
        const a = n.absoluteBoundingBox, b = p.absoluteBoundingBox;
        const over = Math.max(a.x + a.width - (b.x + b.width), a.y + a.height - (b.y + b.height), b.x - a.x, b.y - a.y);
        if (over > 1.5) hit('overflow', n, '+' + Math.round(over) + 'px' + (p.clipsContent ? ' clipped' : ''));
      }
    });
  });
  const report = ['Audit of ' + total + ' layers:'];
  Object.keys(KINDS).forEach(function (k) {
    const list = Object.keys(hits[k]); const count = list.reduce(function (a, x) { return a + hits[k][x]; }, 0);
    report.push((count ? '⚠ ' : '✓ ') + KINDS[k] + ': ' + count + (count ? ' (' + list.length + ' unique)' : ''));
    list.slice(0, 25).forEach(function (x) { report.push('    ' + x + (hits[k][x] > 1 ? ' ×' + hits[k][x] : '')); });
  });
  post({ type: 'done', report: report });
}

// ---------------------------------------------------------------- export (DTCG files + CSS), byte-compatible with docs/design/tokens
// Ordered object so the JSON keeps Figma's order (plain JS objects would sort numeric keys).
function OM() { return { __om: true, keys: [], map: {} }; }
function omSet(o, k, v) { if (!Object.prototype.hasOwnProperty.call(o.map, k)) o.keys.push(k); o.map[k] = v; return v; }
function omGet(o, k) { return Object.prototype.hasOwnProperty.call(o.map, k) ? o.map[k] : omSet(o, k, OM()); }
function nestInto(root, path, leaf) { const parts = path.split('/'); let cur = root; for (let i = 0; i < parts.length - 1; i++) cur = omGet(cur, parts[i]); omSet(cur, parts[parts.length - 1], leaf); }
function obj(pairs) { const o = OM(); pairs.forEach(function (p) { omSet(o, p[0], p[1]); }); return o; }
function pyStr(s) { return JSON.stringify(s).replace(/[\u0080-￿]/g, function (c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); }); }
function dumps(v, ind) {
  ind = ind || '';
  if (v && v.__om) {
    if (!v.keys.length) return '{}';
    const inner = ind + '  ';
    return '{\n' + v.keys.map(function (k) { return inner + pyStr(k) + ': ' + dumps(v.map[k], inner); }).join(',\n') + '\n' + ind + '}';
  }
  if (typeof v === 'string') return pyStr(v);
  return String(v);
}
function hex2(n) { return ('0' + Math.round(n * 255).toString(16)).slice(-2).toUpperCase(); }
function toHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b); }
function num(n) { return String(+(+n).toFixed(3)); }
function cssName(n) { return '--mp-' + n.replace(/\//g, '-'); }
const WEIGHT = { Regular: 400, Medium: 500, SemiBold: 600, 'Semi Bold': 600, Bold: 700 };

async function exportTokens(version) {
  const byName = await loadState();
  async function list(c) { const out = []; if (!c) return out; for (let i = 0; i < c.variableIds.length; i++) { const v = await figma.variables.getVariableByIdAsync(c.variableIds[i]); if (v) out.push(v); } return out; }
  async function aliasPath(val) { if (val && val.type === 'VARIABLE_ALIAS') { const t = await figma.variables.getVariableByIdAsync(val.id); return t ? t.name : null; } return null; }
  async function resolveHex(val) {
    let guard = 0;
    while (val && val.type === 'VARIABLE_ALIAS' && guard++ < 10) { const t = await figma.variables.getVariableByIdAsync(val.id); if (!t) return null; const c = await figma.variables.getVariableCollectionByIdAsync(t.variableCollectionId); val = t.valuesByMode[c.modes[0].modeId]; }
    return val && val.r !== undefined ? toHex(val) : null;
  }
  const files = {};
  // primitives
  const prim = OM();
  const primVars = await list(byName.Primitives);
  primVars.forEach(function (v) { nestInto(prim, v.name, obj([['$type', 'color'], ['$value', toHex(v.valuesByMode[byName.Primitives.modes[0].modeId])]])); });
  files['primitives.json'] = obj([['$description', 'MondaPac primitives. Do not use directly in UI; use semantic tokens.'], ['color', omGet(prim, 'color')]]);
  // semantic colour, light + dark
  const colorVars = await list(byName.Color);
  const darkByName = {}; (await list(byName['Color · Dark'])).forEach(function (v) { darkByName[v.name] = v; });
  const css = { light: [], dark: [] };
  for (let t = 0; t < 2; t++) {
    const theme = t ? 'dark' : 'light'; const body = OM();
    for (let i = 0; i < colorVars.length; i++) {
      const v = colorVars[i];
      const val = theme === 'light' ? v.valuesByMode[S.colorModes.light] : (S.colorModes.dark ? v.valuesByMode[S.colorModes.dark] : (darkByName[v.name] ? darkByName[v.name].valuesByMode[S.colorModes.darkAlt] : null));
      if (!val) continue;
      const ap = await aliasPath(val);
      const leaf = [['$type', 'color'], ['$value', ap ? '{' + ap.replace(/\//g, '.') + '}' : toHex(val)]];
      if (v.description) leaf.push(['$description', v.description]);
      nestInto(body, v.name, obj(leaf));
      css[theme].push('  ' + cssName('color/' + v.name) + ': ' + (await resolveHex(val)) + ';');
    }
    files['color.' + theme + '.json'] = obj([['$description', 'MondaPac semantic colour, ' + theme + ' theme. Aliases point to primitives.json.'], ['color', body]]);
  }
  // dimensions, desktop + touch
  const dimVars = await list(byName.Dimension);
  const touchByName = {}; (await list(byName['Dimension · Touch'])).forEach(function (v) { touchByName[v.name] = v; });
  const dimCss = { desktop: [], touch: [] };
  ['desktop', 'touch'].forEach(function (dens) {
    const body = obj([['$description', 'MondaPac dimensions, ' + dens + ' density.']]);
    dimVars.forEach(function (v) {
      const d = v.valuesByMode[S.dimModes.desktop];
      const val = dens === 'desktop' ? d : (S.dimModes.touch ? v.valuesByMode[S.dimModes.touch] : (touchByName[v.name] ? touchByName[v.name].valuesByMode[S.dimModes.touchAlt] : d));
      nestInto(body, v.name, obj([['$type', 'dimension'], ['$value', num(val) + 'px']]));
      if (dens === 'desktop' || val !== d) dimCss[dens].push('  ' + cssName(v.name) + ': ' + num(val) + 'px;');
    });
    files['dimension.' + dens + '.json'] = body;
  });
  // typography from text styles
  const typ = OM();
  const tstyles = await figma.getLocalTextStylesAsync();
  tstyles.forEach(function (s) {
    const parts = s.name.split('/'); if (parts.length !== 2) return;
    const ls = s.letterSpacing.unit === 'PERCENT' ? s.letterSpacing.value * s.fontSize / 100 : s.letterSpacing.value;
    const lh = s.lineHeight.unit === 'PIXELS' ? num(s.lineHeight.value) + 'px' : (s.lineHeight.unit === 'PERCENT' ? num(s.lineHeight.value * s.fontSize / 100) + 'px' : 'normal');
    omSet(omGet(typ, parts[0].toLowerCase()), parts[1].toLowerCase().replace(/ /g, '-'), obj([['$type', 'typography'], ['$value', obj([
      ['fontFamily', s.fontName.family], ['fontWeight', WEIGHT[s.fontName.style] || 400], ['fontSize', num(s.fontSize) + 'px'], ['lineHeight', lh], ['letterSpacing', num(ls) + 'px'],
    ])]]));
  });
  files['typography.json'] = obj([['$description', 'MondaPac text styles (match Figma text styles).'], ['typography', typ]]);
  // CSS
  const tyVars = {}; (await list(byName.Typography)).forEach(function (v) { tyVars[v.name] = v.valuesByMode[byName.Typography.modes[0].modeId]; });
  const motion = await list(byName.Motion);
  const estyles = await figma.getLocalEffectStylesAsync();
  async function shadow(s, theme) {
    const parts = [];
    for (let i = 0; i < s.effects.length; i++) {
      const e = s.effects[i]; if (e.type !== 'DROP_SHADOW') continue;
      let c = e.color; const b = e.boundVariables && e.boundVariables.color;
      if (b && theme === 'dark') {
        const lv = await figma.variables.getVariableByIdAsync(b.id);
        const val = S.colorModes.dark ? lv.valuesByMode[S.colorModes.dark] : (darkByName[lv.name] ? darkByName[lv.name].valuesByMode[S.colorModes.darkAlt] : null);
        const h = await resolveHex(val); if (h) c = { r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: e.color.a };
      }
      parts.push(Math.round(e.offset.x) + 'px ' + Math.round(e.offset.y) + 'px ' + Math.round(e.radius) + 'px ' + Math.round(e.spread || 0) + 'px rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + num(c.a) + ')');
    }
    return '  ' + cssName('shadow/' + s.name.toLowerCase().replace(/ /g, '-')) + ': ' + parts.join(', ') + ';';
  }
  const lines = ["/* MondaPac design tokens v" + version + ". Source of truth: the Figma file 'MondaPac Design System'.",
    ' * Do not edit by hand. Change the Figma variables, run the plugin command Export tokens and commit these files. */', ':root {'];
  css.light.forEach(function (l) { lines.push(l); }); dimCss.desktop.forEach(function (l) { lines.push(l); });
  lines.push("  --mp-font-family-sans: '" + (tyVars['font/family/sans'] || 'IBM Plex Sans') + "', system-ui, sans-serif;\n  --mp-font-family-mono: '" + (tyVars['font/family/mono'] || 'IBM Plex Mono') + "', ui-monospace, monospace;");
  tstyles.forEach(function (st) {
    const parts = st.name.split('/'); if (parts.length !== 2) return;
    const key = parts[0].toLowerCase() + '-' + parts[1].toLowerCase().replace(/ /g, '-');
    const fam = st.fontName.family === tyVars['font/family/mono'] ? 'mono' : 'sans';
    const lh = st.lineHeight.unit === 'PIXELS' ? num(st.lineHeight.value) + 'px' : 'normal';
    lines.push('  --mp-text-' + key + ': ' + (WEIGHT[st.fontName.style] || 400) + ' ' + num(st.fontSize) + 'px/' + lh + ' var(--mp-font-family-' + fam + ');');
    const ls = st.letterSpacing.unit === 'PERCENT' ? st.letterSpacing.value * st.fontSize / 100 : st.letterSpacing.value;
    if (+num(ls) !== 0) lines.push('  --mp-text-' + key + '-tracking: ' + num(ls) + 'px;');
  });
  motion.forEach(function (v) { lines.push('  ' + cssName('motion/' + v.name) + ': ' + num(v.valuesByMode[byName.Motion.modes[0].modeId]) + 'ms;'); });
  lines.push('  --mp-motion-easing: cubic-bezier(0.2, 0, 0, 1);');
  for (let i = 0; i < estyles.length; i++) lines.push(await shadow(estyles[i], 'light'));
  lines.push('}\n\n[data-theme="dark"] {');
  css.dark.forEach(function (l) { lines.push(l); });
  for (let i = 0; i < estyles.length; i++) { const bound = estyles[i].effects.some(function (e) { return e.boundVariables && e.boundVariables.color; }); if (bound) lines.push(await shadow(estyles[i], 'dark')); }
  lines.push('}\n\n[data-density="touch"] {');
  dimCss.touch.forEach(function (l) { lines.push(l); });
  lines.push('}');
  const out = {};
  Object.keys(files).forEach(function (k) { out[k] = dumps(files[k]); });
  out['tokens.css'] = lines.join('\n') + '\n';
  figma.root.setPluginData('version', version);
  post({ type: 'export', files: out, version: version });
}

// ---------------------------------------------------------------- entry
figma.showUI(__html__, { width: 420, height: 640, themeColors: true, title: 'MondaPac Design System' });
post({ type: 'init', version: figma.root.getPluginData('version') || SPEC.version, specVersion: SPEC.version });
figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'build') await build(!!msg.force);
    else if (msg.type === 'update') await updateLibrary();
    else if (msg.type === 'theme') await themeSelection(msg.theme);
    else if (msg.type === 'density') await densitySelection(msg.density);
    else if (msg.type === 'upgrade') await upgradeModes();
    else if (msg.type === 'audit') await auditFile();
    else if (msg.type === 'export') await exportTokens(msg.version || SPEC.version);
    else if (msg.type === 'close') figma.closePlugin();
  } catch (e) {
    post({ type: 'error', message: (e && e.message) ? e.message : String(e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : '', report: S.report });
  }
};
