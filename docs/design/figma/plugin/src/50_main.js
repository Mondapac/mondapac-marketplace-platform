// ---------------------------------------------------------------- pages & orchestration
const PAGES = [
  ['cover', 'Cover'], ['start', 'Getting started'], ['changelog', 'Changelog'],
  ['sep-foundations', '———— Foundations'], ['color', 'Colour'], ['type', 'Typography'], ['spacing', 'Spacing, size & radius'], ['elevation', 'Elevation & motion'], ['icons', 'Icons'], ['a11y', 'Accessibility'],
  ['sep-components', '———— Components'], ['actions', 'Actions'], ['forms', 'Forms & selection'], ['status', 'Status & feedback'], ['data', 'Data display'], ['tables', 'Tables & collections'], ['nav', 'Navigation & shell'], ['review', 'Review & detail'], ['board', 'Board & delivery'],
  ['sep-templates', '———— Templates'], ['tpl-admin', 'Templates · Admin'], ['tpl-seller', 'Templates · Seller'], ['tpl-auth', 'Templates · Auth'], ['tpl-dark', 'Templates · Dark preview'],
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
  ['p-templates', '3 · Templates & workspace', 'V', ['tpl-admin', 'tpl-seller', 'tpl-auth', 'tpl-dark', 'sandbox', 'archive']],
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
  STEP = 0; STEPS = 26; S.report = [];
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
    const list = [tplSellerHome(), tplSellerOrders(), tplSellerBoard(), tplSellerPhoneHome(), tplSellerPhoneMenu()].concat(s1Screens().map(function (d) { return d[1](); }));
    templatesPage(h, 'Templates · Seller', 'Same structure as Admin with seller navigation, features and permissions. The order board is the tablet layout (touch density). Seller · Your seller account (S1, 1.7.0) is the landing page while a seller is not approved, in the limited shell.', list);
    return list;
  });
  const authScreensBuilt = await onPage(P['tpl-auth'], 'Auth templates', function (h) {
    const made = buildAuthFrames();
    rowsPage(h, 'Templates · Auth', AUTH_SUBTITLE, ['Seller', 'Admin', 'Phone'].map(function (r) { return made.filter(function (m) { return m.row === r; }).map(function (m) { return m.frame; }); }));
    return made.map(function (m) { return m.frame; });
  });
  await onPage(P['tpl-dark'], 'Dark preview', function (h) {
    const byName = {}; sellerScreens.concat(authScreensBuilt).forEach(function (s) { byName[s.name] = s; });
    const clones = [adminScreens[0], sellerScreens[1], sellerScreens[2]].concat(DARK_170.map(function (n) { return byName[n]; })).map(function (s) { const c = s.clone(); c.name = s.name + ' · Dark'; return c; });
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
function pageOf(node) { let p = node; while (p && p.type !== 'PAGE') p = p.parent; return { page: p, host: p }; }
function bottomEdge(host) { let b = 0; host.children.forEach(function (c) { b = Math.max(b, c.y + c.height); }); return b; }
// The library page's root frame (made by pageShell), or a new one to the right of what is there.
function docRoot(host, title, subtitle) {
  let root = host.children.filter(function (n) { return n.type === 'FRAME' && n.name === title; })[0];
  if (!root) { const y = host.children.length ? Math.min.apply(null, host.children.map(function (c) { return c.y; })) : 0; const x = rightEdge(host) + 160; root = pageShell(host, title, subtitle); root.x = x; root.y = y; tag(root); }
  return root;
}
// Templates · Auth (1.7.0) in a file built before it: a section below the other template sections (Starter layout)
// or a new page after Templates · Seller.
async function ensureAuthHost(T) {
  if (T['tpl-auth']) return T['tpl-auth'];
  const ref = T['tpl-seller'];
  if (ref.host.type === 'SECTION') {
    await figma.setCurrentPageAsync(ref.page);
    let bottom = 0; ref.page.children.forEach(function (n) { bottom = Math.max(bottom, n.y + n.height); });
    const sec = makeSection(ref.page, 'tpl-auth'); sec.x = ref.host.x; sec.y = bottom + 240; sec.resizeWithoutConstraints(480, 320);
    T['tpl-auth'] = { page: ref.page, host: sec };
    return T['tpl-auth'];
  }
  let p = null; try { p = figma.createPage(); } catch (e) { return null; }
  p.name = TITLE['tpl-auth']; p.setPluginData(PLUGIN_TAG, 'page'); p.setPluginData('key', 'tpl-auth'); p.setPluginData('layout', 'full');
  figma.root.insertChild(figma.root.children.indexOf(ref.page) + 1, p);
  T['tpl-auth'] = { page: p, host: p };
  return T['tpl-auth'];
}
function semverLess(a, b) { const x = String(a || '0').split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; }

async function updateLibrary() {
  STEP = 0; STEPS = 8; S.report = [];
  await figma.loadAllPagesAsync();
  const state = await fileIsEmpty();
  if (state.empty) { post({ type: 'error', message: 'This file is empty. Update library only adds to an existing MondaPac library; use Build library in a new file.' }); return; }
  if (!state.hasLibrary) { post({ type: 'error', message: 'This file has no MondaPac library. Use Build library in a new, empty design file.' }); return; }
  await loadState();
  await hydrateLibrary();
  const T = findHosts();
  const need = ['nav', 'forms', 'review', 'tpl-seller', 'tpl-admin', 'tpl-dark', 'changelog', 'spacing', 'cover', 'icons'].filter(function (k) { return !T[k]; });
  const base = ['CountBadge', 'NavGroupLabel', 'NavItem', 'IconButton', 'IdentityTile', 'QueueCard', 'Sidebar', 'Topbar', 'Button', 'Input', 'Checkbox', 'Badge', 'InfoBanner', 'ProductThumb', 'ChecklistItem'].filter(function (k) { return !S.sets[k]; });
  if (need.length || base.length || !S.ts['Body/Default'] || !S.es['Focus/Ring']) {
    post({ type: 'error', message: 'This library is incomplete, so it cannot be updated safely. Missing: ' + need.concat(base).join(', ') + '. Restore it from version history or rebuild it in a new file.' }); return;
  }
  await loadFonts();
  const added = [];

  // 1 · tokens (1.7.0 adds primitives first: new colour tokens alias them)
  const missingPrims = S.primColl ? SPEC.primitives.filter(function (p) { return !S.prim[p.name]; }) : [];
  missingPrims.forEach(function (p) { addPrimitive(p); added.push('primitive ' + p.name); });
  const missingColors = SPEC.color.filter(function (c) { return !S.color[c.name]; });
  missingColors.forEach(function (c) { addColorVariable(c); added.push('variable ' + c.name + (S.colorModes.darkCollection ? ' (Color and Color · Dark)' : ' (Light and Dark modes)')); });
  const missingVars = SPEC.dimension.filter(function (d) { return !S.dim[d.name]; });
  missingVars.forEach(function (d) { addDimensionVariable(d); added.push('variable ' + d.name + (S.dimModes.touchCollection ? ' (Dimension and Dimension · Touch)' : ' (Desktop and Touch modes)')); });

  // 1b · icons (1.6.0: menu), added to the Icons page
  const missingIcons = Object.keys(ICONS).filter(function (n) { return !S.icons[n]; });
  if (missingIcons.length) {
    await onPage(T.icons, 'Icons', function (host) {
      const wrap = host.findAll(function (n) { return n.type === 'FRAME' && n.name === 'Icons' && n.layoutWrap === 'WRAP'; })[0];
      missingIcons.forEach(function (n) {
        const cell = iconCell(n);
        if (wrap) add(wrap, cell); else { host.appendChild(cell); cell.x = rightEdge(host) + 160; cell.y = 0; }
      });
      fitSection(host);
    });
    missingIcons.forEach(function (n) { added.push('icon ' + n); });
  }

  // 2 · components, documented on the Navigation & shell page
  const have = { NavDrawer: !!S.sets.NavDrawer, BottomTabBar: !!S.sets.BottomTabBar, PhoneTopbar: !!S.sets.PhoneTopbar };
  if (!have.NavDrawer || !have.BottomTabBar || !have.PhoneTopbar) {
    await onPage(T.nav, 'Navigation components', function (host) {
      let root = host.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'Navigation & shell'; })[0];
      if (!root) { const y = host.children.length ? Math.min.apply(null, host.children.map(function (c) { return c.y; })) : 0; const x = rightEdge(host) + 160; root = pageShell(host, 'Navigation & shell', 'One shell for both panels. The Sidebar variant decides the workspace; the menu items come from configuration and permissions.'); root.x = x; root.y = y; tag(root); }
      buildMobileNav(root, have);
      fitSection(host);
    });
    if (!have.PhoneTopbar) added.push('component PhoneTopbar');
    if (!have.NavDrawer) added.push('component NavDrawer');
    if (!have.BottomTabBar) added.push('component BottomTabBar');
  }

  // 2b · fixes to components an earlier 1.5.0 update added (real-Figma Audit, 2026-10-07):
  // the seller drawer's item list was 3 px taller than the drawer, so its rows lose the 2 px gap.
  if (have.NavDrawer && S.sets.NavDrawer.set) {
    const lists = [];
    S.sets.NavDrawer.set.children.forEach(function (v) { const l = v.findOne(function (n) { return n.type === 'FRAME' && n.name === 'items'; }); if (l && l.itemSpacing !== 0) lists.push(l); });
    if (lists.length) {
      await onPage(T.nav, 'NavDrawer item spacing', function () { lists.forEach(function (l) { l.setBoundVariable('itemSpacing', null); l.itemSpacing = 0; }); });
      added.push('fix NavDrawer item spacing (' + lists.length + ' variants)');
    }
  }

  // 2b-2 · the NavDrawer description of a 1.5.0 file still names the old scrim (text/primary at 50%); use the 1.6.0 wording.
  const OLD_SCRIM_NOTE = 'scrim (text/primary at 50%; the scrim belongs', NEW_SCRIM_NOTE = 'scrim (bg/scrim; the scrim belongs';
  if (have.NavDrawer && S.sets.NavDrawer.set && S.sets.NavDrawer.set.description.indexOf(OLD_SCRIM_NOTE) >= 0) {
    const nd = S.sets.NavDrawer.set;
    await onPage(T.nav, 'NavDrawer scrim note', function () { nd.description = nd.description.split(OLD_SCRIM_NOTE).join(NEW_SCRIM_NOTE); });
    added.push('update NavDrawer scrim note');
  }

  // 2c · fixes to the phone templates an earlier 1.5.0 update added (release 1.6.0): the drawer scrim takes bg/scrim
  // at 100% (it was text/primary at 50%) and the loose "Topbar · phone" frame becomes a PhoneTopbar instance.
  // The old frame is the only thing this release deletes, and only inside a plugin-made phone template.
  // The old frame is only removed when it has the 1.5.0 shape, and only if PhoneTopbar is the plugin's own set.
  function isPluginPhoneTopbar(n) {
    return n.type === 'FRAME' && n.layoutMode === 'HORIZONTAL' && Math.round(n.height) === 56 && ['menu-button', 'panel-name', 'notifications', 'account-button'].every(function (nm) { return n.children.some(function (c) { return c.name === nm; }); });
  }
  const ptbOk = !!(S.sets.PhoneTopbar && S.sets.PhoneTopbar.set && S.sets.PhoneTopbar.set.getPluginData(PLUGIN_TAG) === '1'); let clash = false;
  const phoneTplKeys = Object.keys(PHONE_TEMPLATES); const scrimFix = []; const topbarFix = [];
  phoneTplKeys.forEach(function (key) {
    T[key].host.children.forEach(function (scr) {
      if (scr.type !== 'FRAME' || PHONE_TEMPLATES[key].names.indexOf(scr.name) < 0 || scr.getPluginData(PLUGIN_TAG) !== '1') return;
      const scrim = scr.children.filter(function (n) { return n.type === 'FRAME' && n.name === 'scrim'; })[0];
      const bound = S.color['bg/scrim'] ? S.color['bg/scrim'].id : null;
      if (scrim && bound && !(scrim.fills.length === 1 && scrim.fills[0].boundVariables && scrim.fills[0].boundVariables.color && scrim.fills[0].boundVariables.color.id === bound && (scrim.fills[0].opacity === undefined || scrim.fills[0].opacity === 1))) scrimFix.push({ key: key, scrim: scrim });
      const old = scr.children.filter(function (n) { return n.name === 'Topbar · phone'; })[0];
      if (old && !isPluginPhoneTopbar(old)) log('ℹ skipped Topbar · phone in ' + scr.name + ': not the plugin\'s frame');
      else if (old && !ptbOk) { if (!clash) log('ℹ skipped phone topbar swap: a PhoneTopbar component set that is not the plugin\'s already exists in this file'); clash = true; }
      else if (old) topbarFix.push({ key: key, scr: scr, old: old });
    });
  });
  for (let i = 0; i < phoneTplKeys.length; i++) {
    const key = phoneTplKeys[i];
    const sf = scrimFix.filter(function (f) { return f.key === key; }); const tf = topbarFix.filter(function (f) { return f.key === key; });
    if (!sf.length && !tf.length) continue;
    await onPage(T[key], 'Phone template fixes', function () {
      sf.forEach(function (f) { f.scrim.fills = [paint('bg/scrim')]; });
      tf.forEach(function (f) {
        const at = f.scr.children.indexOf(f.old);
        const ptb = phoneTopbar(f.scr.name.indexOf('Admin') === 0 ? 'Admin' : 'Seller');
        add(f.scr, ptb); f.scr.insertChild(at, ptb);
        f.old.remove();
      });
    });
  }
  if (scrimFix.length) added.push('bind drawer scrim to bg/scrim (' + scrimFix.length + ' templates)');
  if (topbarFix.length) added.push('swap phone topbar for PhoneTopbar (' + topbarFix.length + ' templates)');

  // 2d · release 1.7.0 "Auth": variants and properties added to existing sets, then the new components.
  // Only sets the plugin made are changed (PLUGIN_TAG); a set of the same name made by someone else is skipped and reported.
  const own = function (name) { const r = S.sets[name]; const n = r && (r.set || r.comp); return !!(n && n.getPluginData(PLUGIN_TAG) === '1'); };
  const skipped = {};
  const skip = function (name, why) { skipped[name] = 1; log('ℹ skipped ' + why); };
  const missingCombos = function (rec, list) { const have = {}; rec.set.children.forEach(function (c) { have[variantName(sortedProps(c.variantProperties, rec.axes))] = 1; }); return list.filter(function (p) { return !have[variantName(sortedProps(p, rec.axes))]; }); };
  const OLD_DESC = { Button: 'Actions. Primary: one per area. Secondary: supporting actions. Destructive: irreversible actions, label ends with … and opens a confirmation. Ghost: low-emphasis actions like Clear.', Input: 'Text and search input. Border uses border/input (3:1).', ChecklistItem: 'One verification check. Automatic checks show when they ran; manual checks offer Confirm or Flag a problem.', Topbar: 'Breadcrumb, command search (Ctrl K), market context, notifications and the user.' };
  const NEW_DESC = { Button: BUTTON_OPTS.desc, Input: INPUT_OPTS.desc, ChecklistItem: CHECKLIST_OPTS.desc, Topbar: TOPBAR_DESC };
  const refreshDesc = function (name) { const n = S.sets[name].set; if (n.description === OLD_DESC[name]) { n.description = NEW_DESC[name]; added.push('update ' + name + ' description'); } };
  let inputRenamed = 0;
  if (!own('Button')) skip('Button', 'Button variants Link and Loading: the Button set is not the plugin\'s');
  else if (missingCombos(S.sets.Button, combos(BUTTON_AXES)).length || S.sets.Button.set.description === OLD_DESC.Button) {
    await onPage(pageOf(S.sets.Button.set), 'Button variants', function () {
      const made = addVariants(S.sets.Button, combos(BUTTON_AXES), buttonVariant, BUTTON_OPTS, 'State');
      if (made.length) added.push('Button variants (' + made.length + '): Variant=Link and State=Loading');
      refreshDesc('Button');
    });
  }
  if (!own('Input')) skip('Input', 'Input variants Password and Code: the Input set is not the plugin\'s');
  else {
    const rec = S.sets.Input;
    const plain = rec.set.children.filter(function (c) { return c.variantProperties.Type === undefined; });
    const later = rec.axes.indexOf('Type') >= 0 ? missingCombos(rec, combos(INPUT_AXES)) : ['all'];
    if (plain.length || later.length || rec.set.description === OLD_DESC.Input) {
      await onPage(pageOf(rec.set), 'Input variants', function () {
        // The Type axis is added by naming the existing variants Type=Text; their layers and instances stay as they are.
        plain.forEach(function (c) { c.name = 'Type=Text, ' + c.name; }); inputRenamed = plain.length;
        if (rec.axes.indexOf('Type') < 0) rec.axes = ['Type'].concat(rec.axes);
        if (plain.length) added.push('Input variant property Type (' + plain.length + ' existing variants named Type=Text)');
        const made = addVariants(rec, combos(INPUT_AXES), inputVariant, INPUT_OPTS, 'State');
        if (made.length) added.push('Input variants (' + made.length + '): Type=Password and Type=Code');
        refreshDesc('Input');
      });
    }
  }
  if (!own('ChecklistItem')) skip('ChecklistItem', 'ChecklistItem variants Waiting and Needs attention: the ChecklistItem set is not the plugin\'s');
  else {
    const rec = S.sets.ChecklistItem;
    if (!rec.keys['Show actions'] || !rec.keys.Action || missingCombos(rec, combos(CHECKLIST_AXES)).length || rec.set.description === OLD_DESC.ChecklistItem) {
      await onPage(pageOf(rec.set), 'ChecklistItem variants', function () {
        if (!rec.keys['Show actions']) { rec.keys['Show actions'] = rec.set.addComponentProperty('Show actions', 'BOOLEAN', true); rec.set.children.forEach(function (v) { wireVariant(v, rec.keys, { bool: CHECKLIST_OPTS.bool }); }); added.push('ChecklistItem property Show actions'); }
        if (!rec.keys.Action) { rec.keys.Action = rec.set.addComponentProperty('Action', 'TEXT', 'Update your details'); added.push('ChecklistItem property Action'); }
        const made = addVariants(rec, combos(CHECKLIST_AXES), checklistVariant, CHECKLIST_OPTS, 'State');
        if (made.length) added.push('ChecklistItem variants (' + made.length + '): Waiting and Needs attention');
        refreshDesc('ChecklistItem');
      });
    }
  }
  if (!own('Topbar')) skip('Topbar', 'Topbar properties Show search and Show notifications: the Topbar set is not the plugin\'s');
  else {
    const rec = S.sets.Topbar; const miss = TOPBAR_BOOLS.filter(function (b) { return !rec.keys[b.prop]; });
    if (miss.length || rec.set.description === OLD_DESC.Topbar) {
      await onPage(pageOf(rec.set), 'Topbar properties', function () {
        miss.forEach(function (b) { rec.keys[b.prop] = rec.set.addComponentProperty(b.prop, 'BOOLEAN', b.def); rec.set.children.forEach(function (v) { wireVariant(v, rec.keys, { bool: [b] }); }); added.push('Topbar property ' + b.prop); });
        refreshDesc('Topbar');
      });
    }
  }
  // New components. A component of the same name that is not the plugin's blocks it (and what depends on it).
  ['BrandMark', 'MenuItem', 'Menu', 'ReasonQuote', 'Field', 'AuthShowcase'].forEach(function (n) { if (S.sets[n] && !own(n)) skip(n, 'component ' + n + ': a component named ' + n + ' that is not the plugin\'s already exists in this file'); });
  if (skipped.Input && !S.sets.Field) skip('Field', 'component Field: it needs the plugin\'s Input with Type=Text');
  if (skipped.MenuItem && !S.sets.Menu) skip('Menu', 'component Menu: it needs the plugin\'s MenuItem');
  const navNew = ['BrandMark', 'MenuItem', 'Menu', 'AuthShowcase'].filter(function (n) { return !S.sets[n] && !skipped[n]; });
  if (navNew.length) {
    await onPage(T.nav, 'Auth components', function (host) {
      const root = docRoot(host, 'Navigation & shell', 'One shell for both panels. The Sidebar variant decides the workspace; the menu items come from configuration and permissions.');
      if (navNew.indexOf('BrandMark') >= 0) brandMarkBlock(root);
      if (navNew.indexOf('Menu') >= 0 || navNew.indexOf('MenuItem') >= 0) menuBlock(root, { MenuItem: S.sets.MenuItem ? S.sets.MenuItem.set : null });
      if (navNew.indexOf('AuthShowcase') >= 0) showcaseBlock(root);
      fitSection(host);
    });
    navNew.forEach(function (n) { added.push('component ' + n); });
  }
  if (!S.sets.ReasonQuote && !skipped.ReasonQuote) {
    await onPage(T.review, 'ReasonQuote', function (host) { reasonQuoteBlock(docRoot(host, 'Review & detail', 'Building blocks of the review workspace: queue summary cards, extracted document fields, checks and the activity timeline.')); fitSection(host); });
    added.push('component ReasonQuote');
  }
  if (!S.sets.Field && !skipped.Field) {
    await onPage(T.forms, 'Field', function (host) { fieldBlock(docRoot(host, 'Forms & selection', 'Inputs, checkboxes, switches, segmented controls, tabs and filter chips.')); fitSection(host); });
    added.push('component Field');
  }

  // 3b · 1.7.0 templates: Auth (its own page or section), S1 on Templates · Seller, and their dark previews.
  // A template is built only when every component it places is the plugin's (made earlier or in this run).
  const blockedBy = function (names) { return names.filter(function (n) { return skipped[n] || !own(n); }); };
  const authBlock = blockedBy(['Button', 'Input', 'BrandMark', 'Field', 'AuthShowcase', 'ReasonQuote', 'Badge', 'InfoBanner', 'Checkbox']);
  const s1Block = blockedBy(['Button', 'ChecklistItem', 'Topbar', 'ReasonQuote', 'MenuItem', 'Menu', 'Sidebar', 'PhoneTopbar', 'Badge', 'InfoBanner']);
  if (authBlock.length) log('ℹ skipped Auth templates: they need the plugin\'s ' + authBlock.join(', '));
  else {
    const present = T['tpl-auth'] ? T['tpl-auth'].host.children.map(function (c) { return c.name; }) : [];
    const missing = authFrameNames().filter(function (n) { return present.indexOf(n) < 0; });
    const hostT = missing.length ? await ensureAuthHost(T) : T['tpl-auth'];
    if (missing.length && !hostT) log('ℹ skipped Auth templates: this file has no free page for Templates · Auth');
    else if (missing.length) {
      if (!present.length) added.push((hostT.host.type === 'SECTION' ? 'section ' : 'page ') + TITLE['tpl-auth']);
      await onPage(hostT, 'Auth templates', function (host) {
        const made = buildAuthFrames(missing);
        const rows = ['Seller', 'Admin', 'Phone'].map(function (r) { return made.filter(function (m) { return m.row === r; }).map(function (m) { return m.frame; }); });
        if (!host.children.length) rowsPage(host, 'Templates · Auth', AUTH_SUBTITLE, rows); else placeRows(host, rows, bottomEdge(host) + 240);
        fitSection(host);
      });
      added.push('templates Auth (' + missing.length + ' frames)');
    }
  }
  if (s1Block.length) log('ℹ skipped Seller · Your seller account templates: they need the plugin\'s ' + s1Block.join(', '));
  else {
    const present = T['tpl-seller'].host.children.map(function (c) { return c.name; });
    const missing = s1Screens().filter(function (d) { return present.indexOf(d[0]) < 0; });
    if (missing.length) {
      await onPage(T['tpl-seller'], 'Seller account templates', function (host) { placeRows(host, [missing.map(function (d) { return d[1](); })], bottomEdge(host) + 240); fitSection(host); });
      missing.forEach(function (d) { added.push('template ' + d[0]); });
    }
  }
  const darkHost = T['tpl-dark'].host; const darkPresent = darkHost.children.map(function (c) { return c.name; });
  const darkSources = DARK_170.filter(function (n) { return darkPresent.indexOf(n + ' · Dark') < 0; }).map(function (n) {
    const where = [T['tpl-auth'], T['tpl-seller']].filter(Boolean);
    for (let i = 0; i < where.length; i++) { const f = where[i].host.children.filter(function (c) { return c.type === 'FRAME' && c.name === n && c.getPluginData(PLUGIN_TAG) === '1'; })[0]; if (f) return f; }
    return null;
  }).filter(Boolean);
  if (darkSources.length) {
    await onPage(T['tpl-dark'], 'Dark preview', function (host) {
      let x = rightEdge(host) + 160; const ref = host.children.filter(function (n) { return n.type === 'FRAME' && n.height > 400; })[0]; const y = ref ? ref.y : 240;
      darkSources.forEach(function (src) { const c = src.clone(); c.name = src.name + ' · Dark'; host.appendChild(c); c.x = x; c.y = y; x += c.width + 160; applyTheme(c, 'dark'); added.push('dark preview ' + c.name); });
      fitSection(host);
    });
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
  const newSizes = ['size/bottom-bar', 'size/topbar-phone', 'size/auth-card'].map(function (n) { return SPEC.dimension.filter(function (d) { return d.name === n; })[0]; })
    .filter(function (d) { return d && sizeTable && !sizeTable.findOne(function (n) { return n.type === 'TEXT' && n.characters === d.name; }); });
  if (newSizes.length) {
    await onPage(T.spacing, 'Spacing page', function () { newSizes.forEach(function (d) { appendTableRow(sizeTable, [d.name, d.desktop + ' px', d.touch + ' px', SIZE_USE[d.name]], [260, 160, 160, 600]); }); fitSection(T.spacing.host); });
    newSizes.forEach(function (d) { added.push('size table row ' + d.name); });
  }
  const logTable = findTable(T.changelog.host, 'Version|Date|Changes');
  const newReleases = RELEASES.filter(function (r) { return logTable && !logTable.findOne(function (n) { return n.type === 'TEXT' && n.characters === r.version; }); });
  if (newReleases.length) {
    await onPage(T.changelog, 'Changelog', function () { newReleases.forEach(function (r) { appendTableRow(logTable, [r.version, r.date, r.changes], CHANGELOG_WIDTHS); }); fitSection(T.changelog.host); });
    newReleases.forEach(function (r) { added.push('changelog row ' + r.version); });
  }
  const meta = { Version: SPEC.version, Updated: RELEASE.date };
  const coverEdits = [];
  const coverOf = function (k) { const f = T.cover.host.findOne(function (n) { return n.type === 'FRAME' && n.name === k && n.children.length === 2; }); const t = f && f.children[1]; return t && t.type === 'TEXT' ? t : null; };
  if (coverOf('Version') && semverLess(coverOf('Version').characters, SPEC.version)) Object.keys(meta).forEach(function (k) { const t = coverOf(k); if (t) coverEdits.push([t, meta[k]]); });
  if (coverEdits.length) { await onPage(T.cover, 'Cover', function () { coverEdits.forEach(function (e) { e[0].characters = e[1]; }); }); added.push('cover version'); }

  await flush();
  if (semverLess(figma.root.getPluginData('version') || '1.0.0', SPEC.version)) { figma.root.setPluginData('version', SPEC.version); added.push('file version ' + SPEC.version); }
  if (!added.length) log('✓ Library is already at ' + SPEC.version + '. Nothing to add.');
  else {
    log('✓ Added to the library (' + SPEC.version + '):'); added.forEach(function (a) { log('    + ' + a); });
    const except = [topbarFix.length ? 'the old phone topbar frame swapped for PhoneTopbar in ' + topbarFix.length + ' phone templates' : '', scrimFix.length ? 'the drawer scrim re-bound to bg/scrim in ' + scrimFix.length + ' templates' : '', inputRenamed ? 'the ' + inputRenamed + ' existing Input variants named Type=Text' : ''].filter(Boolean);
    log('Nothing was deleted or rebuilt' + (except.length ? ', except ' + except.join(' and ') : '') + '. The existing Sidebar keeps its drawn brand mark (a new build uses BrandMark). Next: run Audit file, then Export tokens (the diff shows only the tokens added since this file\'s version, and the version line).');
  }
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
  // Primitives by "family/step" (the variable name without "color/"), so Update library can add missing ones (1.7.0).
  S.prim = {}; S.primColl = byName.Primitives || null;
  const pv = await vars(byName.Primitives); Object.keys(pv).forEach(function (k) { S.prim[k.replace(/^color\//, '')] = pv[k]; });
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
// Colours with alpha below 1 (bg/scrim) export as #RRGGBBAA; opaque colours keep #RRGGBB.
function toHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a !== undefined && c.a < 1 ? hex2(c.a) : ''); }
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
  // Sorted by family, then by numeric step: a file updated from an older release has the newer primitives at the end
  // of the collection, and the export must match a fresh build (the spec lists primitives in this order).
  const primStep = function (v) { const p = v.name.split('/'); return [p[1], +p[2]]; };
  const primVars = (await list(byName.Primitives)).sort(function (a, b) { const x = primStep(a), y = primStep(b); return x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : x[1] - y[1]); });
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
