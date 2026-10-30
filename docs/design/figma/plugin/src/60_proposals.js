// ---------------------------------------------------------------- proposals (update procedure step 3: Sandbox first)
// "Build proposal" draws review frames for the owner into the Sandbox section, from the library already in the file. It never
// touches a library page, a component or a template: it only replaces its own earlier frames (plugin data 'proposal') in
// Sandbox, so it can be run again after each round of feedback. A proposal becomes library frames in a numbered release only
// after the owner approves it. Frames are named "Proposal · <area> · <screen> · <state>".

// ---- Admin · Catalog · Products (owner's brief, 30 Oct 2026): the list of every product on the platform with add, import,
// bulk actions, search, filter icon with saved filters, sort icon, column picker, page size, pagination and the total.
// Round 2 (owner, 30 Oct 19:47Z): view tabs read Active, All, Inactive; bulk actions move beside the header buttons (no bulk
// bar; round 3, 19:59Z: a Bulk action button, disabled until rows are selected); a full admin saves a filter for themselves or for everyone, a products-only role only for themselves.
const PP = 'Proposal · Admin · Catalog · Products';
const PP_MARKET = 'Australia';
// [title, code, category, thumb, status, sellers, variants, last changed, type]
const PP_ROWS = [
  ['Lamb cutlets 500 g', 'AU-000184', 'Meat', 'Meat', 'Active', '6', '2', '29 Oct 2026', 'Fresh meat'],
  ['Chicken thigh fillets 1 kg', 'AU-000211', 'Poultry', 'Poultry', 'Active', '9', '3', '29 Oct 2026', 'Fresh meat'],
  ['Turkish bread loaf', 'AU-000342', 'Bakery', 'Bakery', 'Active', '4', '1', '28 Oct 2026', 'Bakery'],
  ['Basmati rice 5 kg', 'AU-000415', 'Pantry', 'Pantry', 'Active', '12', '2', '27 Oct 2026', 'Packaged food'],
  ['Beef mince 1 kg', 'AU-000187', 'Meat', 'Meat', 'Active', '8', '2', '27 Oct 2026', 'Fresh meat'],
  ['Medjool dates 1 kg', 'AU-000466', 'Pantry', 'Pantry', 'Active', '5', '1', '26 Oct 2026', 'Packaged food'],
  ['Whole chicken size 16', 'AU-000219', 'Poultry', 'Poultry', 'Active', '7', '1', '25 Oct 2026', 'Fresh meat'],
  ['Za’atar spice mix 200 g', 'AU-000488', 'Pantry', 'Other', 'Active', '3', '1', '24 Oct 2026', 'Packaged food'],
];
const PP_INACTIVE = { 2: true }; // the All products view shows one inactive row
const PP_SEARCH = 'Search by name, description or category';
const PP_VIEWS = [['Active', '1,148'], ['All', '1,284'], ['Inactive', '136'], ['Meat, active', '212']];
// Default columns (owner): image, title, status, main category. Optional columns from the column picker, saved per admin.
const PP_OPTIONAL = [['Product code', true], ['Sellers selling it', true], ['Variants', false], ['Last changed', true], ['Product type', false], ['Scope (platform or seller)', false], ['Created', false], ['Brand', false]];

function ppPopover(name, w, kids) {
  return frame({ name: name, dir: 'V', w: w, pad: 'space/4', gap: 'space/3', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', effect: 'Elevation/Floating' }, kids);
}
function ppIconButton(ic, name, state) { return inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: state || 'Default', Icon: { icon: ic } }, { name: name }); }
function ppLink(label, ic, name) { const p = { Variant: 'Link', Size: 'Sm', State: 'Default', Label: label }; if (ic) { p['Leading icon'] = true; p.Icon = { icon: ic }; } return inst('Button', p, { name: name || 'link' }); }
// The toolbar: search box, then the filter, sort and column icons; the filter icon carries the number of conditions applied.
function ppToolbar(o) {
  o = o || {};
  const search = inst('Input', { Type: 'Text', State: o.query ? 'Filled' : 'Default', Value: o.query || PP_SEARCH, 'Leading icon': true }, { name: 'search', w: 440 });
  const filter = frame({ name: 'filter', dir: 'H', gap: 'space/1', align: 'center' }, [ppIconButton('sliders', 'filter-button', o.open === 'filter' ? 'Focus' : 'Default')].concat(o.filters ? [inst('CountBadge', { Tone: 'Info', Count: String(o.filters) }, { name: 'filter-count' })] : []));
  const icons = frame({ name: 'icons', dir: 'H', gap: 'space/2', align: 'center' }, [filter, ppIconButton('arrow-down', 'sort-button', o.open === 'sort' ? 'Focus' : 'Default'), ppIconButton('columns', 'columns-button', o.open === 'columns' ? 'Focus' : 'Default')]);
  return frame({ name: 'toolbar', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [search, icons, frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), text(o.sortLabel || 'Sorted by Last changed, newest first', 'Body/Small', 'text/muted', { name: 'sort-label' })]);
}
// Applied conditions as chips, with Clear all and Save filter; shown only while a filter or search is applied.
function ppChips(list, resultText) {
  const kids = list.map(function (c) { return inst('FilterChip', { Type: 'Applied', Label: c }, { name: 'chip' }); });
  kids.push(ppLink('Clear all', null, 'clear-all'), ppLink('Save filter…', 'star', 'save-filter'), frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), text(resultText, 'Body/Small Strong', 'text/secondary', { name: 'result-count' }));
  return frame({ name: 'applied', dir: 'H', gap: 'space/2', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, kids);
}
function ppViews(active, extra) {
  const tabs = PP_VIEWS.map(function (v) { return [v[0], v[1], v[0] === active]; });
  if (extra) tabs.push([extra[0], extra[1], extra[0] === active]);
  return frame({ name: 'views', dir: 'H', gap: 'space/3', align: 'end', sizeH: 'FILL' }, [tabsBar(tabs), ppLink('Manage filters', 'sliders', 'manage-filters')]);
}
// cols: the optional columns shown, in order (Product code, Sellers selling it, Last changed in the "columns added" frame).
function ppTable(o) {
  o = o || {};
  const extra = o.extra || [];
  const sel = (o.selected || []).length;
  const width = { 'Product code': 130, 'Sellers selling it': 150, 'Last changed': 140 };
  const head = headerRow([['Product', 'fill'], ['Main category', 170], ['Status', 130]].concat(extra.map(function (c) { return [c, width[c] || 140, c === o.sortedBy]; }), [['', 56]]));
  head.insertChild(0, selectHeader(sel === 0 ? 'Unchecked' : (sel === PP_ROWS.length ? 'Checked' : 'Indeterminate')));
  const kids = [head];
  const rows = o.rows || PP_ROWS;
  rows.forEach(function (r, i) {
    const on = (o.selected || []).indexOf(i) >= 0; const inactive = o.showInactive && PP_INACTIVE[i];
    const cells = [[inst('Checkbox', { Value: on ? 'Checked' : 'Unchecked', State: 'Default' }, { name: 'select' }), 56, { justify: 'center' }],
      [[inst('ProductThumb', { Category: r[3], Size: 'Sm' }, { name: 'image' }), frame({ name: 'product', dir: 'V', sizeH: 'FILL' }, [text(r[0], 'Body/Strong', 'text/primary', { name: 'title', sizeH: 'FILL', truncate: true }), text(r[1], 'Caption/Default', 'text/muted', { name: 'code', sizeH: 'FILL', truncate: true })])], 'fill'],
      [text(r[2], 'Body/Default'), 170],
      [inactive ? bdg('Neutral', 'Dot', 'Inactive') : bdg('Success', 'Dot', 'Active'), 130]];
    extra.forEach(function (c) { cells.push([text({ 'Product code': r[1], 'Sellers selling it': r[5], 'Last changed': r[7] }[c] || '', 'Body/Default'), width[c] || 140]); });
    cells.push([rowAction(), 56, { justify: 'center' }]);
    kids.push(row(cells, on, false, 64));
  });
  const pag = inst('Pagination', { Range: o.range || '1–25 of 1,148 products' }, { name: 'Pagination', sizeH: 'FILL' });
  kids.push(pag);
  return card('Product list', kids);
}
// Bulk action (owner, round 3): a button with the header buttons, disabled until a row is selected; the count of selected rows
// shows only in the menu it opens.
function ppActions(o) {
  const b = btn('Bulk action', 'Secondary', 'Md', { State: o.open === 'actions' ? 'Focus' : (o.selected ? 'Default' : 'Disabled'), 'Trailing icon': true });
  b.name = 'actions-button';
  return b;
}
function ppHeader(o) {
  o = o || {};
  return pageTitle('Products', (o.total || '1,284') + ' products in the ' + PP_MARKET + ' market', [ppActions(o), btn('Import', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'file' } }), primaryHeaderButton('Add product')]);
}
function ppScreen(state, kids, overlay) {
  const scr = screen(PP + ' · ' + state, 'Admin', 'nav-catalogue', 'Catalog / Products', kids, { minH: PANEL_MIN_H, gap: 'space/4' });
  (overlay ? [].concat(overlay) : []).forEach(function (o) { add(scr, o); });
  scr.setPluginData('proposal', 'admin-products');
  return scr;
}
// The node's position inside the screen (offsetIn), to open a popover under a toolbar icon.
function ppUnder(scr, name, pop, alignRight) {
  const n = scr.findOne(function (x) { return x.name === name; });
  const at = offsetIn(scr, n);
  const x = alignRight ? at[0] + n.width - pop.width : at[0];
  setMeta(pop, { abs: [Math.round(x), Math.round(at[1] + n.height + 6)] });
  add(scr, pop);
}

// 1 · Default: the "Active products" filter, 25 rows a page, the total in the pagination and the subtitle.
function ppDefault() { return ppScreen('Default', [ppHeader(), ppViews('Active'), ppToolbar(), ppTable()]); }
// 2 · Rows selected, Bulk action open: the menu under the Bulk action button acts on the selected rows (owner, round 2: no bulk bar).
function ppActionItem(state, label, ic, desc) {
  return inst('MenuItem', Object.assign({ State: state, Label: label, 'Leading icon': true, Icon: { icon: ic }, 'Show description': !!desc }, desc ? { Description: desc } : {}), { name: 'action · ' + label, sizeH: 'FILL' });
}
function ppActionsMenu(n) {
  return ppPopover('Bulk action menu (open)', 300, [
    text(n + ' products selected', 'Caption/Strong', 'text/muted', { name: 'title' }),
    frame({ name: 'items', dir: 'V', sizeH: 'FILL' }, [ppActionItem('Default', 'Activate', 'check'), ppActionItem('Default', 'Deactivate', 'ban'), ppActionItem('Destructive', 'Delete…', 'trash')]),
    frame({ name: 'scope', dir: 'V', gap: 'space/1', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [ppLink('Select all 1,148 products in this filter', null, 'select-all-matching'), ppLink('Clear selection', null, 'clear-selection')])]);
}
function ppSelected() {
  const scr = ppScreen('Rows selected, Bulk action open', [ppHeader({ selected: 3, open: 'actions' }), ppViews('Active'), ppToolbar(), ppTable({ selected: [0, 1, 4] })]);
  ppUnder(scr, 'actions-button', ppActionsMenu(3), true);
  return scr;
}
// 3 · Search and filter together: the query and two conditions; the count of matches.
function ppSearchFilter() {
  return ppScreen('Search with filter', [ppHeader(), ppViews('Active'), ppToolbar({ query: 'lamb', filters: 2 }), ppChips(['Main category is Meat', 'Sellers selling it is at least 2'], '14 products match'), ppTable({ rows: [PP_ROWS[0]], range: '1–14 of 14 products' })]);
}
// 4 · Filter panel open: one row per condition (field, operator, value), Add condition, Save as filter, Apply.
function ppCondition(field, op, value) {
  const sel = function (v, w) { return inst('Select', { State: 'Filled', Value: v }, { name: 'select', w: w }); };
  return frame({ name: 'condition', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [sel(field, 170), sel(op, 120), sel(value, 150), inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'remove' })]);
}
function ppFilterPanel() {
  return ppPopover('Filter panel (open)', 520, [
    frame({ name: 'head', dir: 'H', align: 'center', sizeH: 'FILL' }, [text('Filter products', 'Heading/H2', 'text/primary', { sizeH: 'FILL' }), text('Match all conditions', 'Body/Small', 'text/muted')]),
    ppCondition('Main category', 'is', 'Meat'), ppCondition('Status', 'is', 'Active'), ppCondition('Sellers selling it', 'at least', '2'),
    ppLink('Add condition', 'plus', 'add-condition'),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', align: 'center', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [ppLink('Save as filter…', 'star', 'save-as'), frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Cancel', 'Secondary', 'Md'), btn('Apply', 'Primary', 'Md')]),
  ]);
}
function ppFilterOpen() {
  const scr = ppScreen('Filter panel open', [ppHeader(), ppViews('Active'), ppToolbar({ open: 'filter', filters: 2 }), ppChips(['Main category is Meat', 'Status is Active'], '212 products match'), ppTable({ rows: [PP_ROWS[0], PP_ROWS[4]], range: '1–25 of 212 products' })]);
  ppUnder(scr, 'filter-button', ppFilterPanel());
  return scr;
}
// 5 · Sort menu open: one field (radio) and the direction.
function ppSortMenu() {
  const item = function (label, on) { return inst('MenuItem', { State: on ? 'Selected' : 'Default', Label: label, 'Leading icon': false, 'Show description': false }, { name: 'sort-' + label, sizeH: 'FILL' }); };
  const seg = inst('SegmentedControl', { 'Segment 1': 'Newest first', 'Segment 2': 'Oldest first' }, { name: 'direction' });
  const third = seg.findOne(function (n) { return n.name === 'segment-3'; }); if (third) third.visible = false;
  return ppPopover('Sort menu (open)', 280, [text('Sort by', 'Caption/Strong', 'text/muted', { name: 'title' }),
    frame({ name: 'fields', dir: 'V', sizeH: 'FILL' }, ['Title', 'Main category', 'Status', 'Last changed', 'Created', 'Sellers selling it', 'Product code'].map(function (l) { return item(l, l === 'Last changed'); })),
    frame({ name: 'direction-row', dir: 'V', gap: 'space/2', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text('Order', 'Caption/Strong', 'text/muted'), seg])]);
}
function ppSortOpen() {
  const scr = ppScreen('Sort menu open', [ppHeader(), ppViews('Active'), ppToolbar({ open: 'sort' }), ppTable({ extra: ['Last changed'], sortedBy: 'Last changed' })]);
  ppUnder(scr, 'sort-button', ppSortMenu());
  return scr;
}
// 6 · Column picker open: the four fixed columns, then the optional ones with a check and a drag handle; Save for me.
function ppColumnRow(label, on, fixed) {
  return frame({ name: 'column · ' + label, dir: 'H', gap: 'space/2-5', align: 'center', py: 'space/1-5', sizeH: 'FILL' }, [
    icon('more-vertical', fixed ? 'border/default' : 'icon/muted', 16), inst('Checkbox', { Value: on ? 'Checked' : 'Unchecked', State: fixed ? 'Disabled' : 'Default' }, { name: 'show' }),
    text(label, 'Body/Default', fixed ? 'text/muted' : 'text/primary', { name: 'label', sizeH: 'FILL' }), fixed ? text('Always shown', 'Caption/Default', 'text/muted') : null]);
}
function ppColumnsPanel() {
  return ppPopover('Column picker (open)', 340, [text('Columns', 'Heading/H2'), text('Drag to change the order. Saved for you only.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    frame({ name: 'fixed', dir: 'V', sizeH: 'FILL' }, ['Image', 'Title', 'Status', 'Main category'].map(function (l) { return ppColumnRow(l, true, true); })),
    frame({ name: 'optional', dir: 'V', pad: ['space/2', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, PP_OPTIONAL.map(function (c) { return ppColumnRow(c[0], c[1]); })),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', align: 'center', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [ppLink('Reset to default', 'undo', 'reset'), frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Save', 'Primary', 'Md')])]);
}
function ppColumnsOpen() {
  const scr = ppScreen('Column picker open', [ppHeader(), ppViews('Active'), ppToolbar({ open: 'columns' }), ppTable({ extra: ['Product code', 'Sellers selling it', 'Last changed'] })]);
  ppUnder(scr, 'columns-button', ppColumnsPanel());
  return scr;
}
// 7 · All products with the extra columns saved: an inactive row shows its badge.
function ppAllColumns() { return ppScreen('All products with added columns', [ppHeader(), ppViews('All'), ppToolbar(), ppTable({ extra: ['Product code', 'Sellers selling it', 'Last changed'], showInactive: true, range: '1–25 of 1,284 products' })]); }

// Save filter: a full admin chooses Only me or Everyone; a role that can only manage products saves for themselves (owner, round 2).
function ppSaveFilter(canShare) {
  const name = inst('Input', { Type: 'Text', State: 'Filled', Value: 'Meat, at least 2 sellers', 'Leading icon': false }, { name: 'name', sizeH: 'FILL' });
  const who = canShare ? (function () { const seg = inst('SegmentedControl', { 'Segment 1': 'Only me', 'Segment 2': 'Everyone' }, { name: 'shared-with' }); const t = seg.findOne(function (n) { return n.name === 'segment-3'; }); if (t) t.visible = false; return seg; })()
    : text('Saved for you only. Your role can’t share filters.', 'Body/Small', 'text/muted', { name: 'shared-with', sizeH: 'FILL' });
  return frame({ name: 'Save filter · ' + (canShare ? 'Admin' : 'Products-only role'), dir: 'V', w: 440, pad: 'space/6', gap: 'space/4', fill: 'bg/surface', radius: 'radius/card', effect: 'Elevation/Floating' }, [
    text('Save this filter', 'Heading/H2', 'text/primary', { sizeH: 'FILL' }),
    text('Main category is Meat · Sellers selling it is at least 2', 'Body/Small', 'text/secondary', { sizeH: 'FILL' }),
    frame({ name: 'field-name', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [text('Name', 'Body/Strong', 'text/primary'), name]),
    frame({ name: 'field-share', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [text('Who can use it', 'Body/Strong', 'text/primary'), who].concat(canShare ? [text('Everyone: every admin who can see products gets it as a tab.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })] : [])),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, [btn('Cancel', 'Secondary', 'Md'), btn('Save filter', 'Primary', 'Md')])]);
}
// 8 · Dialogs: save a filter (two roles), import products, deactivate and delete selected.
function ppDialogs() {
  const save = ppSaveFilter(true);
  const saveOwn = ppSaveFilter(false);
  const imp = dlg({ name: 'Import products', title: 'Import products', text: 'Upload a CSV or XLSX file with one product per row. Download the template to see the columns. We check every row first and show you what will be added and what has errors before anything is saved.', primary: 'Choose file', secondary: 'Download template' });
  const deact = dlg({ name: 'Deactivate products', title: 'Deactivate 3 products?', text: 'Customers stop seeing them and sellers can’t add new offers to them. Existing orders aren’t affected. You can activate them again at any time.', primary: 'Deactivate', secondary: 'Cancel' });
  const del = dlg({ name: 'Delete products', tone: 'Destructive', title: 'Delete 3 products?', text: 'They are removed from the catalog for customers and sellers, and the 18 offers on them end. Order history keeps them. You can’t undo this.', primary: 'Delete products', secondary: 'Cancel', focusCancel: true });
  const scr = dialogScene(PP + ' · Dialogs', [save, saveOwn, imp, deact, del]);
  scr.setPluginData('proposal', 'admin-products');
  return scr;
}
// 9 · Loading, no products, no match.
function ppStates() {
  const loading = card('Loading', [headerRow([['Product', 'fill'], ['Main category', 170], ['Status', 130]])].concat([0, 1, 2, 3].map(function () { return frame({ name: 'Row', dir: 'H', sizeH: 'FILL' }, [inst('TableCell', { Type: 'Text', State: 'Loading' }, { sizeH: 'FILL' }), inst('TableCell', { Type: 'Text', State: 'Loading' }, { w: 170 }), inst('TableCell', { Type: 'Text', State: 'Loading' }, { w: 130 })]); })));
  const none = inst('EmptyState', { Size: 'Card', Title: 'No products yet', Body: 'Add a product or import a list to start the catalog.', Icon: { icon: 'package' } }, { name: 'empty', sizeH: 'FILL' });
  setNested(none, 'action', prop('Button', 'Label', 'Add product'));
  const nomatch = inst('EmptyState', { Size: 'Card', Title: 'No products match', Body: 'Try another search or remove a filter.', Icon: { icon: 'search' } }, { name: 'no-match', sizeH: 'FILL' });
  setNested(nomatch, 'action', prop('Button', 'Label', 'Clear all'));
  const scr = frame({ name: PP + ' · States', dir: 'V', w: 900, pad: 40, gap: 'space/6', fill: 'bg/page' }, [text('Products: loading and empty states', 'Heading/H1'), para('The page header, filter tabs and toolbar stay visible in every state. Loading shows skeleton rows; a list that cannot load is the Critical banner with "Try again".', 800),
    text('Loading', 'Caption/Strong', 'text/muted'), loading, text('No products in the catalog', 'Caption/Strong', 'text/muted'), none, text('Search or filter with no match', 'Caption/Strong', 'text/muted'), nomatch]);
  tag(scr); scr.setPluginData('proposal', 'admin-products');
  return scr;
}
const PROPOSALS = { 'admin-products': { title: PP, rows: function () { return [[ppDefault(), ppSelected(), ppSearchFilter()], [ppFilterOpen(), ppSortOpen(), ppColumnsOpen()], [ppAllColumns(), ppDialogs(), ppStates()]]; } } };

async function buildProposal(key) {
  STEP = 0; STEPS = 3; S.report = [];
  const def = PROPOSALS[key];
  if (!def) { post({ type: 'error', message: 'Unknown proposal ' + key + '.' }); return; }
  await figma.loadAllPagesAsync();
  const state = await fileIsEmpty();
  if (!state.hasLibrary) { post({ type: 'error', message: 'This file has no MondaPac library. Open the MondaPac Design System file.' }); return; }
  await loadState();
  await hydrateLibrary();
  await loadFonts();
  const T = findHosts();
  if (!T.sandbox) { post({ type: 'error', message: 'This file has no Sandbox page or section.' }); return; }
  progress('Library read');
  let removed = 0, made = 0;
  await onPage(T.sandbox, def.title, function (host) {
    host.children.filter(function (n) { return n.getPluginData && n.getPluginData('proposal') === key; }).forEach(function (n) { n.remove(); removed++; });
    // a failed drawing leaves nothing behind: remove the layers it put on the page
    const before = figma.currentPage.children.slice();
    let rows;
    try { rows = def.rows(); } catch (e) { figma.currentPage.children.filter(function (n) { return before.indexOf(n) < 0; }).forEach(function (n) { n.remove(); }); throw e; }
    rows.forEach(function (r) { made += r.length; });
    placeRows(host, rows, bottomEdge(host) + 240);
    fitSection(host);
  });
  await flush();
  const moved = restackSections();
  progress('Frames drawn');
  post({ type: 'done', added: [def.title + ': ' + made + ' frames in Sandbox' + (removed ? ' (replaced ' + removed + ' earlier frames)' : '')].concat(moved), report: S.report });
}
