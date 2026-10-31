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
    frame({ name: 'items', dir: 'V', sizeH: 'FILL' }, [ppActionItem('Default', 'Activate', 'check'), ppActionItem('Default', 'Deactivate', 'ban'), ppActionItem('Default', 'Export', 'download', 'CSV or XLSX, with the columns shown'), ppActionItem('Destructive', 'Delete…', 'trash')]),
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
// 8 · Dialogs: save a filter (two roles), deactivate and delete selected (Import opens its own page, below).
function ppDialogs() {
  const save = ppSaveFilter(true);
  const saveOwn = ppSaveFilter(false);
  const deact = dlg({ name: 'Deactivate products', title: 'Deactivate 3 products?', text: 'Customers stop seeing them and sellers can’t add new offers to them. Existing orders aren’t affected. You can activate them again at any time.', primary: 'Deactivate', secondary: 'Cancel' });
  const del = dlg({ name: 'Delete products', tone: 'Destructive', title: 'Delete 3 products?', text: 'They are removed from the catalog for customers and sellers, and the 18 offers on them end. Order history keeps them. You can’t undo this.', primary: 'Delete products', secondary: 'Cancel', focusCancel: true });
  const scr = dialogScene(PP + ' · Dialogs', [save, saveOwn, deact, del]);
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

// ---- Admin · Catalog · Products · Import, owner 30 Oct 20:20Z: a page of its own with three steps. Upload a CSV or XLSX file
// (templates to download), check the file (counts, errors per row, nothing saved yet), then import after a confirmation, with a
// progress bar and a final report; Done returns to the product list. Additions to the owner's brief: a column guide, the choice
// of the status new products start in (Inactive by default), skipping rows with errors only by an explicit tick, a downloadable
// error report, an import that keeps running if the page is left, and the file problems that stop a check (state board).
const PI = PP + ' · Import';
const PI_FILE = 'products-oct-2026.xlsx';
const PI_COLUMNS = [['Title', true, 'Up to 120 characters'], ['Main category', true, 'A category name as it appears in Catalog > Categories'], ['Product type', true, 'Fresh meat, Bakery, Packaged food…'], ['Description', false, 'Plain text'], ['Brand', false, 'Leave empty for unbranded products'], ['Barcode (GTIN)', false, '8, 12, 13 or 14 digits'], ['Unit size', false, 'For example 500 g or 1 kg'], ['Image URL', false, 'https link to a JPG or PNG']];
const PI_ERRORS = [['12', 'Main category', 'Fresh Meats', 'No category with this name'], ['47', 'Title', '(empty)', 'Title is required'], ['88', 'Barcode (GTIN)', '93123', 'Not a valid barcode length'], ['104', 'Product type', 'Meat', 'No product type with this name'], ['131', 'Image URL', 'http://img…/a.png', 'Use an https link'], ['206', 'Title', 'Lamb cutlets 500 g', 'Same title and brand as row 31']];
function piSteps(active) {
  // Full width (owner, 30 Oct 20:55Z): each step takes an equal share; the line fills the rest of its share.
  const steps = ['Upload file', 'Check file', 'Import'];
  return card('steps', [frame({ name: 'steps', dir: 'H', gap: 'space/3', align: 'center', pad: 'space/4', sizeH: 'FILL' }, steps.map(function (label, i) {
    const n = i + 1; const done = n < active; const on = n === active;
    const disc = frame({ name: 'disc', dir: 'H', w: 24, h: 24, align: 'center', justify: 'center', radius: 'radius/pill', fill: on || done ? 'action/primary' : 'bg/surface', stroke: on || done ? null : 'border/default' },
      [done ? icon('check', 'text/on-accent', 14) : text(String(n), 'Caption/Strong', on ? 'text/on-accent' : 'text/muted')]);
    return frame({ name: 'step ' + n, dir: 'H', gap: 'space/2', align: 'center', sizeH: n < 3 ? 'FILL' : undefined }, [disc, text(label, on ? 'Body/Strong' : 'Body/Default', on || done ? 'text/primary' : 'text/muted'), n < 3 ? rect({ name: 'line', w: 10, h: 2, fill: done ? 'action/primary' : 'border/default', sizeH: 'FILL' }) : null]);
  }))]);
}
function piScreen(state, step, kids, right) {
  const head = pageTitle('Import products', 'Add many products to the ' + PP_MARKET + ' catalog from one file.', right || []);
  const back = ppLink('Products', 'chevron-left', 'back');
  const scr = screen(PI + ' · ' + state, 'Admin', 'nav-catalogue', 'Catalog / Products / Import', [back, head, piSteps(step)].concat(kids), { minH: PANEL_MIN_H, gap: 'space/4' });
  scr.setPluginData('proposal', 'admin-products');
  return scr;
}
function piSection(name, title, sub, kids, w) {
  return card(name, [frame({ name: 'body', dir: 'V', gap: 'space/4', pad: 'space/5', sizeH: 'FILL' }, [frame({ name: 'head', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(title, 'Heading/H2', 'text/primary', { sizeH: 'FILL' }), sub ? text(sub, 'Body/Small', 'text/muted', { sizeH: 'FILL' }) : null])].concat(kids))], { sizeH: w ? undefined : 'FILL', w: w });
}
function piFileRow(meta, action) {
  return frame({ name: 'file', dir: 'H', gap: 'space/3', align: 'center', pad: 'space/3', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [icon('file-text', 'icon/default', 20), frame({ name: 'file-text', dir: 'V', sizeH: 'FILL' }, [text(PI_FILE, 'Body/Strong'), text(meta, 'Caption/Default', 'text/muted')]), action || null]);
}
function piMeter(pct, w) { const m = inst('Meter', { Tone: 'Accent', Value: String(pct) }, { name: 'progress' }); m.resize(w || 640, 8); return m; }
function piTiles(list) { return frame({ name: 'summary', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, list.map(function (t) { return card(t[0], [frame({ name: 'tile', dir: 'V', gap: 'space/1', pad: 'space/4', sizeH: 'FILL' }, [text(t[0], 'Body/Small Strong', 'text/secondary'), text(t[1], 'Heading/H1', t[2] || 'text/primary'), t[3] ? text(t[3], 'Caption/Default', 'text/muted') : null])]); })); }
function piBanner(tone, title, body) { return inst('InfoBanner', { Tone: tone, Title: title, Body: body, 'Show action': false }, { name: 'banner', sizeH: 'FILL' }); }
function piFooter(kids) { return frame({ name: 'footer', dir: 'H', gap: 'space/2', align: 'center', pad: ['space/4', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, kids); }
function piStartAs() {
  const seg = inst('SegmentedControl', { 'Segment 1': 'Inactive', 'Segment 2': 'Active' }, { name: 'start-as' }); const t = seg.findOne(function (n) { return n.name === 'segment-3'; }); if (t) t.visible = false;
  return frame({ name: 'start-as-row', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [frame({ name: 'start-as-text', dir: 'V', sizeH: 'FILL' }, [text('New products start as', 'Body/Strong'), text('Inactive is safer: check them in the list, then activate them in bulk.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]), seg]);
}
// I1 · Upload: a drop area and the template with its column guide.
function piUpload() {
  const drop = frame({ name: 'drop-area', dir: 'V', gap: 'space/3', align: 'center', justify: 'center', h: 260, sizeH: 'FILL', fill: 'bg/subtle', stroke: 'border/input', dash: [6, 4], radius: 'radius/card' }, [
    icon('file', 'icon/muted', 32), text('Drag a CSV or XLSX file here', 'Body/Strong'), text('or', 'Body/Small', 'text/muted'), btn('Choose file', 'Secondary', 'Md'), text('One product per row · up to 5,000 rows and 10 MB', 'Caption/Default', 'text/muted')]);
  const upload = piSection('Upload', 'Upload a file', 'Nothing is saved until you finish the check and confirm the import.', [drop]);
  const guide = frame({ name: 'columns', dir: 'V', sizeH: 'FILL' }, PI_COLUMNS.map(function (c) {
    return frame({ name: 'column · ' + c[0], dir: 'H', gap: 'space/2', align: 'center', py: 'space/1-5', stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [text(c[0], 'Body/Strong', 'text/primary', { w: 130 }), c[1] ? bdg('Neutral', 'None', 'Required') : null, frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), text(c[2], 'Caption/Default', 'text/muted')]);
  }));
  const tpl = piSection('Template', 'Template', 'Fill in the template by hand or export from your system with the same columns.', [
    frame({ name: 'downloads', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [btn('CSV template', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), btn('XLSX template', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } })]),
    guide, text('Certification tags are not imported: they belong to each seller’s offer, not to the product.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })], 520);
  return piScreen('1 Upload', 1, [frame({ name: 'cols', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [upload, tpl]), piFooter([btn('Cancel', 'Secondary', 'Md'), frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Check file', 'Primary', 'Md', { State: 'Disabled' })])]);
}
// I2 · Checking the file: the progress of the check; it can be stopped.
function piChecking() {
  return piScreen('2 Checking', 2, [piSection('Check', 'Checking your file', 'We read every row and compare it with the catalog. Nothing is saved.', [piFileRow('1,240 rows · 2.4 MB', ppLink('Choose another file', null, 'stop')), piMeter(50, 1100), text('Checking row 620 of 1,240…', 'Body/Small', 'text/muted')]), piFooter([btn('Cancel', 'Secondary', 'Md')])]);
}
function piErrorTable() {
  const head = headerRow([['Row', 80], ['Column', 170], ['Value in the file', 'fill'], ['Problem', 320]]);
  const rows = PI_ERRORS.map(function (e) { return row([[text(e[0], 'Body/Strong'), 80], [text(e[1], 'Body/Default'), 170], [text(e[2], 'Body/Default', 'text/secondary', { sizeH: 'FILL', truncate: true }), 'fill'], [text(e[3], 'Body/Default', 'status/critical/fg'), 320]], false, false, 48); });
  return card('Rows with errors', [head].concat(rows, [frame({ name: 'more', dir: 'H', pad: 'space/3', sizeH: 'FILL' }, [text('Showing 6 of 30 rows with errors', 'Body/Small', 'text/muted', { sizeH: 'FILL' }), ppLink('Download error report (CSV)', 'download', 'error-report')])]));
}
// I3 · Check finished with errors: counts, rows to fix, an explicit choice to skip them, then Import.
function piResultErrors() {
  const skip = inst('CheckboxRow', { Value: 'Checked', State: 'Default', Label: 'Skip the 30 rows with errors', Description: 'Import button stays off until this is ticked or the file has no errors.' }, { name: 'skip-errors', sizeH: 'FILL' });
  return piScreen('3 Check result, errors', 2, [
    piFileRow('Checked at 8:24 pm · 1,240 rows', ppLink('Upload a corrected file', 'refresh-cw', 'replace')),
    piTiles([['Rows in the file', '1,240'], ['Ready to import', '1,198', 'status/success/fg'], ['Errors', '30', 'status/critical/fg', 'These rows are not imported'], ['Warnings', '12', 'status/attention/fg', 'Imported; check them later']]),
    piBanner('Attention', '30 rows have errors', 'Fix them in your file and upload it again, or import the valid rows now and add the rest later.'),
    piErrorTable(),
    piSection('Settings', 'Before you import', null, [piStartAs(), skip]),
    piFooter([btn('Cancel', 'Secondary', 'Md'), frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Back', 'Secondary', 'Md'), btn('Import 1,198 products', 'Primary', 'Md')])]);
}
// I4 · Check finished, all rows ready: a preview of the first rows.
function piResultOk() {
  const head = headerRow([['Title', 'fill'], ['Main category', 180], ['Product type', 180], ['Brand', 160]]);
  const prev = [['Lamb shoulder 1 kg', 'Meat', 'Fresh meat', '—'], ['Chicken drumsticks 1 kg', 'Poultry', 'Fresh meat', '—'], ['Lebanese bread 6 pack', 'Bakery', 'Bakery', 'Sunrise Bakery'], ['Red lentils 2 kg', 'Pantry', 'Packaged food', 'Golden Field'], ['Sumac 100 g', 'Pantry', 'Packaged food', 'Golden Field']];
  const table = card('Preview', [head].concat(prev.map(function (r) { return row([[text(r[0], 'Body/Strong'), 'fill'], [text(r[1], 'Body/Default'), 180], [text(r[2], 'Body/Default'), 180], [text(r[3], 'Body/Default'), 160]], false, false, 48); }), [frame({ name: 'more', dir: 'H', pad: 'space/3', sizeH: 'FILL' }, [text('First 5 of 1,240 rows', 'Body/Small', 'text/muted')])]));
  return piScreen('4 Check result, all ready', 2, [
    piFileRow('Checked at 8:24 pm · 1,240 rows', ppLink('Choose another file', 'refresh-cw', 'replace')),
    piTiles([['Rows in the file', '1,240'], ['Ready to import', '1,240', 'status/success/fg'], ['Errors', '0'], ['Warnings', '0']]),
    piBanner('Success', 'All 1,240 rows are ready to import', 'Nothing has been saved yet. Check the settings below, then import.'),
    table, piSection('Settings', 'Before you import', null, [piStartAs()]),
    piFooter([btn('Cancel', 'Secondary', 'Md'), frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Back', 'Secondary', 'Md'), btn('Import 1,240 products', 'Primary', 'Md')])]);
}
// I5 · Confirm: what will happen, in numbers.
function piConfirm() {
  const d = dlg({ name: 'Confirm import', title: 'Import 1,198 products?', text: 'They are added to the Australia catalog as Inactive products. The 30 rows with errors are skipped. It can take a few minutes, and you can leave this page while it runs.', primary: 'Import products', secondary: 'Cancel' });
  const scr = dialogScene(PI + ' · 5 Confirm', [d]);
  scr.setPluginData('proposal', 'admin-products');
  return scr;
}
// I6 · Importing: a progress bar; it keeps running if the admin leaves.
function piImporting() {
  return piScreen('6 Importing', 3, [piSection('Progress', 'Importing products', null, [piFileRow('1,198 products to add'), piMeter(50, 1100),
    frame({ name: 'progress-text', dir: 'H', sizeH: 'FILL' }, [text('599 of 1,198 added', 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), text('About 1 minute left', 'Body/Small', 'text/muted')]),
    piBanner('Info', 'You can leave this page', 'The import keeps running. You get a notification when it finishes, and the report stays under Import history.')]), piFooter([frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Back to products', 'Secondary', 'Md')])]);
}
// I7 · Finished: the report, a download of it, and Done back to the list.
function piDone() {
  const failed = card('Not imported', [headerRow([['Row', 80], ['Title', 'fill'], ['Reason', 360]])].concat([['301', 'Ghee 400 g', 'A product with this title and brand was added a moment ago by another admin'], ['877', 'Halwa 250 g', 'The main category was deactivated during the import']].map(function (r) { return row([[text(r[0], 'Body/Strong'), 80], [text(r[1], 'Body/Default'), 'fill'], [text(r[2], 'Body/Small', 'text/secondary', { sizeH: 'FILL' }), 360]], false, false, 56); })));
  return piScreen('7 Finished', 3, [
    piBanner('Success', 'Import finished: 1,196 products added', 'They are Inactive. Open them in the list to check them, then activate them in bulk.'),
    piTiles([['Added', '1,196', 'status/success/fg'], ['Skipped at check', '30', null, 'Rows with errors'], ['Not imported', '2', 'status/critical/fg', 'See the list below'], ['Time', '2 min 10 s']]),
    failed,
    piFooter([ppLink('Download full report (CSV)', 'download', 'report'), ppLink('View the imported products', 'external-link', 'view-imported'), frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Import another file', 'Secondary', 'Md'), btn('Done', 'Primary', 'Md')])]);
}
// I8 · Back on the list after Done: a toast and the Inactive tab ready.
function piBackOnList() {
  const scr = ppScreen('After import, Done', [ppHeader(), ppViews('Inactive'), ppToolbar(), ppTable({ showInactive: true, range: '1–25 of 1,332 products' })]);
  const t = inst('Toast', { Tone: 'Success', Message: '1,196 products imported as Inactive.', 'Show action': true, Action: 'View report' }, { name: 'toast' });
  setMeta(t, { abs: [1440 - 400 - 24, 900 - 80] }); add(scr, t);
  return scr;
}
// I9 · Problems that stop the check, and an import that stops part way.
function piStates() {
  const st = [['Wrong file type', 'Critical', 'This file type can’t be imported', 'Choose a CSV or XLSX file. Other formats, such as PDF or Numbers, are not read.'],
    ['File too large', 'Critical', 'The file has 7,820 rows', 'Import up to 5,000 rows at a time. Split the file into two and import them one after the other.'],
    ['Columns don’t match', 'Critical', 'The column Main category is missing', 'Use the template, or rename the column in your file. Columns we don’t know are ignored and listed in the report.'],
    ['Empty file', 'Attention', 'The file has no product rows', 'Only the header row was found. Add one product per row below it.'],
    ['Import stopped part way', 'Critical', 'The import stopped after 640 products', 'The 640 products added are kept. Import the remaining 558 rows from the report, with Retry the rest.']];
  const cells = st.map(function (s) { return frame({ name: s[0], dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [text(s[0], 'Caption/Strong', 'text/muted'), piBanner(s[1], s[2], s[3])]); });
  const scr = frame({ name: PI + ' · States', dir: 'V', w: 900, pad: 40, gap: 'space/5', fill: 'bg/page' }, [text('Import: problems', 'Heading/H1'), para('Each message shows on the step where it happens, under the file, with what to do next. The check never saves anything, so a problem there leaves the catalog unchanged.', 800)].concat(cells));
  tag(scr); scr.setPluginData('proposal', 'admin-products');
  return scr;
}
const PROPOSALS = { 'admin-products': { title: PP, rows: function () { return [[ppDefault(), ppSelected(), ppSearchFilter()], [ppFilterOpen(), ppSortOpen(), ppColumnsOpen()], [ppAllColumns(), ppDialogs(), ppStates()], [piUpload(), piChecking(), piResultErrors()], [piResultOk(), piConfirm(), piImporting()], [piDone(), piBackOnList(), piStates()]]; } } };

// ---- Panels · Settings (back-port, owner 30 Oct 20:55Z): the settings UX built in code from the thread on admin and seller
// panel UX (merged on main up to #580): one Settings item at the foot of the sidebar opens a card hub; every settings page uses
// one template (sub-navigation, header with the last change, sections of rows, one save bar, banners for view only, a save by
// someone else first and errors, one no-access block, a leave guard); the Cmd+K search with pinned and recent pages; the toast
// system. Labels follow apps/*/messages/en.json. Drawn from 1.9.0 components (SettingRow is 1.10.0, so rows are drawn here).
const PS = 'Proposal · Panels · Settings';
const PS_ADMIN_GROUPS = [['Marketplace', 'store', [['Support contact'], ['Smart assistant']]], ['Delivery', 'package', [['Delivery rules'], ['Delivery fleets']]], ['Money', 'wallet', [['Customer wallet']]], ['People & access', 'users', [['Admins', 'View only'], ['Roles & permissions', 'View only']]]];
const PS_SELLER_GROUPS = [['Store', 'store', [['Store profile'], ['Stock locations']]], ['Money', 'wallet', [['Payout account']]], ['Team', 'users', [['Members']]]];
function psTag(n) { n.setPluginData('proposal', 'panel-settings'); return n; }
function psScreen(state, ws, crumb, kids, overlay) {
  const scr = screen(PS + ' · ' + state, ws, 'nav-settings', crumb, kids, { minH: PANEL_MIN_H, gap: 'space/4' });
  (overlay ? [].concat(overlay) : []).forEach(function (o) { add(scr, o); });
  return psTag(scr);
}
function psSp() { return frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }); }
// Hub: groups as cards, two a row; each link a row with an optional View only badge and a chevron.
function psHubCard(g) {
  return card(g[0], [frame({ name: 'head', dir: 'H', gap: 'space/2-5', align: 'center', pad: [20, 20, 12, 20], sizeH: 'FILL' }, [icon(g[1], 'icon/default', 18), text(g[0], 'Heading/H2')])].concat(g[2].map(function (l) {
    return frame({ name: 'link · ' + l[0], dir: 'H', gap: 'space/3', align: 'center', pad: [12, 20, 12, 20], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(l[0], 'Body/Default', 'text/primary', { sizeH: 'FILL' }), l[1] ? bdg('Neutral', 'None', l[1]) : null, icon('chevron-right', 'icon/muted', 16)]);
  })));
}
function psHub(ws, groups, desc) {
  const rows = []; for (let i = 0; i < groups.length; i += 2) rows.push(frame({ name: 'row', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, groups.slice(i, i + 2).map(psHubCard).concat(groups.length % 2 && i + 2 > groups.length ? [frame({ name: 'empty', dir: 'V', h: 1, sizeH: 'FILL' })] : [])));
  return psScreen(ws + ' · Settings hub', ws, 'Settings', [pageTitle('Settings', desc, [btn('Search', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'search' } })])].concat(rows));
}
// The settings sub-navigation: the hub's groups and links, the current page selected.
function psSubNav(groups, current) {
  const kids = [];
  groups.forEach(function (g) {
    kids.push(text(g[0], 'Caption/Overline', 'text/muted', { name: 'group' }));
    g[2].forEach(function (l) { const on = l[0] === current; kids.push(frame({ name: 'link · ' + l[0], dir: 'H', align: 'center', pad: [8, 12, 8, 12], radius: 'radius/control', fill: on ? 'bg/selected' : null, sizeH: 'FILL' }, [text(l[0], on ? 'Body/Strong' : 'Body/Default', on ? 'text/primary' : 'text/secondary')])); });
  });
  return frame({ name: 'Settings menu', dir: 'V', gap: 'space/1', w: 220 }, kids);
}
// One setting row: label and help on the start side, the control on the end side; changed rows carry the attention ring.
function psRow(label, help, control, o) {
  o = o || {};
  const ctl = frame({ name: 'control', dir: 'V', gap: 'space/1', w: 360, pad: o.changed ? 3 : 0, radius: 'radius/control', stroke: o.changed ? 'status/attention/solid' : null, strokeW: 2 }, [control, o.error ? text(o.error, 'Body/Small', 'status/critical/fg', { name: 'error', sizeH: 'FILL' }) : null]);
  return frame({ name: 'row · ' + label, dir: 'H', gap: 'space/6', align: 'start', pad: [16, 20, 16, 20], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [frame({ name: 'label', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(label, 'Body/Strong'), help ? text(help, 'Body/Small', 'text/muted', { sizeH: 'FILL' }) : null]), ctl]);
}
function psSection(title, sub, rows) { return card(title, [frame({ name: 'head', dir: 'V', gap: 'space/1', pad: [20, 20, 12, 20], sizeH: 'FILL' }, [text(title, 'Heading/H2'), text(sub, 'Body/Small', 'text/muted', { sizeH: 'FILL' })])].concat(rows)); }
function psInput(value, state) { return inst('Input', { Type: 'Text', State: state || 'Filled', Value: value, 'Leading icon': false }, { name: 'input', sizeH: 'FILL' }); }
function psSelect(value, state) { return inst('Select', { State: state || 'Filled', Value: value }, { name: 'select', sizeH: 'FILL' }); }
function psSaveBar(summary, errors) {
  return frame({ name: 'Save bar', dir: 'H', gap: 'space/3', align: 'center', pad: [12, 20, 12, 20], fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', effect: 'Elevation/Floating', sizeH: 'FILL' }, [
    text(summary, 'Body/Strong'), errors ? text('· ' + errors, 'Body/Strong', 'status/critical/fg') : null, psSp(), btn('Discard', 'Secondary', 'Md'), btn('Save changes', 'Primary', 'Md', errors ? { State: 'Disabled' } : {})]);
}
// The Delivery rules page in a given state.
function psDelivery(state, o) {
  o = o || {};
  const dis = o.viewOnly ? 'Disabled' : null;
  const rows1 = [psRow('Delivery methods', 'Which methods sellers can offer to customers in this market.', psSelect('Local delivery, Pickup', dis), { changed: o.changed }),
    psRow('Same-day cut-off', 'Orders placed before this time, in the seller’s time zone, can be delivered the same day.', psInput(o.badCutoff ? '25:00' : '1:00 pm', o.badCutoff ? 'Error' : dis), { error: o.badCutoff ? 'Enter a time between 12:00 am and 11:59 pm, such as 1:00 pm.' : null, changed: o.changed })];
  const rows2 = [psRow('Delivery fee margin', 'Added to the courier’s quote. Example: a quote of AUD 9.00 shows as AUD 9.90.', psInput('10%', dis)), psRow('Round fees up to', 'The fee the customer sees is rounded up to this step.', psSelect('AUD 0.10', dis))];
  const head = pageTitle('Delivery rules', 'How delivery works for every seller in the Australia market.', [ppIconButton('star', 'pin')]);
  const last = text('Last changed by Sara K. · 2 days ago · View history', 'Caption/Default', 'text/muted', { name: 'last-changed' });
  const content = frame({ name: 'Settings content', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [frame({ name: 'header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [head, last])].concat(o.banner ? [o.banner] : [], [psSection('Methods and timing', 'What customers can choose at checkout, and until when.', rows1), psSection('Fees', 'What the platform adds to delivery quotes.', rows2)], o.saveBar ? [o.saveBar] : []));
  return psScreen('Admin · Delivery rules · ' + state, 'Admin', 'Settings / Delivery / Delivery rules', [frame({ name: 'Settings layout', dir: 'H', gap: 'space/6', align: 'start', sizeH: 'FILL' }, [psSubNav(PS_ADMIN_GROUPS, 'Delivery rules'), content])], o.overlay);
}
// The seller Store profile page in a given state: the same template, sub-navigation, save bar and states as the admin pages.
// Textarea 1.9.0 wraps a set Value only in its Filled variant (the Error and Disabled variants keep a hug-width value text),
// so those two states are drawn with the same tokens as the component.
function psTextarea(value, state) {
  if (!state || state === 'Filled') return inst('Textarea', { State: 'Filled', Value: value }, { name: 'textarea', sizeH: 'FILL' });
  const err = state === 'Error';
  return frame({ name: 'textarea · ' + state, dir: 'V', pad: 'space/2-5', fill: err ? 'bg/surface' : 'bg/muted', stroke: err ? 'status/critical/solid' : 'border/input', radius: 'radius/control', sizeH: 'FILL' }, [text(value, 'Body/Default', err ? 'text/primary' : 'text/muted', { name: 'value', sizeH: 'FILL' })]);
}
function psPicture(kind, w, h, dis) {
  return frame({ name: kind, dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [rect({ name: kind + ' preview', w: w, h: h, fill: 'bg/muted', radius: 'radius/control' }), psSp(), btn('Replace', 'Secondary', 'Sm', dis ? { State: 'Disabled' } : {}), btn('Remove', 'Ghost', 'Sm', dis ? { State: 'Disabled' } : {})]);
}
const PS_ABOUT = 'Family-run halal butcher in Kuraby since 2009. Grass-fed lamb and beef, cut to order, delivered across Brisbane south.';
function psStore(state, o) {
  o = o || {};
  const dis = o.viewOnly ? 'Disabled' : null;
  const about = frame({ name: 'about', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [psTextarea(o.badAbout ? PS_ABOUT + ' Certified halal by AFIC.' : PS_ABOUT, o.badAbout ? 'Error' : dis), text((o.badAbout ? 149 : 125) + ' of 600 characters', 'Caption/Default', 'text/muted', { name: 'counter' })]);
  const rows1 = [psRow('About your store (English)', 'Plain text. Links and web addresses are not allowed. Certificates are shown as verified badges after our team checks them.', about, { changed: o.changed, error: o.badAbout ? 'This text claims a certification. Remove that wording.' : null })];
  const rows2 = [psRow('Logo', 'Shown next to your store name. A square picture, at least 128 × 128 px.', psPicture('logo', 56, 56, dis), { changed: o.changed }),
    psRow('Banner', 'A wide picture at the top of your store page, 1200 × 300 px or larger. The edges are cropped on phones.', psPicture('banner', 160, 40, dis))];
  const head = pageTitle('Store profile', 'What buyers see on your store page. Changes are public as soon as you save them.', [ppIconButton('star', 'pin')]);
  const last = text('Last changed by Amir R. · 3 days ago · View history', 'Caption/Default', 'text/muted', { name: 'last-changed' });
  const content = frame({ name: 'Settings content', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [frame({ name: 'header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [head, last])].concat(o.banner ? [o.banner] : [], [psSection('About', 'A few words about your store, in each language you sell in.', rows1), psSection('Pictures', 'JPEG, PNG or WebP, under 25 MB.', rows2)], o.saveBar ? [o.saveBar] : []));
  return psScreen('Seller · Store profile · ' + state, 'Seller', 'Settings / Store / Store profile', [frame({ name: 'Settings layout', dir: 'H', gap: 'space/6', align: 'start', sizeH: 'FILL' }, [psSubNav(PS_SELLER_GROUPS, 'Store profile'), content])], o.overlay);
}
function psBanner(name, tone, title, bodyText, action) { return inst('InfoBanner', Object.assign({ Tone: tone, Title: title, Body: bodyText, 'Show action': !!action }, action ? { Action: action } : {}), { name: name, sizeH: 'FILL' }); }
function psSavedToast(msg) { const t = psToast('Success', msg); setMeta(t, { abs: [1440 - 400 - 16, 900 - 76] }); return t; }
function psErrorSummary() { return inst('InfoBanner', { Tone: 'Critical', Title: '1 setting needs fixing', Body: 'Same-day cut-off: enter a time between 12:00 am and 11:59 pm.', 'Show action': false }, { name: 'error-summary', sizeH: 'FILL' }); }
function psConflict() { return inst('InfoBanner', { Tone: 'Attention', Title: 'Sara K. saved these settings 1 minute ago', Body: 'Your 2 changes are kept. Review what changed, then save again.', 'Show action': true, Action: 'Show what changed' }, { name: 'conflict', sizeH: 'FILL' }); }
function psViewOnly() { return inst('InfoBanner', { Tone: 'Info', Title: 'View only', Body: 'Your role can see these settings but not change them. An admin who manages roles can give you access.', 'Show action': false }, { name: 'view-only', sizeH: 'FILL' }); }
// Command palette (Cmd+K): pinned and recent before typing; results by kind while typing.
function psItem(label, desc, ic, on) { return inst('MenuItem', Object.assign({ State: on ? 'Selected' : 'Default', Label: label, 'Leading icon': true, Icon: { icon: ic }, 'Show description': !!desc }, desc ? { Description: desc } : {}), { name: 'item · ' + label, sizeH: 'FILL' }); }
const PS_PALETTE_SELLER = { results: [['Settings', [['Logo', 'Settings / Store / Store profile', 'sliders', true], ['Banner', 'Settings / Store / Store profile', 'sliders']]], ['Pages', [['Store profile', 'Settings / Store', 'file-text']]]],
  idle: [['Pinned', [['Orders', null, 'clipboard', true], ['Store profile', 'Settings / Store', 'star']]], ['Recent', [['Payout account', 'Settings / Money', 'clock'], ['Members', 'Settings / Team', 'clock'], ['Stock locations', 'Settings / Store', 'clock']]], ['Actions', [['Invite member', null, 'plus'], ['Add stock location', null, 'plus']]]] };
function psPalette(query, ws) {
  const groups = ws === 'Seller' ? PS_PALETTE_SELLER[query ? 'results' : 'idle'] : query ? [['Settings', [['Delivery fee margin', 'Settings / Delivery / Delivery rules', 'sliders', true], ['Round fees up to', 'Settings / Delivery / Delivery rules', 'sliders']]], ['Pages', [['Delivery rules', 'Settings / Delivery', 'file-text']]]]
    : [['Pinned', [['Orders', null, 'clipboard', true], ['Delivery rules', 'Settings / Delivery', 'star']]], ['Recent', [['Support contact', 'Settings / Marketplace', 'clock'], ['Roles & permissions', 'Settings / People & access', 'clock'], ['Customer wallet', 'Settings / Money', 'clock']]], ['Actions', [['Invite admin', null, 'plus'], ['Create role', null, 'plus']]]];
  const kids = [inst('Input', { Type: 'Text', State: query ? 'Filled' : 'Focus', Value: query || 'Search pages, settings and actions', 'Leading icon': true }, { name: 'query', sizeH: 'FILL' })];
  if (query) kids.push(text('3 results', 'Caption/Default', 'text/muted', { name: 'count' }));
  groups.forEach(function (g) { kids.push(frame({ name: 'group · ' + g[0], dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(g[0], 'Caption/Overline', 'text/muted')].concat(g[1].map(function (i) { return psItem(i[0], i[1], i[2], i[3]); })))); });
  kids.push(frame({ name: 'hints', dir: 'H', gap: 'space/4', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text('↑ ↓ to move', 'Caption/Default', 'text/muted'), text('Enter to open', 'Caption/Default', 'text/muted'), text('Esc to close', 'Caption/Default', 'text/muted'), psSp(), text('? for shortcuts', 'Caption/Default', 'text/muted')]));
  return frame({ name: 'Command palette', dir: 'V', w: 640, pad: 'space/4', gap: 'space/3', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', effect: 'Elevation/Floating' }, kids);
}
function psPaletteScene(state, query, ws) {
  const scr = frame({ name: PS + ' · ' + (ws || 'Admin') + ' · Search (Cmd+K) · ' + state, w: 1440, h: 900, fill: 'bg/page', clip: true });
  add(scr, frame({ name: 'scrim', w: 1440, h: 900, fill: 'bg/scrim' }));
  const pal = psPalette(query, ws); scr.appendChild(pal); pal.x = 400; pal.y = 96;
  tag(scr); return psTag(scr);
}
// Toasts: bottom end corner, at most three, newest lowest, above the save bar when it shows.
function psToast(tone, msg, action) {
  const T = { Info: ['info', 'text/link'], Warning: ['alert-triangle', 'status/attention/fg'], Loading: ['refresh-cw', 'icon/muted'] }[tone];
  if (!T) return inst('Toast', Object.assign({ Tone: tone, Message: msg, 'Show action': !!action }, action ? { Action: action } : {}), { name: 'toast · ' + tone });
  return frame({ name: 'toast · ' + tone, dir: 'H', gap: 'space/3', align: 'center', w: 400, pad: [12, 12, 12, 16], fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', effect: 'Elevation/Floating' }, [icon(T[0], T[1], 18), text(msg, 'Body/Default', 'text/primary', { sizeH: 'FILL' }), tone === 'Loading' ? null : inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'close' })]);
}
function psToasts() {
  const list = [['Success', 'Delivery rules saved.', null, '5 s · role="status"'], ['Success', 'Slide archived.', 'Undo', '10 s · Undo reachable with Tab'], ['Info', 'Export is being prepared. You get a notification when it is ready.', null, '6 s'], ['Warning', 'Saved. 2 sellers are above the new maximum fee.', null, '8 s'], ['Critical', 'The invite couldn’t be sent. Check the address and try again.', 'Try again', 'Stays until closed · role="alert"'], ['Loading', 'Saving…', null, 'Until done, then the result']];
  const cells = list.map(function (t) { return frame({ name: t[0], dir: 'H', gap: 'space/5', align: 'center', sizeH: 'FILL' }, [psToast(t[0], t[1], t[2]), text(t[3], 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]); });
  const scr = frame({ name: PS + ' · Toasts', dir: 'V', w: 900, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Toasts', 'Heading/H1'), para('The result of an action the user just took. Bottom end corner (bottom right in the panels), 16 px from the edges, at most 3, newest lowest; a toast with the same id replaces the last one. The timer pauses on hover, on focus and in a hidden tab. A field error is never only a toast; a lasting state is a banner; an event the user did not cause goes to the bell.', 820)].concat(cells));
  tag(scr); return psTag(scr);
}
// States that end the page: could not load, no access, and the leave guard.
function psStates(ws) {
  const seller = ws === 'Seller';
  const page = seller ? 'Store profile' : 'Delivery rules';
  const noAccess = inst('EmptyState', { Size: 'Card', Title: 'You don’t have access to this page', Body: seller ? 'Payout account needs the permission "View payouts". The store owner can add it.' : 'Delivery rules needs the permission "View delivery settings". An admin who manages roles can add it.', Icon: { icon: 'lock' } }, { name: 'no-access', sizeH: 'FILL' });
  setNested(noAccess, 'action', prop('Button', 'Label', 'Back to Settings'));
  const load = inst('InfoBanner', { Tone: 'Critical', Title: (seller ? 'The store profile' : 'Delivery settings') + ' could not be loaded', Body: 'Try again. If it keeps happening, check the status page.', 'Show action': true, Action: 'Try again' }, { name: 'load-error', sizeH: 'FILL' });
  const leave = dlg({ name: 'Leave without saving', title: 'Leave without saving?', text: 'You have 2 unsaved changes on ' + page + '. If you leave now, they are lost.', primary: 'Leave', secondary: 'Stay', focusCancel: true });
  const scr = frame({ name: PS + ' · ' + (ws || 'Admin') + ' · States', dir: 'V', w: 900, pad: 40, gap: 'space/5', fill: 'bg/page' }, [text((seller ? 'Seller' : 'Admin') + ' settings pages: states', 'Heading/H1'), para('One block for every page the role cannot see, one banner for a page that cannot load, and one guard when leaving with unsaved changes. Password, two-step sign-in and dangerous actions keep their own button and confirmation in a Danger zone section at the end of the page.', 820),
    text('No access', 'Caption/Strong', 'text/muted'), noAccess, text('Could not load', 'Caption/Strong', 'text/muted'), load, text('Leave with unsaved changes', 'Caption/Strong', 'text/muted'), leave]);
  tag(scr); return psTag(scr);
}
PROPOSALS['panel-settings'] = { title: PS, rows: function () {
  const admin = 'Set up how the marketplace works. Changes here apply to every seller and customer.', seller = 'Set up how your store works. Changes here apply to your whole store.';
  return [[psHub('Admin', PS_ADMIN_GROUPS, admin), psHub('Seller', PS_SELLER_GROUPS, seller), psPaletteScene('Pinned and recent', null, 'Admin'), psPaletteScene('Pinned and recent', null, 'Seller')],
    // Admin: Delivery rules in every state
    [psDelivery('Default'), psDelivery('Unsaved changes', { changed: true, saveBar: psSaveBar('2 unsaved changes') }), psDelivery('Needs fixing', { changed: true, badCutoff: true, banner: psErrorSummary(), saveBar: psSaveBar('2 unsaved changes', '1 needs fixing') })],
    [psDelivery('Someone saved first', { changed: true, banner: psConflict(), saveBar: psSaveBar('2 unsaved changes') }), psDelivery('View only', { viewOnly: true, banner: psViewOnly() }), psDelivery('Saved', { overlay: psSavedToast('Delivery rules saved.') })],
    // Seller: Store profile in the same states
    [psStore('Default'), psStore('Unsaved changes', { changed: true, saveBar: psSaveBar('2 unsaved changes') }), psStore('Needs fixing', { changed: true, badAbout: true, banner: psBanner('error-summary', 'Critical', '1 setting needs fixing', 'About your store: remove the wording that claims a certification.'), saveBar: psSaveBar('2 unsaved changes', '1 needs fixing') })],
    [psStore('Someone saved first', { changed: true, banner: psBanner('conflict', 'Attention', 'Amir R. saved the store profile 1 minute ago', 'Your 2 changes are kept. Review what changed, then save again.', 'Show what changed'), saveBar: psSaveBar('2 unsaved changes') }), psStore('View only', { viewOnly: true, banner: psBanner('view-only', 'Info', 'View only', 'You can see the store profile but not change it. The store owner can give you access.') }), psStore('Saved', { overlay: psSavedToast('Store profile saved. Buyers can see it now.') })],
    [psPaletteScene('Results', 'fee', 'Admin'), psPaletteScene('Results', 'logo', 'Seller'), psToasts(), psStates('Admin'), psStates('Seller')]];
} };

// ---- Admin · Catalog · Categories (owner 30 Oct 22:08Z; plan decided 22:37Z, design/categories/categories-management-plan-fa.html
// section 13): the platform category tree of one Market. Four levels (department, group, category, subcategory), one parent each;
// products sit on level 3 or 4, never on a department or group (decision 3, changed 22:47Z); a new category starts Hidden; Hidden is reversible, Archive is final; Move, Merge, Archive and
// Move products only through a dialog that shows what will change and asks for a reason (no drag). Tree two thirds, details one third.
const PC = 'Proposal · Admin · Catalog · Categories';
function pcTag(n) { n.setPluginData('proposal', 'admin-categories'); return n; }
// [depth, name, live products, open: true | false | null (leaf), flags]
const PC_TREE = [
  [0, 'Pantry', '412', true], [1, 'Rice and grains', '138', true], [2, 'Rice', '96', true, { direct: '9' }],
  [3, 'Basmati rice', '41', null, { selected: true }], [3, 'Jasmine rice', '0', null, { hidden: true }], [3, 'Brown rice', '14', null],
  [2, 'Quinoa and couscous', '42', false], [1, 'Spices and seasonings', '87', false], [1, 'Oils and ghee', '64', false], [1, 'Dates and dried fruit', '123', false],
  [0, 'Meat and poultry', '205', false], [0, 'Bakery', '58', false], [0, 'Dairy and eggs', '96', false], [0, 'Ramadan specials', '31', false, { notInMenu: true }],
];
function pcSp() { return frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }); }
function pcTreeRow(r, sel, match) {
  const f = r[4] || {};
  const on = sel ? r[1] === sel : f.selected;
  const chev = r[3] === null ? frame({ name: 'leaf', w: 16, h: 16 }) : icon(r[3] ? 'chevron-down' : 'chevron-right', 'icon/muted', 16);
  const name = text(r[1], on || match === r[1] ? 'Body/Strong' : 'Body/Default', 'text/primary');
  return frame({ name: 'node · ' + r[1], dir: 'H', gap: 'space/2', align: 'center', pad: [9, 16, 9, 16 + r[0] * 24], fill: on ? 'bg/selected' : null, stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [
    chev, name, f.hidden ? bdg('Neutral', 'Icon', 'Hidden', 'eye-off') : null, f.isNew ? bdg('Info', 'None', 'New') : null, f.notInMenu ? bdg('Neutral', 'None', 'Not in menu') : null, f.missing ? bdg('Attention', 'None', 'Missing: ' + f.missing) : null, pcSp(), f.direct ? text(f.direct + ' direct', 'Caption/Default', 'text/muted', { name: 'direct' }) : null, text(r[2], 'Body/Small', 'text/muted', { name: 'count' })]);
}
function pcTree(o) {
  o = o || {};
  const rows = (o.rows || PC_TREE).map(function (r) { return pcTreeRow(r, o.selected, o.match); });
  const search = inst('Input', { Type: 'Text', State: o.query ? 'Filled' : 'Default', Value: o.query || 'Search categories', 'Leading icon': true }, { name: 'search', sizeH: 'FILL' });
  const tools = frame({ name: 'tree tools', dir: 'H', gap: 'space/3', align: 'center', pad: [12, 16, 12, 16], sizeH: 'FILL' }, [search, inst('Select', { State: 'Filled', Value: 'Status: ' + (o.status || 'All') }, { name: 'status', w: 140 }), inst('Select', { State: 'Filled', Value: o.langFilter || 'Language: All' }, { name: 'language', w: 170 }), ppLink('Expand all', null, 'expand-all'), ppLink('Collapse all', null, 'collapse-all')]);
  const head = frame({ name: 'tree head', dir: 'H', gap: 'space/2', pad: [8, 16, 8, 16], fill: 'bg/subtle', stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text('Category', 'Caption/Strong', 'text/muted'), pcSp(), text('Live products', 'Caption/Strong', 'text/muted')]);
  const kids = [tools];
  if (o.note) kids.push(frame({ name: 'note', dir: 'H', pad: [0, 16, 12, 16], sizeH: 'FILL' }, [text(o.note, 'Body/Small', 'text/muted')]));
  return card('Category tree', kids.concat([head], rows, [frame({ name: 'tree foot', dir: 'H', pad: [12, 16, 12, 16], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(o.foot || '46 categories · 4 levels at most · ↑ ↓ to move, → to open, ← to close', 'Caption/Default', 'text/muted')])]));
}
function pcField(label, control, help) { return frame({ name: 'field · ' + label, dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [text(label, 'Body/Strong'), control, help ? text(help, 'Caption/Default', 'text/muted', { sizeH: 'FILL' }) : null]); }
function pcValue(label, value, extra) { return frame({ name: 'value · ' + label, dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [text(label, 'Body/Small', 'text/muted', { w: 96 }), value, pcSp(), extra || null]); }
function pcIn(v, st) { return inst('Input', { Type: 'Text', State: st || 'Filled', Value: v, 'Leading icon': false }, { name: 'input', sizeH: 'FILL' }); }
function pcTa(v, st) { return st && st !== 'Filled' ? psTextarea(v, st) : inst('Textarea', { State: 'Filled', Value: v }, { name: 'textarea', sizeH: 'FILL' }); }
const PC_TABS = ['Details', 'SEO', 'Attributes', 'Products', 'History'];
// The details column: the selected category's name, path and status, its tabs, the tab body and the actions.
function pcPanel(o) {
  o = o || {};
  const dis = o.viewOnly ? 'Disabled' : 'Default';
  const status = o.hidden ? bdg('Neutral', 'Icon', 'Hidden', 'eye-off') : bdg('Success', 'Dot', 'Active');
  const head = frame({ name: 'panel head', dir: 'V', gap: 'space/1', pad: [20, 20, 0, 20], sizeH: 'FILL' }, [
    frame({ name: 'title', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(o.name || 'Basmati rice', 'Heading/H2'), status, pcSp(), btn(o.hidden ? 'Show' : 'Hide', 'Secondary', 'Sm', { State: dis, 'Leading icon': true, Icon: { icon: o.hidden ? 'eye' : 'eye-off' } })]),
    text(o.path || 'Pantry › Rice and grains › Rice', 'Body/Small', 'text/muted'),
    frame({ name: 'tabs-wrap', dir: 'V', pad: ['space/3', 0, 0, 0], sizeH: 'FILL' }, [tabsBar(PC_TABS.map(function (t) { return [t, null, t === (o.tab || 'Details')]; }))])]);
  const bodyKids = (o.banner ? [o.banner] : []).concat(o.body || pcDetails(o));
  const body = frame({ name: 'panel body', dir: 'V', gap: 'space/4', pad: 20, sizeH: 'FILL' }, bodyKids);
  const acts = frame({ name: 'panel actions', dir: 'H', gap: 'space/2', align: 'center', wrap: true, rowGap: 'space/2', pad: [12, 20, 16, 20], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [
    btn('Add child', 'Secondary', 'Sm', { State: o.leafFull ? 'Disabled' : dis, 'Leading icon': true, Icon: { icon: 'plus' } }), btn('Move…', 'Secondary', 'Sm', { State: dis }), btn('Merge…', 'Secondary', 'Sm', { State: dis }), pcSp(), btn('Archive…', 'Ghost', 'Sm', { State: dis })]);
  return card('Category details', [head, body, acts], { w: 440, sizeH: null });
}
// Category text is entered per language (plan v7, 8A): English plus every language live for customers is required, a draft language is optional.
const PC_LANGS = [['en', 'English', 'English', 'Default · required'], ['fa', 'فارسی', 'Persian', 'Live for customers · required'], ['ar', 'العربية', 'Arabic', 'Draft · optional']];
const PC_TEXT = {
  en: { name: 'Basmati rice', desc: 'Long-grain rice that cooks fluffy and separate. Aged basmati from India and Pakistan.', keywords: 'basmati, long grain, biryani rice' },
  fa: { name: 'برنج باسماتی', desc: 'برنج دانه‌بلند که پس از پخت دانه‌دانه و پف‌دار می‌شود. باسماتی کهنه از هند و پاکستان.', keywords: 'باسماتی، دانه بلند، برنج بریانی' },
  ar: { name: '', desc: '', keywords: '' },
};
// A right-to-left field for Persian and Arabic text, drawn with the Input tokens; the value is right-aligned.
function pcRtl(v, st, o) {
  o = o || {};
  const err = st === 'Error', dis = st === 'Disabled', empty = !v;
  const t = text(empty ? (o.ph || '') : v, 'Body/Default', empty || dis ? 'text/muted' : 'text/primary', { name: 'value', align: 'right', sizeH: 'FILL' });
  return frame({ name: (o.multi ? 'textarea' : 'input') + ' · rtl' + (st ? ' · ' + st : ''), dir: 'H', pad: o.multi ? [10, 12, 30, 12] : [9, 12, 9, 12], fill: dis ? 'bg/muted' : 'bg/surface', stroke: err ? 'status/critical/solid' : 'border/input', radius: 'radius/control', sizeH: 'FILL' }, [t]);
}
function pcLangTabs(sel, missing, errLang) {
  missing = missing || ['ar'];
  return frame({ name: 'language tabs', dir: 'H', gap: 'space/1', align: 'center', sizeH: 'FILL' }, PC_LANGS.map(function (l) {
    const on = l[0] === sel, miss = missing.indexOf(l[0]) >= 0;
    return frame({ name: 'lang · ' + l[2], dir: 'H', gap: 'space/1-5', align: 'center', pad: [6, 10, 6, 10], fill: on ? 'bg/selected' : null, stroke: on ? 'action/primary' : 'border/default', radius: 'radius/control' }, [
      text(l[1], on ? 'Body/Strong' : 'Body/Default', 'text/primary'), miss ? bdg(errLang === l[0] ? 'Critical' : 'Neutral', 'None', 'Missing') : null]);
  }));
}
function pcDetails(o) {
  const dis = o.viewOnly ? 'Disabled' : null;
  const lang = o.lang || 'en', L = PC_LANGS.filter(function (l) { return l[0] === lang; })[0];
  const tx = lang === 'en' ? { name: o.name || PC_TEXT.en.name, desc: o.desc === undefined ? PC_TEXT.en.desc : o.desc, keywords: o.keywords || PC_TEXT.en.keywords } : Object.assign({}, PC_TEXT[lang], o.text || {});
  const rtl = lang !== 'en';
  const nameErr = o.nameError ? 'Error' : dis;
  const nameCtl = rtl ? pcRtl(tx.name, nameErr, { ph: 'Name in ' + L[2] }) : pcIn(tx.name, dis);
  const nameField = o.nameError ? frame({ name: 'field · Name', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [text('Name', 'Body/Strong'), nameCtl, text(o.nameError, 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' })]) : pcField('Name', nameCtl, 'Shown to buyers in the menu, filters and breadcrumbs.');
  const descCtl = rtl ? pcRtl(tx.desc, dis, { multi: true, ph: 'Short description in ' + L[2] }) : pcTa(tx.desc, dis);
  const kwCtl = rtl ? pcRtl(tx.keywords, dis, { ph: 'Search words in ' + L[2] }) : pcIn(tx.keywords, dis);
  const langBlock = frame({ name: 'language text', dir: 'V', gap: 'space/4', pad: 'space/4', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [
    frame({ name: 'language head', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [pcLangTabs(lang, o.missing, o.errLang), text(L[2] + ' · ' + L[3] + (rtl ? ' · right to left' : ''), 'Caption/Default', 'text/muted')]),
    nameField, pcField('Short description', descCtl), pcField('Search keywords', kwCtl, 'Other words buyers type for this category.')]);
  return [langBlock,
    text('For all languages', 'Caption/Strong', 'text/muted'),
    pcValue('URL', text('/c/' + (o.slug || 'basmati-rice'), 'Body/Default', 'text/primary'), ppLink('Change URL name…', null, 'change-url')),
    pcValue('Products', text(o.products || '41 live · 63 offers', 'Body/Default', 'text/primary'), ppLink('Move products…', null, 'move-products')),
    pcField('Image', frame({ name: 'image', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [o.noImage ? frame({ name: 'no image', dir: 'H', w: 72, h: 48, align: 'center', justify: 'center', fill: 'bg/muted', radius: 'radius/control' }, [icon('file', 'icon/muted', 18)]) : rect({ name: 'image preview', w: 72, h: 48, fill: 'bg/muted', radius: 'radius/control' }), pcSp(), btn(o.noImage ? 'Add image' : 'Replace', 'Secondary', 'Sm', { State: o.viewOnly ? 'Disabled' : 'Default' })]), 'Card and page picture, at least 1200 × 600 px.'),
    inst('CheckboxRow', { Value: o.notInMenu ? 'Unchecked' : 'Checked', State: o.viewOnly ? 'Disabled' : 'Default', Label: 'Show in the main menu', Description: 'Empty categories leave the menu on their own.' }, { name: 'show-in-menu', sizeH: 'FILL' }),
    frame({ name: 'save', dir: 'H', gap: 'space/2', align: 'center', justify: 'end', sizeH: 'FILL' }, [o.unsaved ? text(o.unsaved, 'Body/Small', 'text/muted') : null, o.unsaved ? pcSp() : null, btn('Discard', 'Secondary', 'Sm', { State: o.unsaved ? 'Default' : 'Disabled' }), btn('Save changes', 'Primary', 'Sm', { State: o.unsaved && !o.nameError ? 'Default' : 'Disabled' })])];
}
function pcSeo() {
  const preview = frame({ name: 'search preview', dir: 'V', gap: 'space/1', pad: 'space/4', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [
    text('mondapac.com.au › c › basmati-rice', 'Caption/Default', 'text/muted'), text('Basmati rice | Mondapac', 'Body/Strong', 'text/link'),
    text('Shop aged basmati rice from halal-certified sellers in Brisbane. Long-grain, fluffy and separate. Delivered same day.', 'Body/Small', 'text/secondary', { sizeH: 'FILL' })]);
  return [inst('InfoBanner', { Tone: 'Info', Title: 'English only', Body: 'Search engines index the English pages. The URL name is English too. Persian and Arabic names, descriptions and keywords are on the Details tab.', 'Show action': false }, { name: 'seo-english', sizeH: 'FILL' }),
    pcField('Meta title', pcIn('Basmati rice | Mondapac'), '23 of 60 characters. Empty uses "{name} | Mondapac".'),
    pcField('Meta description', pcTa('Shop aged basmati rice from halal-certified sellers in Brisbane. Long-grain, fluffy and separate. Delivered same day.'), '118 of 160 characters.'),
    text('Search result preview', 'Caption/Strong', 'text/muted'), preview,
    inst('CheckboxRow', { Value: 'Unchecked', State: 'Default', Label: 'Hide from search engines (noindex)', Description: 'Filtered and paged lists are always noindex.' }, { name: 'noindex', sizeH: 'FILL' }),
    frame({ name: 'save', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, [btn('Discard', 'Secondary', 'Sm', { State: 'Disabled' }), btn('Save changes', 'Primary', 'Sm', { State: 'Disabled' })])];
}
function pcFilterRow(name, kind, first, last) {
  return frame({ name: 'filter · ' + name, dir: 'H', gap: 'space/2', align: 'center', pad: [8, 12, 8, 12], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [
    frame({ name: 'label', dir: 'V', sizeH: 'FILL' }, [text(name, 'Body/Default'), text(kind, 'Caption/Default', 'text/muted')]),
    inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: first ? 'Disabled' : 'Default', Icon: { icon: 'arrow-up' } }, { name: 'up' }), inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: last ? 'Disabled' : 'Default', Icon: { icon: 'arrow-down' } }, { name: 'down' }), inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'remove' })]);
}
function pcFilters() {
  const list = [['Brand', 'Brand · choices'], ['Pack size', 'Single choice · choices'], ['Grain length', 'Single choice · choices'], ['Net weight', 'Number with unit · range'], ['Contains nuts', 'Yes / No · switch']];
  return [text('Attribute links', 'Body/Strong'),
    pcField('Feature set', inst('Select', { State: 'Filled', Value: 'Rice and grains' }, { name: 'family', sizeH: 'FILL' }), 'What sellers fill in for products here. If you change it, products follow on their next change; shared values are kept.'),
    inst('InfoBanner', { Tone: 'Info', Title: 'Inherited from Rice', Body: 'This category uses the filters of Rice. Change them here to give it its own.', 'Show action': true, Action: 'Use own filters' }, { name: 'inherited', sizeH: 'FILL' }),
    text('Filters buyers see, in this order', 'Caption/Strong', 'text/muted'),
    text('Only choice, brand, number and Yes / No attributes can be filters. Filtered pages are noindex.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' }),
    card('filters', list.map(function (f, i) { return pcFilterRow(f[0], f[1], i === 0, i === list.length - 1); })),
    btn('Add filter', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'plus' } })];
}
function pcProducts() {
  const tile = function (l, v) { return frame({ name: 'tile · ' + l, dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text(l, 'Caption/Default', 'text/muted'), text(v, 'Heading/H2')]); };
  const rows = [['Basmati rice 5 kg', '12 sellers'], ['Aged basmati rice 10 kg', '7 sellers'], ['Organic basmati rice 1 kg', '3 sellers'], ['Brown basmati rice 2 kg', '2 sellers']];
  return [frame({ name: 'tiles', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [tile('Live products', '41'), tile('Offers', '63'), tile('Sellers', '12')]),
    text('Main category for 38 of them. A product has one main category and at most 3 in all, each on level 3 or 4.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    card('products', rows.map(function (r) { return frame({ name: 'product · ' + r[0], dir: 'H', gap: 'space/2', align: 'center', pad: [10, 12, 10, 12], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(r[0], 'Body/Default', 'text/primary', { sizeH: 'FILL' }), text(r[1], 'Caption/Default', 'text/muted')]); })),
    frame({ name: 'links', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [ppLink('Open all 41 in Products', 'external-link', 'open-products'), pcSp(), btn('Move products…', 'Secondary', 'Sm')])];
}
function pcHistory() {
  const items = [['Sara K.', 'Changed details', 'Short description and keywords', '29 Oct 2026, 10:12 am', true], ['Sara K.', 'Renamed', '"Basmati" to "Basmati rice"', '29 Oct 2026, 10:08 am', true], ['Omar H.', 'Moved', 'From Pantry › Rice to Pantry › Rice and grains › Rice. Reason: new Rice and grains group.', '21 Oct 2026, 4:40 pm', false], ['System', 'Created', 'From the Australia catalog seed', '7 Oct 2026, 2:00 am', false]];
  return [frame({ name: 'history filters', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [inst('Select', { State: 'Filled', Value: 'Change: All' }, { name: 'type', sizeH: 'FILL' }), inst('Select', { State: 'Filled', Value: 'By: Anyone' }, { name: 'who', sizeH: 'FILL' })])].concat(items.map(function (h) {
    return frame({ name: 'revision · ' + h[1], dir: 'V', gap: 'space/1', pad: ['space/3', 0, 'space/3', 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [
      frame({ name: 'who', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(h[1], 'Body/Strong'), text('· ' + h[0], 'Body/Small', 'text/muted'), pcSp(), text(h[3], 'Caption/Default', 'text/muted')]),
      text(h[2], 'Body/Small', 'text/secondary', { sizeH: 'FILL' }), h[4] ? ppLink('Use this version again', 'undo', 'restore') : null]);
  }));
}
function pcScreen(state, o) {
  o = o || {};
  const view = o.viewOnly;
  const head = pageTitle('Categories', '46 categories · 1,284 products in the Australia market', [btn('Import', 'Secondary', 'Md', { State: view ? 'Disabled' : 'Default', 'Leading icon': true, Icon: { icon: 'file' } }), btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), primaryHeaderButton('Add category', view ? 'Disabled' : 'Default')]);
  const kids = [head].concat(o.banner ? [o.banner] : [], [frame({ name: 'Categories layout', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [o.left || pcTree(o.tree), o.right || pcPanel(o.panel)])]);
  const scr = screen(PC + ' · ' + state, 'Admin', 'nav-catalogue', 'Catalog / Categories', kids, { minH: PANEL_MIN_H, gap: 'space/4' });
  (o.overlay ? [].concat(o.overlay) : []).forEach(function (x) { add(scr, x); });
  return pcTag(scr);
}
// Dialogs: every structural dialog takes the destination with a tree picker, shows What will change and asks for a reason.
function pcDialog(name, title, sub, kids, primary, o) {
  o = o || {};
  return frame({ name: name, dir: 'V', w: o.w || 520, pad: 'space/6', gap: 'space/4', fill: 'bg/surface', radius: 'radius/card', effect: 'Elevation/Floating' }, [
    text(title, 'Heading/H2', 'text/primary', { sizeH: 'FILL' }), sub ? text(sub, 'Body/Small', 'text/secondary', { sizeH: 'FILL' }) : null].concat(kids, [
    frame({ name: 'footer', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, [btn('Cancel', 'Secondary', 'Md', o.focusCancel ? { State: 'Focus' } : {}), btn(primary, o.destructive ? 'Destructive' : 'Primary', 'Md', o.primaryOff ? { State: 'Disabled' } : {})])]));
}
function pcPicker(rows, chosen) {
  return card('tree picker', [frame({ name: 'picker search', dir: 'H', pad: 'space/3', sizeH: 'FILL' }, [inst('Input', { Type: 'Text', State: 'Default', Value: 'Search categories', 'Leading icon': true }, { name: 'search', sizeH: 'FILL' })])].concat(rows.map(function (r) {
    const on = r[1] === chosen, off = r[3];
    return frame({ name: 'pick · ' + r[1], dir: 'H', gap: 'space/2', align: 'center', pad: [8, 12, 8, 12 + r[0] * 20], fill: on ? 'bg/selected' : null, stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(r[1], on ? 'Body/Strong' : 'Body/Default', off ? 'text/muted' : 'text/primary'), pcSp(), on ? icon('check', 'text/link', 16) : (off ? text(off, 'Caption/Default', 'text/muted') : null)]);
  })));
}
function pcImpact(list) {
  return frame({ name: 'what will change', dir: 'V', gap: 'space/2', pad: 'space/4', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text('What will change', 'Caption/Strong', 'text/muted')].concat(list.map(function (l) {
    return frame({ name: 'impact · ' + l[0], dir: 'H', gap: 'space/2', align: 'start', sizeH: 'FILL' }, [text(l[0], 'Body/Small', 'text/secondary', { sizeH: 'FILL' }), text(l[1], 'Body/Small Strong', l[2] ? 'status/attention/fg' : 'text/primary')]);
  })));
}
// A dialog board that grows with its dialogs (the shared dialogScene clips at 900 px).
function pcScene(name, dialogs) {
  const scr = frame({ name: name, dir: 'V', w: 1440, fill: 'bg/page' }, [frame({ name: 'scrim', dir: 'H', wrap: true, gap: 'space/6', rowGap: 'space/6', align: 'start', justify: 'center', pad: 80, fill: 'bg/scrim', sizeH: 'FILL' }, dialogs)]);
  tag(scr); return scr;
}
function pcReason() { return pcField('Reason (for the audit log)', inst('Textarea', { State: 'Default', Value: '' }, { name: 'reason', sizeH: 'FILL' }), '10 to 500 characters.'); }
function pcDialogsA() {
  const add = pcDialog('Add category', 'Add category', 'It starts Hidden. Show it once the image and search details are ready.', [
    pcField('Name · English', pcIn('Sella rice'), 'Required.'), pcField('Name · فارسی', pcRtl('برنج سلا'), 'Required: Persian is live for customers.'), pcField('Name · العربية', pcRtl('', null, { ph: 'Name in Arabic' }), 'Optional: Arabic is a draft. You can add it later.'),
    text('Add the short description and keywords per language on the Details tab.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' }), pcField('Parent', inst('Select', { State: 'Filled', Value: 'Pantry › Rice and grains › Rice' }, { name: 'parent', sizeH: 'FILL' }), 'Level 4 of 4. A subcategory can’t have children.'),
    pcField('URL name', pcIn('sella-rice'), 'mondapac.com.au/c/sella-rice')], 'Add category');
  const url = pcDialog('Change URL name', 'Change the URL name?', 'The old address keeps working: it sends buyers and search engines to the new one (301). It isn’t given to another category for 12 months.', [
    pcValue('Now', text('/c/basmati-rice', 'Body/Default')), pcField('New URL name', pcIn('basmati'), 'mondapac.com.au/c/basmati'),
    inst('InfoBanner', { Tone: 'Attention', Title: 'Search ranking can drop for a few weeks', Body: 'Change it only when the name is wrong.', 'Show action': false }, { name: 'seo-warning', sizeH: 'FILL' })], 'Change URL name');
  const move = pcDialog('Move category', 'Move Rice', 'Choose the new parent. Rice keeps its 3 subcategories and its address.', [
    pcPicker([[0, 'Pantry'], [1, 'Rice and grains', null, 'Current parent'], [1, 'Spices and seasonings'], [0, 'Grains and staples'], [1, 'Rice', null, 'Can’t go inside itself']], 'Grains and staples'),
    pcImpact([['Live products moved with it', '96'], ['Seller offers', '212'], ['Certificate badges checked again', '148', true], ['Certificate rules that use it', 'None']]), pcReason()], 'Move category', { w: 560 });
  const merge = pcDialog('Merge category', 'Merge Brown rice into…', 'Its products and search results go to the target, and its address sends visitors there. You can’t undo a merge.', [
    pcPicker([[2, 'Rice'], [3, 'Basmati rice'], [3, 'Jasmine rice'], [3, 'Wholegrain rice']], 'Wholegrain rice'),
    pcImpact([['Live products moved to Wholegrain rice', '14'], ['Seller offers', '19'], ['Certificate badges checked again', '11', true]]), pcReason()], 'Merge category', { w: 560, destructive: true });
  return pcTag(pcScene(PC + ' · Dialogs · Add, URL, Move, Merge', [add, url, move, merge]));
}
function pcDialogsB() {
  const archive = pcDialog('Archive category', 'Archive Jasmine rice?', 'It leaves the menu, filters and search. Its address sends visitors to Rice. Archive is final: to pause a category, hide it instead.', [
    pcImpact([['Live products', '0'], ['Products with only this category', '0'], ['Subcategories', 'None']]), pcReason()], 'Archive category', { destructive: true, focusCancel: true });
  const moveP = pcDialog('Move products', 'Move products out of Rice', 'Products can sit on a category or a subcategory, never on a department or group. Choose where the 9 products directly on Rice go.', [
    pcField('Products', inst('Select', { State: 'Filled', Value: 'All 9 products directly on Rice' }, { name: 'which', sizeH: 'FILL' })),
    pcPicker([[1, 'Rice and grains', null, 'Group: no products'], [2, 'Rice', null, 'Current'], [3, 'Basmati rice'], [3, 'Jasmine rice', null, 'Hidden'], [3, 'Brown rice']], 'Basmati rice'),
    pcImpact([['Products that change category', '9'], ['Their main category changes', '7'], ['Sellers emailed', '5'], ['Published now, each one logged', 'Yes']]), pcReason()], 'Move 9 products', { w: 560 });
  const tile = function (l, v, tone) { return frame({ name: 'tile · ' + l, dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text(l, 'Caption/Default', 'text/muted'), text(v, 'Heading/H2', tone || 'text/primary')]); };
  const imp = pcDialog('Import preview', 'Check categories-oct.xlsx', 'Nothing has changed yet. Rows are matched by URL name; merge and archive are done on the page only. Each language has its own columns: name_en, name_fa, name_ar, description_fa and so on.', [
    frame({ name: 'tiles', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [tile('New', '12'), tile('Renamed', '3'), tile('Moved', '2'), tile('Unchanged', '214'), tile('Errors', '2', 'status/critical/fg')]),
    inst('InfoBanner', { Tone: 'Critical', Title: 'Row 17: add the Persian name', Body: 'Persian is live for customers, so name_fa is required.', 'Show action': false }, { name: 'error-lang', sizeH: 'FILL' }),
    inst('InfoBanner', { Tone: 'Critical', Title: 'Row 41: categories can be at most 4 levels deep', Body: '"Sella rice parboiled" would be level 5. Fix the row or leave it out.', 'Show action': false }, { name: 'error', sizeH: 'FILL' }),
    inst('CheckboxRow', { Value: 'Checked', State: 'Default', Label: 'Skip the 2 rows with errors', Description: 'New categories start Hidden. An empty Arabic column is fine: Arabic is a draft.' }, { name: 'skip', sizeH: 'FILL' })], 'Import 16 changes', { w: 640 });
  return pcTag(pcScene(PC + ' · Dialogs · Archive, Move products, Import', [archive, moveP, imp]));
}
// The messages of the plan's section 13, where each one appears.
function pcStates() {
  const empty = inst('EmptyState', { Size: 'Card', Title: 'No categories yet', Body: 'Add your first category or import a file.', Icon: { icon: 'package' } }, { name: 'empty', sizeH: 'FILL' });
  setNested(empty, 'action', prop('Button', 'Label', 'Add category'));
  const nomatch = inst('EmptyState', { Size: 'Card', Title: 'No categories match "sella"', Body: 'Check the spelling or set Status to All.', Icon: { icon: 'search' } }, { name: 'no-match', sizeH: 'FILL' });
  const b = function (n, tone, t, body, act) { return inst('InfoBanner', Object.assign({ Tone: tone, Title: t, Body: body, 'Show action': !!act }, act ? { Action: act } : {}), { name: n, sizeH: 'FILL' }); };
  const field = function (n, msg) { return frame({ name: n, dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [pcIn(n === 'slug' ? 'basmati-rice' : 'Halal basmati rice', 'Error'), text(msg, 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' })]); };
  const scr = frame({ name: PC + ' · States and messages', dir: 'V', w: 900, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Categories: states and messages', 'Heading/H1'),
    para('A page message is a banner above the layout; a field rule is under the field; a structural rule is inside the dialog, above What will change, and turns its primary button off.', 820),
    text('Tree empty', 'Caption/Strong', 'text/muted'), empty, text('Search with no match', 'Caption/Strong', 'text/muted'), nomatch,
    text('Page', 'Caption/Strong', 'text/muted'), b('load-error', 'Critical', 'We couldn’t load categories.', 'Check your connection and try again.', 'Try again'), b('stale', 'Attention', 'Someone changed this category.', 'Reload to see the latest. Your unsaved changes are kept.', 'Reload'), b('tree-changed', 'Attention', 'The tree changed since you opened it.', 'Reload before you move a category.', 'Reload'), b('read-only', 'Info', 'View only', 'Your role can’t change categories.'),
    text('Fields', 'Caption/Strong', 'text/muted'), field('slug', 'This URL name is already used by Basmati rice.'), field('claim', 'Category names can’t include certification words like "halal".'),
    text('Languages (plan 8A)', 'Caption/Strong', 'text/muted'),
    frame({ name: 'lang-required', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [pcRtl('', 'Error', { ph: 'Name in Persian' }), text('Add the Persian name. Persian is live for customers.', 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' })]),
    b('lang-no-words', 'Critical', 'We can’t check Arabic names yet, so this wasn’t saved.', 'Ask an admin to add Arabic certification words.'),
    frame({ name: 'lang-claim', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [pcRtl('برنج باسماتی حلال', 'Error'), text('Category names can’t include certification words like "halal", in any language.', 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' })]),
    text('Language filter options in the tree', 'Caption/Strong', 'text/muted'),
    card('language filter menu', [['Language: All', ''], ['Missing: Persian', '0'], ['Missing: Arabic', '12']].map(function (m, i) { return frame({ name: 'option · ' + m[0], dir: 'H', gap: 'space/2', align: 'center', pad: [9, 12, 9, 12], fill: i === 2 ? 'bg/selected' : null, stroke: i ? 'border/row' : null, sides: ['top'], sizeH: 'FILL' }, [text(m[0], i === 2 ? 'Body/Strong' : 'Body/Default'), pcSp(), m[1] ? text(m[1] + ' categories', 'Caption/Default', 'text/muted') : null]); }), { w: 320, sizeH: null }),
    text('Inside Move, Merge, Archive and Move products', 'Caption/Strong', 'text/muted'), b('loop', 'Critical', 'A category can’t go inside itself.', 'Choose a parent outside Rice.'), b('depth', 'Critical', 'Categories can be at most 4 levels deep.', 'Rice has subcategories, so it can go up to level 2.'),
    b('cert-rules', 'Critical', 'Certificate rules for Halal use this category, so it can’t be moved yet.', 'Move or remove those rules first.', 'Open certificate rules'), b('cert-down', 'Critical', 'We couldn’t check the certificate rules, so nothing was changed.', 'Try again.', 'Try again'),
    b('too-big', 'Critical', 'This change affects more than 50,000 badges.', 'Move its subcategories one at a time.'), b('no-home', 'Critical', '9 live products would be left without a category.', 'Choose a replacement.'), b('level', 'Critical', 'Choose a category or subcategory.', 'Products can’t go on a department or group.'),
    b('counting', 'Info', 'Still counting', 'At least 2,400 products. You can go on: the count finishes in the background.')]);
  tag(scr); return pcTag(scr);
}
PROPOSALS['admin-categories'] = { title: PC, rows: function () {
  const searchRows = [[0, 'Pantry', '412', true], [1, 'Rice and grains', '138', true], [2, 'Rice', '96', true], [3, 'Basmati rice', '41', null, { selected: true }], [3, 'Jasmine rice', '0', null, { hidden: true }], [3, 'Brown rice', '14', null], [1, 'Dates and dried fruit', '123', true], [2, 'Rice paper and noodles', '8', null]];
  const newRows = PC_TREE.slice(0, 6).concat([[3, 'Sella rice', '0', null, { hidden: true, isNew: true }]], PC_TREE.slice(6));
  const parentRows = PC_TREE.map(function (r) { return r[1] === 'Rice' ? [2, 'Rice', '96', true, { selected: true, direct: '9' }] : (r[1] === 'Basmati rice' ? [3, 'Basmati rice', '41', null] : r); });
  const ready = inst('InfoBanner', { Tone: 'Attention', Title: 'Hidden until you show it', Body: 'Buyers don’t see Sella rice yet. Add an image and a meta description, then select Show.', 'Show action': false }, { name: 'new-hidden', sizeH: 'FILL' });
  const missRows = [[0, 'Pantry', '412', true], [1, 'Rice and grains', '138', true], [2, 'Rice', '96', true, { missing: 'Arabic' }], [3, 'Basmati rice', '41', null, { selected: true, missing: 'Arabic' }], [3, 'Brown rice', '14', null, { missing: 'Arabic' }], [1, 'Oils and ghee', '64', true], [2, 'Ghee', '22', null, { missing: 'Arabic' }], [0, 'Ramadan specials', '31', false, { notInMenu: true, missing: 'Arabic' }]];
  const L = [[pcScreen('Language · Persian', { panel: { body: pcDetails({ lang: 'fa' }) } }),
    pcScreen('Language · Persian name missing', { panel: { body: pcDetails({ lang: 'fa', missing: ['fa', 'ar'], errLang: 'fa', text: { name: '' }, nameError: 'Add the Persian name. Persian is live for customers.', unsaved: '1 needs fixing' }) } }),
    pcScreen('Language · Missing Arabic filter', { tree: { rows: missRows, langFilter: 'Missing: Arabic (12)', note: '12 categories have no Arabic name. Arabic is a draft, so buyers aren’t affected yet.', foot: 'Parents without the filter match are shown for context.' }, panel: { body: pcDetails({ lang: 'ar' }) } })]];
  return L.concat([[pcScreen('Default, Details'), pcScreen('SEO', { panel: { tab: 'SEO', body: pcSeo() } }), pcScreen('Attribute links', { panel: { tab: 'Attributes', body: pcFilters() } })],
    [pcScreen('Products', { panel: { tab: 'Products', body: pcProducts() } }), pcScreen('History', { panel: { tab: 'History', body: pcHistory() } }), pcScreen('Search', { tree: { rows: searchRows, query: 'rice', match: 'Rice', note: '6 categories match "rice". Their parents are shown in grey context.', foot: 'Matches stay in the tree so their place is clear.' } })],
    [pcScreen('New category, Hidden', { tree: { rows: newRows, selected: 'Sella rice' }, panel: { name: 'Sella rice', slug: 'sella-rice', hidden: true, leafFull: true, products: '0 live · 0 offers', desc: '', noImage: true, keywords: 'sella, parboiled', banner: ready } }),
      pcScreen('Category with subcategories', { tree: { rows: parentRows, selected: 'Rice' }, panel: { name: 'Rice', slug: 'rice', path: 'Pantry › Rice and grains', products: '96 live · 9 directly on Rice', banner: inst('InfoBanner', { Tone: 'Info', Title: '9 products sit directly on Rice', Body: 'Buyers find them under "Other Rice" in the filter. In the product form, sellers see the subcategories first and Rice as "General".', 'Show action': true, Action: 'Move products…' }, { name: 'direct-products', sizeH: 'FILL' }) } }),
      pcScreen('View only', { viewOnly: true, banner: inst('InfoBanner', { Tone: 'Info', Title: 'View only', Body: 'Your role can’t change categories. A Platform Administrator can give you access.', 'Show action': false }, { name: 'view-only', sizeH: 'FILL' }), panel: { viewOnly: true } })],
    [pcDialogsA(), pcDialogsB(), pcStates()]]);
} };

// ── Admin · Catalog · Attributes (attributes management plan v2, sections 16 and 17; decisions 1 to 12 of 30 Oct 2026)
const PA = 'Proposal · Admin · Catalog · Attributes';
function paTag(n) { n.setPluginData('proposal', 'admin-attributes'); return n; }
function paRadio(on, label, desc, kids) {
  const dot = frame({ name: 'radio', dir: 'H', w: 18, h: 18, align: 'center', justify: 'center', radius: 'radius/pill', stroke: on ? 'action/primary' : 'border/input', fill: 'bg/surface' }, on ? [frame({ name: 'dot', w: 8, h: 8, radius: 'radius/pill', fill: 'action/primary' })] : []);
  return frame({ name: 'option · ' + label, dir: 'H', gap: 'space/3', align: 'start', pad: 'space/3', stroke: on ? 'action/primary' : 'border/default', fill: on ? 'bg/selected' : null, radius: 'radius/control', sizeH: 'FILL' }, [dot,
    frame({ name: 'text', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(label, 'Body/Strong'), desc ? text(desc, 'Body/Small', 'text/muted', { sizeH: 'FILL' }) : null].concat(kids || []))]);
}
function paSave(o) {
  o = o || {};
  return frame({ name: 'save', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [o.note ? text(o.note, 'Body/Small', o.err ? 'status/critical/fg' : 'text/muted') : null, pcSp(), btn('Discard', 'Secondary', 'Sm', { State: o.note ? 'Default' : 'Disabled' }), btn(o.primary || 'Save changes', 'Primary', 'Sm', { State: o.primaryOn ? 'Default' : 'Disabled' })]);
}
function paLock(label, value, link) { return pcValue(label, frame({ name: 'locked', dir: 'H', gap: 'space/1-5', align: 'center' }, [text(value, 'Body/Default', 'text/primary'), icon('lock', 'icon/muted', 14)]), link || null); }
function paCheck(label, desc, on, st) { return inst('CheckboxRow', { Value: on ? 'Checked' : 'Unchecked', State: st || 'Default', Label: label, Description: desc }, { name: label, sizeH: 'FILL' }); }
// The list: [name, code, type, products, feature sets, languages, badges]
const PA_ROWS = [
  ['Net weight', 'net-weight', 'Number with unit', '1,204', '6', 'All', ['Material']], ['Country of origin', 'country-of-origin', 'Single choice', '1,180', '6', 'All', []],
  ['Pack size', 'pack-size', 'Single choice', '412', '3', 'Missing ar', ['Variant']], ['Grain length', 'grain-length', 'Single choice', '138', '1', 'Missing ar', []],
  ['Ingredients', 'ingredients', 'Long text', '1,022', '5', 'All', ['Material']], ['Storage', 'storage', 'Long text', '96', '2', 'Missing ar', []],
  ['Contains nuts', 'contains-nuts', 'Yes / No', '640', '4', 'All', ['Material']], ['Pieces per pack', 'pieces-per-pack', 'Number', '58', '2', 'Missing ar', []],
  ['Diet', 'diet', 'Multiple choice', '311', '4', 'Missing ar', []], ['Flavour', 'flavour', 'Single choice', '0', '0', 'Missing fa, ar', ['Draft']],
  ['Variety', 'variety', 'Text', '204', '2', 'All', ['Archived']],
];
function paBadge(b) { return b === 'Material' ? bdg('Attention', 'Icon', 'Material', 'shield-check') : (b === 'Variant' ? bdg('Info', 'None', 'Variant') : (b === 'Draft' ? bdg('Neutral', 'Dot', 'Draft') : bdg('Neutral', 'None', 'Archived'))); }
function paList(o) {
  o = o || {};
  const rows = (o.rows || PA_ROWS).filter(function (r) { return o.showArchived || r[6].indexOf('Archived') < 0; });
  const tools = frame({ name: 'list tools', dir: 'H', gap: 'space/2', align: 'center', pad: [12, 16, 12, 16], wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, [
    inst('Input', { Type: 'Text', State: o.query ? 'Filled' : 'Default', Value: o.query || 'Search name or code', 'Leading icon': true }, { name: 'search', w: 220 }),
    inst('Select', { State: 'Filled', Value: 'Type: ' + (o.type || 'All') }, { name: 'type', w: 130 }), inst('Select', { State: 'Filled', Value: 'Status: ' + (o.status || 'Active, draft') }, { name: 'status', w: 170 }),
    inst('Select', { State: 'Filled', Value: o.lang || 'Language: All' }, { name: 'language', w: 160 })]);
  const head = headerRow([['Attribute', 'fill'], ['Type', 140], ['Products', 90], ['Languages', 110]]);
  const kids = [tools, head].concat(rows.map(function (r) {
    const on = r[0] === (o.selected || 'Net weight');
    const name = frame({ name: 'name', dir: 'V', sizeH: 'FILL' }, [frame({ name: 'name-row', dir: 'H', gap: 'space/1-5', align: 'center' }, [text(r[0], on ? 'Body/Strong' : 'Body/Default')].concat(r[6].map(paBadge))), text(r[1], 'Caption/Default', 'text/muted')]);
    const lang = r[5] === 'All' ? text('All', 'Body/Small', 'text/muted') : bdg('Attention', 'None', r[5]);
    return row([[name, 'fill'], [text(r[2], 'Body/Small'), 140], [text(r[3], 'Body/Small', 'text/muted'), 90], [lang, 110]], on, false, 56);
  }));
  kids.push(frame({ name: 'list foot', dir: 'H', pad: [12, 16, 12, 16], sizeH: 'FILL' }, [text(o.foot || '24 attributes · 1 archived hidden · Languages counts English, فارسی and العربية', 'Caption/Default', 'text/muted')]));
  return card('Attribute list', kids);
}
const PA_SUBTABS = ['Details', 'Values', 'Used in', 'History'];
function paPanel(o) {
  o = o || {};
  const dis = o.viewOnly ? 'Disabled' : 'Default';
  const badges = (o.badges || ['Material']).map(paBadge);
  const status = o.draft ? bdg('Neutral', 'Dot', 'Draft') : bdg('Success', 'Dot', 'Active');
  const head = frame({ name: 'panel head', dir: 'V', gap: 'space/1', pad: [20, 20, 0, 20], sizeH: 'FILL' }, [
    frame({ name: 'title', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(o.name || 'Net weight', 'Heading/H2'), status].concat(badges, [pcSp(), o.draft ? btn('Publish', 'Primary', 'Sm', { State: o.canPublish ? 'Default' : 'Disabled' }) : null])),
    text((o.code || 'net-weight') + ' · ' + (o.type || 'Number with unit'), 'Body/Small', 'text/muted'),
    frame({ name: 'tabs-wrap', dir: 'V', pad: ['space/3', 0, 0, 0], sizeH: 'FILL' }, [tabsBar(PA_SUBTABS.map(function (t) { return [t, null, t === (o.tab || 'Details')]; }))])]);
  const body = frame({ name: 'panel body', dir: 'V', gap: 'space/4', pad: 20, sizeH: 'FILL' }, (o.banner ? [o.banner] : []).concat(o.body || paDetails(o)));
  const acts = frame({ name: 'panel actions', dir: 'H', gap: 'space/2', align: 'center', pad: [12, 20, 16, 20], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, o.draft ? [pcSp(), btn('Discard draft', 'Ghost', 'Sm', { State: dis })] : [
    btn('Merge…', 'Secondary', 'Sm', { State: o.locked ? 'Disabled' : dis }), btn('Convert type…', 'Secondary', 'Sm', { State: o.locked ? 'Disabled' : dis }), pcSp(), btn('Archive…', 'Ghost', 'Sm', { State: o.locked ? 'Disabled' : dis })]);
  return card('Attribute details', [head, body, acts], { w: 540, sizeH: null });
}
function paLangBlock(o, fields) {
  const lang = o.lang || 'en', L = PC_LANGS.filter(function (l) { return l[0] === lang; })[0];
  return frame({ name: 'language text', dir: 'V', gap: 'space/4', pad: 'space/4', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [
    frame({ name: 'language head', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [pcLangTabs(lang, o.missing || ['ar'], o.errLang), text(L[2] + ' · ' + L[3] + (lang !== 'en' ? ' · right to left' : ''), 'Caption/Default', 'text/muted')])].concat(fields));
}
function paDetails(o) {
  const dis = o.viewOnly ? 'Disabled' : null, cd = o.viewOnly ? 'Disabled' : 'Default';
  const lang = o.lang || 'en';
  const tx = { en: ['Net weight', 'Weight of the food without packaging.'], fa: ['وزن خالص', 'وزن خوراکی بدون بسته‌بندی.'], ar: ['', ''] }[lang];
  const name = lang === 'en' ? pcIn(tx[0], dis) : pcRtl(tx[0], dis, { ph: 'Name in Arabic' });
  const help = lang === 'en' ? pcIn(tx[1], dis) : pcRtl(tx[1], dis, { ph: 'Help text in Arabic' });
  return [paLangBlock(o, [pcField('Name', name, '1 to 120 characters. Sellers and buyers see it.'), pcField('Help text', help, 'One sentence under the field in the seller form.'),
      lang === 'en' ? pcField('Unit labels', frame({ name: 'unit labels', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [pcIn('g', dis), pcIn('kg', dis)])) : pcField('Unit labels', frame({ name: 'unit labels', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [pcRtl(lang === 'fa' ? 'گرم' : '', dis, { ph: 'g' }), pcRtl(lang === 'fa' ? 'کیلوگرم' : '', dis, { ph: 'kg' })]))]),
    text('Settings', 'Caption/Strong', 'text/muted'),
    paLock('Code', 'net-weight'), paLock('Type', 'Number with unit', ppLink('Convert type…', null, 'convert')), paLock('Measures', 'Mass, stored in grams'),
    frame({ name: 'unit row', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [pcField('Units sellers can use', inst('Select', { State: o.viewOnly ? 'Disabled' : 'Filled', Value: 'g, kg' }, { name: 'units', sizeH: 'FILL' })), pcField('Shown in', inst('Select', { State: o.viewOnly ? 'Disabled' : 'Filled', Value: 'g' }, { name: 'default unit', w: 110 }))]),
    frame({ name: 'limits', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [pcField('Smallest', pcIn('1 g', dis)), pcField('Largest', pcIn('50 kg', dis)), pcField('Decimals', pcIn('0', dis))]),
    text('Where it shows', 'Caption/Strong', 'text/muted'),
    paCheck('Can be a filter', 'A range filter. Each category chooses whether to show it.', true, cd), paCheck('Show on the product page', 'In the Specifications table.', true, cd), paCheck('Searchable', 'Buyers can find products by this value.', false, cd),
    paCheck('Material', 'Buyers rely on it. Changes recheck certificates. Turning it off needs a second admin.', true, cd),
    pcField('Internal note', pcTa('Unit price is worked out from this value in pricing.', dis), 'Admins only.'),
    paSave(o.save)];
}
function paValues() {
  const vals = [['250 g', '۲۵۰ گرم', '', '96', '250 g'], ['500 g', '۵۰۰ گرم', '', '141', '500 g'], ['1 kg', '۱ کیلوگرم', '١ كغ', '122', '1,000 g'], ['5 kg', '۵ کیلوگرم', '', '41', '5,000 g'], ['10 kg', '۱۰ کیلوگرم', '', '12', '10,000 g', 'Inactive'], ['1000 g', '۱۰۰۰ گرم', '', '0', '1,000 g', 'Merged into 1 kg']];
  const head = headerRow([['Value · English', 'fill'], ['فارسی', 100], ['العربية', 90], ['Products', 80], ['', 44]]);
  const rows = vals.map(function (v) {
    const st = v[5];
    const name = frame({ name: 'value', dir: 'V', sizeH: 'FILL' }, [frame({ name: 'name-row', dir: 'H', gap: 'space/1-5', align: 'center' }, [text(v[0], 'Body/Default', st ? 'text/muted' : 'text/primary'), st ? bdg('Neutral', 'None', st) : null]), text('Net weight ' + v[4], 'Caption/Default', 'text/muted')]);
    const ar = v[2] ? text(v[2], 'Body/Small', 'text/primary', { align: 'right', sizeH: 'FILL' }) : text('Missing', 'Caption/Default', 'status/attention/fg');
    return row([[name, 'fill'], [text(v[1], 'Body/Small', 'text/primary', { align: 'right', sizeH: 'FILL' }), 100], [ar, 90], [text(v[3], 'Body/Small', 'text/muted'), 80], [rowAction(), 44, { justify: 'center' }]], false, false, 56);
  });
  return [frame({ name: 'values tools', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [inst('Select', { State: 'Filled', Value: 'Order: Manual (drag rows)' }, { name: 'order', w: 220 }), pcSp(), btn('Merge values…', 'Secondary', 'Sm'), btn('Add value', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'plus' } })]),
    card('values', [head].concat(rows)),
    text('Type each language in its own column. Values in use can’t be deleted, only made inactive: products keep them and stay in the filter. A merged value counts under its target.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' }),
    inst('InfoBanner', { Tone: 'Info', Title: 'Variant attribute', Body: '412 live sizes use Pack size. It can’t be archived, merged or converted. A product can have 2 variant attributes at most.', 'Show action': false }, { name: 'variant', sizeH: 'FILL' })];
}
function paUsedIn() {
  const line = function (a, b, c) { return frame({ name: 'used · ' + a, dir: 'H', gap: 'space/2', align: 'center', pad: [10, 12, 10, 12], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(a, 'Body/Default', 'text/primary', { sizeH: 'FILL' }), b ? bdg(b === 'Required' ? 'Info' : 'Neutral', 'None', b) : null, c ? text(c, 'Caption/Default', 'text/muted') : null]); };
  const tile = function (l, v) { return frame({ name: 'tile · ' + l, dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text(l, 'Caption/Default', 'text/muted'), text(v, 'Heading/H2')]); };
  return [frame({ name: 'tiles', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [tile('Live products', '1,204'), tile('Drafts', '37'), tile('Feature sets', '6'), tile('Filters', '9')]),
    text('Feature sets', 'Caption/Strong', 'text/muted'), card('sets', [line('Core (every feature set)', 'Required', 'Core group')]),
    text('Categories that show it as a filter', 'Caption/Strong', 'text/muted'), card('filters', [line('Rice', null, 'Filter 3 of 5'), line('Basmati rice', null, 'Inherited from Rice'), line('Flour', null, 'Filter 2 of 4'), line('Ghee', null, 'Filter 1 of 3')]),
    ppLink('Open the 1,204 products in Products', 'external-link', 'open-products')];
}
function paScreen(state, o) {
  o = o || {};
  const view = o.viewOnly;
  const head = pageTitle('Attributes', 'What sellers fill in for each kind of product in the Australia market', [btn('Import', 'Secondary', 'Md', { State: view ? 'Disabled' : 'Default', 'Leading icon': true, Icon: { icon: 'file' } }), btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), primaryHeaderButton(o.cta || 'Add attribute', view ? 'Disabled' : 'Default')]);
  const tabs = tabsBar([['Attributes', '24', (o.tab || 'Attributes') === 'Attributes'], ['Feature sets', '6', o.tab === 'Feature sets'], ['Brands', '312', o.tab === 'Brands'], ['Waiting for you', '3', o.tab === 'Waiting for you']]);
  const layout = o.full ? o.full : frame({ name: 'Attributes layout', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [o.left || paList(o.list), o.right || paPanel(o.panel)]);
  const kids = [head, tabs].concat(o.banner ? [o.banner] : [], [layout]);
  const scr = screen(PA + ' · ' + state, 'Admin', 'nav-catalogue', o.crumb || 'Catalog / Attributes', kids, { minH: PANEL_MIN_H, gap: 'space/4' });
  return paTag(scr);
}
// Feature sets: the list of sets and the editor of one set (groups, Required / Recommended / Optional, order).
function paSetRow(name, type, req, o) {
  o = o || {};
  return frame({ name: 'set attr · ' + name, dir: 'H', gap: 'space/2', align: 'center', pad: [8, 12, 8, 12], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [
    o.locked ? icon('lock', 'icon/muted', 14) : icon('menu', 'icon/muted', 14),
    frame({ name: 'label', dir: 'V', sizeH: 'FILL' }, [frame({ name: 'name-row', dir: 'H', gap: 'space/1-5', align: 'center' }, [text(name, 'Body/Default'), o.variant ? bdg('Info', 'None', 'Variant') : null]), text(type, 'Caption/Default', 'text/muted')]),
    o.locked ? text(req, 'Body/Small', 'text/muted') : inst('Select', { State: 'Filled', Value: req }, { name: 'requirement', w: 150 }),
    o.locked ? null : inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'remove' })]);
}
function paSetGroup(title, sub, rows, locked) {
  return card('group · ' + title, [frame({ name: 'group head', dir: 'H', gap: 'space/2', align: 'center', pad: [10, 12, 10, 12], fill: 'bg/subtle', sizeH: 'FILL' }, [text(title, 'Body/Strong'), sub ? text(sub, 'Caption/Default', 'text/muted') : null, pcSp(), locked ? null : ppLink('Add attribute', 'plus', 'add-to-group')])].concat(rows));
}
function paFeatureSets() {
  const sets = [['Rice and grains', '3 categories', '138'], ['Packaged food', '14 categories', '820'], ['Fresh meat', '6 categories', '205'], ['Dairy and eggs', '5 categories', '96'], ['Bakery', '4 categories', '58'], ['Spices', '0 categories', '0']];
  const head = headerRow([['Feature set', 'fill'], ['Products', 90]]);
  const list = card('Feature set list', [head].concat(sets.map(function (x, i) { return row([[twoLine(x[0], x[1], i === 0 ? 'Body/Strong' : 'Body/Default'), 'fill'], [text(x[2], 'Body/Small', 'text/muted'), 90]], i === 0, false, 56); }), [
    frame({ name: 'list foot', dir: 'H', pad: [12, 16, 12, 16], sizeH: 'FILL' }, [btn('Add feature set', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'plus' } })])]), { w: 360, sizeH: null });
  const editor = card('Feature set editor', [frame({ name: 'editor body', dir: 'V', gap: 'space/4', pad: 20, sizeH: 'FILL' }, [
    frame({ name: 'title', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text('Rice and grains', 'Heading/H2'), bdg('Success', 'Dot', 'Active'), pcSp(), btn('Seller form preview', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'eye' } })]),
    text('Used by Basmati rice, Jasmine rice and Brown rice · 138 products', 'Body/Small', 'text/muted'),
    frame({ name: 'names', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [pcField('Name · English', pcIn('Rice and grains')), pcField('Name · فارسی', pcRtl('برنج و غلات')), pcField('Name · العربية', pcRtl('', null, { ph: 'Missing' }))]),
    inst('InfoBanner', { Tone: 'Attention', Title: '14 live products are missing required details', Body: 'Grain length became required on 29 Oct. They stay on sale; sellers must fill it in before their next change is accepted.', 'Show action': true, Action: 'View report' }, { name: 'missing', sizeH: 'FILL' }),
    paSetGroup('Core', 'Shared by every feature set. Edit it once in Settings.', [paSetRow('Brand', 'Brand', 'Required', { locked: true }), paSetRow('Country of origin', 'Single choice', 'Required', { locked: true }), paSetRow('Net weight', 'Number with unit', 'Required', { locked: true })], true),
    paSetGroup('Rice details', null, [paSetRow('Pack size', 'Single choice', 'Required', { variant: true }), paSetRow('Grain length', 'Single choice', 'Required'), paSetRow('Variety', 'Text', 'Recommended'), paSetRow('Cooking time', 'Number with unit', 'Optional')]),
    paSetGroup('Storage', null, [paSetRow('Storage', 'Long text', 'Optional')]),
    frame({ name: 'set links', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [btn('Add group', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'plus' } }), text('Recommended counts toward the completeness score but doesn’t block a submit.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]),
    paSave({ note: '1 unsaved change', primaryOn: true })])]);
  return frame({ name: 'Feature sets layout', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [list, editor]);
}
function paBrands() {
  const brands = [['Tilda', 'tilda', 'تیلدا, تيلدا', 'United Kingdom', '41', 'Active'], ['Tilda Rice', 'tilda-rice', '', '—', '3', 'Possible duplicate'], ['Al Wazir', 'al-wazir', 'الوزير', 'Lebanon', '18', 'Active'], ['Kuraby Fresh', 'kuraby-fresh', '', 'Australia', '64', 'Active'], ['Sunrice', 'sunrice', '', 'Australia', '29', 'Active'], ['Golden Grain', 'golden-grain', '', '—', '0', 'Draft']];
  const head = headerRow([['Brand', 'fill'], ['Aliases', 130], ['Products', 90], ['Status', 150]]);
  const list = card('Brand list', [frame({ name: 'list tools', dir: 'H', gap: 'space/2', align: 'center', pad: [12, 16, 12, 16], sizeH: 'FILL' }, [inst('Input', { Type: 'Text', State: 'Default', Value: 'Search brands and aliases', 'Leading icon': true }, { name: 'search', sizeH: 'FILL' }), inst('Select', { State: 'Filled', Value: 'Status: All' }, { name: 'status', w: 150 })]), head].concat(brands.map(function (b, i) {
    const st = b[5] === 'Active' ? bdg('Success', 'Dot', 'Active') : (b[5] === 'Draft' ? bdg('Neutral', 'Dot', 'Draft') : bdg('Attention', 'None', 'Possible duplicate'));
    return row([[twoLine(b[0], b[1], i === 0 ? 'Body/Strong' : 'Body/Default'), 'fill'], [text(b[2] || '—', 'Body/Small', 'text/muted', { truncate: true, w: 110 }), 130], [text(b[4], 'Body/Small', 'text/muted'), 90], [st, 150]], i === 0, false, 56);
  })));
  const alias = function (lang, v, rtl) { return frame({ name: 'alias · ' + lang, dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(lang, 'Body/Small', 'text/muted', { w: 72 }), rtl ? pcRtl(v) : pcIn(v), inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'remove' })]); };
  const panel = card('Brand details', [frame({ name: 'brand body', dir: 'V', gap: 'space/4', pad: 20, sizeH: 'FILL' }, [
    frame({ name: 'title', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [rect({ name: 'logo', w: 40, h: 40, fill: 'bg/muted', radius: 'radius/control' }), text('Tilda', 'Heading/H2'), bdg('Success', 'Dot', 'Active'), pcSp(), btn('Hide', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'eye-off' } })]),
    inst('InfoBanner', { Tone: 'Attention', Title: '"Tilda Rice" looks like the same brand', Body: '3 products. Merging makes "Tilda Rice" an alias of Tilda and moves its products.', 'Show action': true, Action: 'Merge…' }, { name: 'duplicate', sizeH: 'FILL' }),
    pcField('Name', pcIn('Tilda'), 'Brand names aren’t translated. Add aliases so buyers find it in their language.'), paLock('URL name', '/brands/tilda'), pcField('Country of origin', inst('Select', { State: 'Filled', Value: 'United Kingdom' }, { name: 'country', sizeH: 'FILL' })),
    text('Aliases for search', 'Caption/Strong', 'text/muted'), alias('فارسی', 'تیلدا', true), alias('العربية', 'تيلدا', true), alias('English', 'Tilda basmati'), ppLink('Add alias', 'plus', 'add-alias'),
    pcField('Summary', pcTa('Basmati rice brand founded in 1970, milling in Essex.')), pcValue('Products', text('41 live', 'Body/Default'), ppLink('Open in Products', 'external-link')),
    paSave()])], { w: 480, sizeH: null });
  return frame({ name: 'Brands layout', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [list, panel]);
}
function paWaiting() {
  const items = [['Value suggestion', 'Flavour: "Saffron"', 'Kuraby Fresh · Saffron basmati rice 1 kg', '2 h ago', true], ['Brand suggestion', 'Brand: "Golden Grain"', 'Logan Halal Grocer · Golden Grain jasmine 5 kg', '5 h ago'], ['Material change', 'Turn off Material for Storage', 'Requested by Omar H. · needs a second admin', '1 day ago']];
  const list = card('Waiting list', [frame({ name: 'list tools', dir: 'H', gap: 'space/2', align: 'center', pad: [12, 16, 12, 16], sizeH: 'FILL' }, [inst('Select', { State: 'Filled', Value: 'Kind: All' }, { name: 'kind', w: 170 }), pcSp(), text('Oldest first', 'Body/Small', 'text/muted')])].concat(items.map(function (it) {
    return frame({ name: 'request · ' + it[1], dir: 'V', gap: 'space/1', pad: [12, 16, 12, 16], fill: it[4] ? 'bg/row-selected' : null, stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [
      frame({ name: 'kind', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [bdg(it[0] === 'Material change' ? 'Attention' : 'Info', 'None', it[0]), pcSp(), text(it[3], 'Caption/Default', 'text/muted')]),
      text(it[1], 'Body/Strong'), text(it[2], 'Body/Small', 'text/muted', { sizeH: 'FILL' })]);
  })));
  const decide = card('Decision', [frame({ name: 'decision body', dir: 'V', gap: 'space/4', pad: 20, sizeH: 'FILL' }, [
    text('Flavour: "Saffron"', 'Heading/H2'), text('Suggested by Kuraby Fresh for Saffron basmati rice 1 kg. The product can be submitted meanwhile; Flavour stays empty until you decide.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    paRadio(true, 'Add as a new value', 'Sellers can choose it right away.', [frame({ name: 'names', dir: 'V', gap: 'space/2', pad: ['space/2', 0, 0, 0], sizeH: 'FILL' }, [pcField('English', pcIn('Saffron')), pcField('فارسی · required', pcRtl('زعفرانی')), pcField('العربية · optional', pcRtl('', null, { ph: 'Missing' }))])]),
    paRadio(false, 'Use an existing value', 'The seller gets an email with the value you chose.'),
    paRadio(false, 'Reject', 'Tell the seller why. They can suggest again.'),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, [btn('Add value', 'Primary', 'Sm')])])], { w: 480, sizeH: null });
  return frame({ name: 'Waiting layout', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [list, decide]);
}
function paMissingReport() {
  const head = headerRow([['Product', 'fill'], ['Seller', 180], ['Missing', 180], ['Live since', 120]]);
  const rows = [['Basmati rice 5 kg', 'Kuraby Fresh', 'Grain length'], ['Aged basmati rice 10 kg', 'Logan Halal Grocer', 'Grain length'], ['Brown basmati rice 2 kg', 'Kuraby Fresh', 'Grain length'], ['Jasmine rice 5 kg', 'Sunnybank Pantry', 'Grain length, Pack size']].map(function (r) { return row([[text(r[0], 'Body/Default'), 'fill'], [text(r[1], 'Body/Small'), 180], [bdg('Attention', 'None', r[2]), 180], [text('12 Oct 2026', 'Body/Small', 'text/muted'), 120]], false, false, 52); });
  const kids = [pageTitle('Products missing required details', '14 live products in the Australia market · they stay on sale', [btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), btn('Email sellers', 'Primary', 'Md', { 'Leading icon': true, Icon: { icon: 'mail' } })]),
    frame({ name: 'filters', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [inst('Select', { State: 'Filled', Value: 'Feature set: Rice and grains' }, { name: 'set', w: 260 }), inst('Select', { State: 'Filled', Value: 'Category: All' }, { name: 'category', w: 200 }), inst('Select', { State: 'Filled', Value: 'Attribute: All' }, { name: 'attribute', w: 200 })]),
    inst('InfoBanner', { Tone: 'Info', Title: 'Sellers fill these in on their next change', Body: 'A submit without them is refused. Email sellers sends each seller one summary of their products.', 'Show action': false }, { name: 'how', sizeH: 'FILL' }),
    card('report', [head].concat(rows, [inst('Pagination', { Range: '1–4 of 14 products' }, { name: 'Pagination', sizeH: 'FILL' })]))];
  return paTag(screen(PA + ' · Missing required details report', 'Admin', 'nav-catalogue', 'Catalog / Attributes / Missing required details', kids, { minH: PANEL_MIN_H, gap: 'space/4' }));
}
// Dialogs
function paTypeCard(name, ex, on, isNew) {
  return frame({ name: 'type · ' + name, dir: 'V', gap: 'space/1', pad: 'space/3', w: 196, stroke: on ? 'action/primary' : 'border/default', fill: on ? 'bg/selected' : 'bg/surface', radius: 'radius/control' }, [
    frame({ name: 'type head', dir: 'H', gap: 'space/1-5', align: 'center', sizeH: 'FILL' }, [text(name, 'Body/Strong'), isNew ? bdg('Info', 'None', 'New') : null]), text(ex, 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]);
}
function paDialogsA() {
  const types = [['Text', 'Variety: Sella'], ['Long text', 'Storage instructions'], ['Number with unit', 'Net weight: 500 g', true, true], ['Number', 'Pieces per pack: 12'], ['Yes / No', 'Contains nuts: Yes'], ['Date', 'Harvest date'], ['Single choice', 'Country of origin: India'], ['Multiple choice', 'Diet: Vegetarian, Vegan'], ['Brand', 'From the Brands list']];
  const add1 = pcDialog('Add attribute · 1', 'Add attribute', 'Step 1 of 2 · Choose the type. It can’t be changed later, only converted on a few paths.', [
    frame({ name: 'types', dir: 'H', wrap: true, gap: 'space/2', rowGap: 'space/2', sizeH: 'FILL' }, types.map(function (t) { return paTypeCard(t[0], t[1], t[2], t[3]); }))], 'Next', { w: 660 });
  const add2 = pcDialog('Add attribute · 2', 'Add attribute: Number with unit', 'Step 2 of 2 · It starts as a Draft. Sellers don’t see it until you publish.', [
    pcField('Name · English', pcIn('Cooking time')), pcField('Code', pcIn('cooking-time'), 'Lowercase letters and hyphens. Can’t be changed later.'),
    pcField('Measures', inst('Select', { State: 'Filled', Value: 'Time' }, { name: 'dimension', sizeH: 'FILL' }), 'Mass, volume, length, count or time. The Market’s unit list.'),
    frame({ name: 'units', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [pcField('Units sellers can use', inst('Select', { State: 'Filled', Value: 'min, h' }, { name: 'units', sizeH: 'FILL' })), pcField('Shown in', inst('Select', { State: 'Filled', Value: 'min' }, { name: 'default', w: 110 }))]),
    text('Persian and Arabic names are added on the Details tab before you publish.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })], 'Create draft', { w: 560 });
  const mergeV = pcDialog('Merge values', 'Merge values of Pack size', 'Products keep their saved value; the shop, filters and search count it under the target. The next change a seller makes saves the target.', [
    pcField('Merge', inst('Select', { State: 'Filled', Value: '1000 g' }, { name: 'from', sizeH: 'FILL' })), pcField('Into', inst('Select', { State: 'Filled', Value: '1 kg' }, { name: 'into', sizeH: 'FILL' })),
    pcImpact([['Live products with 1000 g', '18'], ['Live sizes (variants) that show it', '18'], ['Filter options merged', '1']]), pcReason()], 'Merge values', { w: 560 });
  const archive = pcDialog('Archive attribute', 'Archive Storage?', 'It leaves the seller form, filters and product pages. Old product revisions keep their values. Archive is final.', [
    pcImpact([['Feature sets that use it', '0'], ['Live products with a value', '96'], ['Material', 'No']]), pcReason()], 'Archive attribute', { destructive: true, focusCancel: true });
  return paTag(pcScene(PA + ' · Dialogs · Add, Merge, Archive', [add1, add2, mergeV, archive]));
}
function paStep(steps, active) {
  return frame({ name: 'steps', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, steps.map(function (s, i) {
    return frame({ name: 'step · ' + s, dir: 'H', gap: 'space/1-5', align: 'center', pad: [6, 10, 6, 10], fill: i === active ? 'bg/selected' : null, radius: 'radius/pill' }, [text(String(i + 1), 'Caption/Strong', i <= active ? 'text/link' : 'text/muted'), text(s, i === active ? 'Body/Strong' : 'Body/Small', i <= active ? 'text/primary' : 'text/muted')]);
  }));
}
function paDialogsB() {
  const steps = ['Target type', 'Map values', 'Check impact'];
  const c1 = pcDialog('Convert · 1', 'Convert Variety to another type', 'A new attribute replaces the old one. Allowed from Text: Single choice or Brand.', [paStep(steps, 0),
    paRadio(true, 'Single choice', 'Each different text becomes a value, or maps to one.'), paRadio(false, 'Brand', 'Each text maps to a brand in the Brands list.'),
    text('Other types aren’t allowed from Text. Create a new attribute instead.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })], 'Next', { w: 560 });
  const map = [['Sella', '61', 'Sella (new value)'], ['sella', '12', 'Sella'], ['Parboiled', '18', 'Sella'], ['1121', '40', '1121 (new value)'], ['extra long', '3', 'Not mapped']];
  const c2 = pcDialog('Convert · 2', 'Map the 37 different texts', 'Values left unmapped become empty and are listed in the report.', [paStep(steps, 1),
    card('mapping', [headerRow([['Text now', 'fill'], ['Products', 90], ['Becomes', 200]])].concat(map.map(function (m) { return row([[text('"' + m[0] + '"', 'Body/Default'), 'fill'], [text(m[1], 'Body/Small', 'text/muted'), 90], [inst('Select', { State: 'Filled', Value: m[2] }, { name: 'target', w: 180 }), 200]], false, m[2] === 'Not mapped', 52); }))),
    text('Showing 5 of 37 · 3 products will lose their value', 'Caption/Default', 'status/attention/fg')], 'Next', { w: 620 });
  const c3 = pcDialog('Convert · 3', 'Check the impact', 'Live products keep selling. The shop shows the mapped value right away; sellers confirm it on their next change.', [paStep(steps, 2),
    pcImpact([['Live products converted', '201'], ['Left empty (not mapped)', '3', true], ['Feature sets switched to the new attribute', '2'], ['Search rebuilt in the background', 'Yes']]), pcReason()], 'Convert', { w: 560 });
  const imp = pcDialog('Import attributes', 'Check attributes-oct.xlsx', 'Step 2 of 3 · Nothing has changed yet. Rows match by code. Each language has its own columns: name[en-AU], name[fa-AU], name[ar-AU].', [
    frame({ name: 'tiles', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [['New', '4'], ['Renamed', '9'], ['Unchanged', '211'], ['Errors', '1']].map(function (t) { return frame({ name: 'tile · ' + t[0], dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text(t[0], 'Caption/Default', 'text/muted'), text(t[1], 'Heading/H2', t[0] === 'Errors' ? 'status/critical/fg' : 'text/primary')]); })),
    inst('InfoBanner', { Tone: 'Critical', Title: 'Row 12: add the Persian name', Body: 'Persian is live for customers, so name[fa-AU] is required. An empty Arabic cell is fine: Arabic is a draft.', 'Show action': false }, { name: 'error', sizeH: 'FILL' }),
    inst('CheckboxRow', { Value: 'Checked', State: 'Default', Label: 'Skip the row with an error', Description: 'Type, code and Localizable never change from a file. Merge, Convert and Archive are on the page only.' }, { name: 'skip', sizeH: 'FILL' })], 'Import 13 changes', { w: 620 });
  return paTag(pcScene(PA + ' · Dialogs · Convert, Import', [c1, c2, c3, imp]));
}
function paStates() {
  const empty = inst('EmptyState', { Size: 'Card', Title: 'No attributes yet', Body: 'Add one or import a file.', Icon: { icon: 'sliders' } }, { name: 'empty', sizeH: 'FILL' });
  setNested(empty, 'action', prop('Button', 'Label', 'Add attribute'));
  const nomatch = inst('EmptyState', { Size: 'Card', Title: 'No attributes match', Body: 'Clear the filters to see all.', Icon: { icon: 'search' } }, { name: 'no-match', sizeH: 'FILL' });
  const queue = inst('EmptyState', { Size: 'Card', Title: 'No changes are waiting for you', Body: 'Seller suggestions and material requests show here.', Icon: { icon: 'inbox' } }, { name: 'queue-empty', sizeH: 'FILL' });
  const b = function (n, tone, t, body, act) { return inst('InfoBanner', Object.assign({ Tone: tone, Title: t, Body: body, 'Show action': !!act }, act ? { Action: act } : {}), { name: n, sizeH: 'FILL' }); };
  const field = function (n, v, msg, rtl) { return frame({ name: n, dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [rtl ? pcRtl(v, 'Error') : pcIn(v, 'Error'), text(msg, 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' })]); };
  const scr = frame({ name: PA + ' · States and messages', dir: 'V', w: 900, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Attributes: states and messages', 'Heading/H1'),
    para('Plan section 17. Copy is a draft for Jafar (product designer) and Reza (UI/UX). Page messages are banners above the layout; field rules sit under the field; structural rules sit inside the dialog and turn its primary button off.', 820),
    text('Empty', 'Caption/Strong', 'text/muted'), empty, nomatch, queue,
    b('set-empty', 'Info', 'This feature set has no attributes.', 'Sellers only see the core details.'), b('cat-no-set', 'Info', 'No feature set.', 'Products here use the core details only.'),
    text('Page', 'Caption/Strong', 'text/muted'), b('load-error', 'Critical', 'We couldn’t load attributes.', 'Try again.', 'Try again'), b('stale', 'Attention', 'This attribute changed since you opened it.', 'Reload. Your unsaved changes are kept.', 'Reload'), b('view-only', 'Info', 'View only', 'You can view attributes. Ask a Platform Administrator to change them.'),
    text('Fields', 'Caption/Strong', 'text/muted'), field('code', 'net-weight', 'Another attribute already uses this code.'), field('claim', 'Halal certified', 'This name uses a word that needs a certificate: halal. Choose another word.'),
    field('lang', '', 'Missing in فارسی. Required before فارسی can be published.', true), b('claim-down', 'Critical', 'We can’t check this text right now.', 'Try again in a minute.'),
    text('Publish and values', 'Caption/Strong', 'text/muted'), b('no-values', 'Critical', 'Add at least one value before you publish.', 'Single and multiple choice attributes need values.'), b('in-use', 'Critical', 'Values in use can’t be deleted.', 'Deactivate it instead.', 'Deactivate'), b('inactive', 'Attention', 'This value is no longer offered. Choose another.', 'What a seller sees on their next change.'),
    text('Inside Merge, Convert and Archive', 'Caption/Strong', 'text/muted'), b('archive-sets', 'Critical', 'Remove this attribute from 3 feature sets first.', 'Open Used in to see them.', 'Open Used in'), b('variant', 'Critical', '412 live sizes use this attribute.', 'It can’t be archived, merged or converted.'),
    b('convert-path', 'Critical', 'Multiple choice can’t become Single choice.', 'Create a new attribute instead.'), b('material-two', 'Attention', 'A second admin must approve this', 'Turning off Material waits up to 72 hours in Waiting for you.'), b('counting', 'Info', 'Still counting', 'At least 2,400 products. You can go on: the count finishes in the background.')]);
  tag(scr); return paTag(scr);
}
PROPOSALS['admin-attributes'] = { title: PA, rows: function () {
  const packRows = PA_ROWS.slice();
  const draftBanner = inst('InfoBanner', { Tone: 'Attention', Title: 'Draft: sellers don’t see Flavour', Body: 'Add at least one value before you publish. Missing in فارسی. Required before فارسی can be published.', 'Show action': false }, { name: 'draft', sizeH: 'FILL' });
  return [[paScreen('Default, Details'), paScreen('Details · Persian', { panel: { lang: 'fa', body: paDetails({ lang: 'fa', save: { note: '2 unsaved changes', primaryOn: true } }) } }), paScreen('Values', { list: { selected: 'Pack size', rows: packRows }, panel: { name: 'Pack size', code: 'pack-size', type: 'Single choice', badges: ['Variant'], tab: 'Values', locked: true, body: paValues() } })],
    [paScreen('Used in', { panel: { tab: 'Used in', body: paUsedIn() } }), paScreen('Draft attribute', { list: { selected: 'Flavour' }, panel: { name: 'Flavour', code: 'flavour', type: 'Single choice', badges: [], draft: true, tab: 'Values', banner: draftBanner, body: [inst('EmptyState', { Size: 'Card', Title: 'No values yet', Body: 'Add at least one value before you publish.', Icon: { icon: 'plus' } }, { name: 'no-values', sizeH: 'FILL' }), btn('Add value', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'plus' } })] } }),
      paScreen('Missing Persian filter', { list: { lang: 'Missing: فارسی (1)', rows: PA_ROWS.filter(function (r) { return r[5].indexOf('fa') >= 0; }), selected: 'Flavour', foot: '1 attribute has no Persian name. Persian can’t be published while any is missing.' }, panel: { name: 'Flavour', code: 'flavour', type: 'Single choice', badges: [], draft: true, body: paDetails({ lang: 'fa', missing: ['fa', 'ar'], errLang: 'fa' }) } })],
    [paScreen('Feature sets', { tab: 'Feature sets', cta: 'Add feature set', full: paFeatureSets() }), paScreen('Brands', { tab: 'Brands', cta: 'Add brand', full: paBrands() }), paScreen('Waiting for you', { tab: 'Waiting for you', full: paWaiting() })],
    [paMissingReport(), paScreen('View only', { viewOnly: true, banner: inst('InfoBanner', { Tone: 'Info', Title: 'View only', Body: 'You can view attributes. Ask a Platform Administrator to change them.', 'Show action': false }, { name: 'view-only', sizeH: 'FILL' }), panel: { viewOnly: true } }), paStates()],
    [paDialogsA(), paDialogsB()]];
} };

// ── Catalog · Variants (variants management plan v2, sections 9 to 11 and 16; decisions 1 to 14 of 31 Oct 2026)
const PV = 'Proposal · Catalog · Variants';
function pvTag(n) { n.setPluginData('proposal', 'variants'); return n; }
function pvChip(label, on, check) { return frame({ name: 'chip · ' + label, dir: 'H', gap: 'space/1-5', align: 'center', pad: [6, 12, 6, 12], radius: 'radius/pill', fill: on ? 'bg/selected' : 'bg/surface', stroke: on ? 'action/primary' : 'border/default' }, [check && on ? icon('check', 'text/link', 14) : null, text(label, on ? 'Body/Strong' : 'Body/Small', on ? 'text/link' : 'text/secondary')]); }
function pvSwitch(on) { return inst('Switch', { On: on ? 'True' : 'False', Size: 'Md' }, { name: 'selling' }); }
function pvTick(on, off) { return frame({ name: on ? 'tick on' : 'tick off', dir: 'H', w: 20, h: 20, align: 'center', justify: 'center', radius: 'radius/chip', fill: on ? 'action/primary' : 'bg/surface', stroke: on ? 'action/primary' : (off ? 'border/default' : 'border/input') }, on ? [icon('check', 'text/on-accent', 14)] : []); }
function pvScreen(state, o) {
  o = o || {};
  const head = pageTitle('Variants', 'Sizes, flavours and colours across the Australia market', [btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), btn('Edit in Attributes', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'external-link' } })]);
  const tabs = tabsBar([['Variant types', '4', (o.tab || 'Variant types') === 'Variant types'], ['Variants', '1,284', o.tab === 'Variants'], ['Waiting for you', '6', o.tab === 'Waiting for you']]);
  return pvTag(screen(PV + ' · Admin · ' + state, 'Admin', 'nav-catalogue', 'Catalog / Variants', [head, tabs].concat(o.banner ? [o.banner] : [], [o.body]), { minH: PANEL_MIN_H, gap: 'space/4' }));
}
function pvTypes() {
  const types = [['Pack size', 'Buttons', '18', '412', '1,031', 'ar missing 2'], ['Flavour', 'Buttons', '27', '96', '214', 'ar missing 9'], ['Colour', 'Swatches', '12', '8', '22', 'All'], ['Grind', 'Dropdown', '5', '31', '58', 'All']];
  const head = headerRow([['Variant type', 'fill'], ['Display', 110], ['Options', 80], ['Products', 90], ['Live variants', 110]]);
  const list = card('Variant type list', [head].concat(types.map(function (t, i) { return row([[twoLine(t[0], t[5] === 'All' ? 'All languages' : t[5], i === 0 ? 'Body/Strong' : 'Body/Default'), 'fill'], [text(t[1], 'Body/Small'), 110], [text(t[2], 'Body/Small', 'text/muted'), 80], [text(t[3], 'Body/Small', 'text/muted'), 90], [text(t[4], 'Body/Small', 'text/muted'), 110]], i === 0, false, 56); }), [
    frame({ name: 'foot', dir: 'H', pad: [12, 16, 12, 16], sizeH: 'FILL' }, [text('A variant type is an attribute marked Variant in a feature set. Add one in Attributes.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })])]));
  const opt = function (en, fa, ar, sw, n) { return frame({ name: 'option · ' + en, dir: 'H', gap: 'space/2', align: 'center', pad: [8, 12, 8, 12], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [icon('menu', 'icon/muted', 14), text(en, 'Body/Default', 'text/primary', { w: 80 }), text(fa, 'Body/Small', 'text/secondary', { w: 90, align: 'right' }), ar ? text(ar, 'Body/Small', 'text/secondary', { w: 70, align: 'right' }) : text('Missing', 'Caption/Default', 'status/attention/fg', { w: 70 }), pcSp(), text(n + ' products', 'Caption/Default', 'text/muted')]); };
  const panel = card('Variant type details', [frame({ name: 'body', dir: 'V', gap: 'space/4', pad: 20, sizeH: 'FILL' }, [
    frame({ name: 'title', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text('Pack size', 'Heading/H2'), bdg('Info', 'None', 'Variant'), pcSp(), ppLink('Edit in Attributes', 'external-link', 'edit-attr')]),
    text('Names and labels are edited in Attributes, so there is one place for them. Here you set how buyers choose.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    pcField('How buyers choose', inst('SegmentedControl', { 'Segment 1': 'Buttons', 'Segment 2': 'Swatches', 'Segment 3': 'Dropdown' }, { name: 'display' }), 'Swatches use a colour or small picture per option.'),
    pcField('Option order', inst('Select', { State: 'Filled', Value: 'By size (from the unit)' }, { name: 'order', sizeH: 'FILL' }), 'Manual, alphabetical in each language, or by size for Number-with-unit options.'),
    pcField('Help for sellers', pcIn('Choose every pack size you sell. Each one gets its own price and stock.'), 'One sentence above the variant grid.'),
    text('Options', 'Caption/Strong', 'text/muted'), card('options', [opt('250 g', '۲۵۰ گرم', '', 0, 96), opt('500 g', '۵۰۰ گرم', '', 0, 141), opt('1 kg', '۱ کیلوگرم', '١ كغ', 0, 122), opt('5 kg', '۵ کیلوگرم', '', 0, 41)]),
    paSave()])], { w: 520, sizeH: null });
  return frame({ name: 'Variant types layout', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [list, panel]);
}
function pvAll() {
  const rows = [['Sella basmati rice', '5 kg', 'MP-004127-02', '9 300633 01234 5', '4', '$18.50', '212', ''], ['Sella basmati rice', '10 kg', 'MP-004127-03', '9 300633 01235 2', '3', '$34.00', '88', ''], ['Sella basmati rice', '20 kg', 'MP-004127-04', '—', '0', '—', '0', 'No seller selling'], ['Mango juice', '1 L · Mango', 'MP-002210-01', '9 312345 67890 1', '2', '$4.20', '0', 'Out of stock everywhere'], ['Mango juice', '1 L · Guava', 'MP-002210-02', '9 312345 67890 1', '1', '$4.40', '36', 'Duplicate GTIN'], ['Ground cumin', 'Fine · 100 g', 'MP-003318-05', '—', '2', '$3.10', '54', 'Missing GTIN']];
  const head = headerRow([['Product · variant', 'fill'], ['Code', 140], ['GTIN', 150], ['Sellers', 80], ['From', 80], ['Stock', 70], ['Issues', 190]]);
  const tbl = card('Variant list', [frame({ name: 'tools', dir: 'H', gap: 'space/2', align: 'center', pad: [12, 16, 12, 16], sizeH: 'FILL' }, [inst('Input', { Type: 'Text', State: 'Default', Value: 'Search product, variant code, GTIN or SKU', 'Leading icon': true }, { name: 'search', w: 380 }), inst('Select', { State: 'Filled', Value: 'Variant type: All' }, { name: 'type', w: 180 }), pcSp(), text('Click a row to open the product on that variant', 'Caption/Default', 'text/muted')]),
    frame({ name: 'issue chips', dir: 'H', gap: 'space/2', wrap: true, rowGap: 'space/2', pad: [0, 16, 12, 16], sizeH: 'FILL' }, [['No seller selling', '17'], ['Out of stock everywhere', '42'], ['Missing GTIN', '388'], ['Duplicate GTIN', '3'], ['No image', '61'], ['Missing language', '24']].map(function (c) { return pvChip(c[0] + ' · ' + c[1], false); })), head].concat(rows.map(function (r) {
    return row([[twoLine(r[0], r[1]), 'fill'], [text(r[2], 'Mono/Small'), 140], [text(r[3], 'Mono/Small', r[3] === '—' ? 'text/muted' : 'text/primary'), 150], [text(r[4], 'Body/Small'), 80], [text(r[5], 'Body/Small'), 80], [text(r[6], 'Body/Small', 'text/muted'), 70], [r[7] ? bdg(r[7] === 'Duplicate GTIN' ? 'Critical' : 'Attention', 'None', r[7]) : text('—', 'Body/Small', 'text/muted'), 190]], false, false, 56);
  }), [inst('Pagination', { Range: '1–25 of 1,284 variants' }, { name: 'Pagination', sizeH: 'FILL' })]));
  return tbl;
}
function pvWaiting() {
  const items = [['New variant', 'Sella basmati rice: 2 kg', 'Kuraby Fresh wants to sell a size the product doesn’t have', '1 h ago', true], ['New option', 'Flavour: "Lychee"', 'Logan Halal Grocer · Mango juice', '3 h ago'], ['New variant', 'Ground cumin: Coarse · 250 g', 'Sunnybank Pantry', '1 day ago']];
  const list = card('Waiting list', [frame({ name: 'tools', dir: 'H', pad: [12, 16, 12, 16], sizeH: 'FILL' }, [inst('Select', { State: 'Filled', Value: 'Kind: All' }, { name: 'kind', w: 170 })])].concat(items.map(function (it) {
    return frame({ name: 'request · ' + it[1], dir: 'V', gap: 'space/1', pad: [12, 16, 12, 16], fill: it[4] ? 'bg/row-selected' : null, stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [frame({ name: 'kind', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [bdg('Info', 'None', it[0]), pcSp(), text(it[3], 'Caption/Default', 'text/muted')]), text(it[1], 'Body/Strong'), text(it[2], 'Body/Small', 'text/muted', { sizeH: 'FILL' })]);
  })));
  const decide = card('Decision', [frame({ name: 'body', dir: 'V', gap: 'space/4', pad: 20, sizeH: 'FILL' }, [
    text('Add 2 kg to Sella basmati rice?', 'Heading/H2'), text('A platform product. Kuraby Fresh sells 5 kg and 10 kg on it and asks for a 2 kg size. The option 2 kg already exists in Pack size.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    pcImpact([['Variants after this', '5 of 100'], ['Barcode given', '9 300633 01233 8'], ['Same barcode elsewhere', 'None']]),
    paRadio(true, 'Approve', 'The 2 kg variant is created and the seller can price it.'), paRadio(false, 'Use an existing variant', 'Point the seller to a variant the product already has.'), paRadio(false, 'Decline', 'Tell the seller why. They get an email.'),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, [btn('Approve', 'Primary', 'Sm')])])], { w: 480, sizeH: null });
  return frame({ name: 'Waiting layout', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [list, decide]);
}
// The variant grid in the product form (the same for a seller's own product and an admin's platform product).
const PV_GRID = [['1 L', 'Mango', true, '9 312345 67890 1', '1.1 kg', '$4.20', '36', true, 'M1'], ['1 L', 'Guava', true, '9 312345 67891 8', '1.1 kg', '$4.40', '12', true, 'G1'], ['1 L', 'Lychee', false], ['2 L', 'Mango', true, '', '2.2 kg', '$7.50', '0', true, 'M2'], ['2 L', 'Guava', true, '', '2.2 kg', '$7.80', '8', false, ''], ['2 L', 'Lychee', false]];
function pvAxis(name, opts, locked) {
  return frame({ name: 'axis · ' + name, dir: 'V', gap: 'space/2', pad: 'space/3', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [
    frame({ name: 'axis head', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(name, 'Body/Strong'), locked ? icon('lock', 'icon/muted', 14) : null, pcSp(), ppLink('Suggest a new option', null, 'suggest')]),
    frame({ name: 'options', dir: 'H', gap: 'space/2', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, opts.map(function (o) { return pvChip(o[0], o[1], true); }))]);
}
function pvGrid(o) {
  o = o || {};
  const head = headerRow([['', 52], ['Variant', 'fill'], ['Barcode (GTIN)', 170], ['Ship weight', 110], ['Image', 80], ['SKU', 90], ['Price', 90], ['Stock', 80], ['Selling', 90]]);
  const rows = PV_GRID.map(function (r) {
    if (!r[2]) return row([[pvTick(false), 52, { justify: 'center' }], [text(r[0] + ' · ' + r[1], 'Body/Default', 'text/muted'), 'fill'], [text('Tick to add', 'Caption/Default', 'text/muted'), 170], [text('', 'Caption/Default'), 110], [text('', 'Caption/Default'), 80], [text('', 'Caption/Default'), 90], [text('', 'Caption/Default'), 90], [text('', 'Caption/Default'), 80], [text('', 'Caption/Default'), 90]], false, false, 52);
    const img = rect({ name: 'thumb', w: 32, h: 32, fill: 'bg/muted', radius: 'radius/chip' });
    return row([[pvTick(true), 52, { justify: 'center' }], [twoLine(r[0] + ' · ' + r[1], 'MP-002210-0' + (PV_GRID.indexOf(r) + 1), 'Body/Default'), 'fill'], [text(r[3] || 'Add barcode', 'Mono/Small', r[3] ? 'text/primary' : 'text/muted'), 170], [text(r[4], 'Body/Small'), 110], [img, 80], [text(r[8] || '—', 'Mono/Small', r[8] ? 'text/primary' : 'text/muted'), 90], [text(r[5], 'Body/Small'), 90], [text(r[6], 'Body/Small', r[6] === '0' ? 'status/attention/fg' : 'text/primary'), 80], [pvSwitch(r[7]), 90]], false, !r[7], 52);
  });
  const bulk = frame({ name: 'bulk', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text('4 of 100 variants', 'Body/Small Strong', 'text/secondary'), pcSp(), btn('Set price for selected', 'Secondary', 'Sm'), btn('Increase by %', 'Secondary', 'Sm'), btn('Set stock', 'Secondary', 'Sm')]);
  return [frame({ name: 'axes', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [pvAxis('Pack size', [['1 L', true], ['2 L', true], ['500 ml', false]], o.locked), pvAxis('Flavour', [['Mango', true], ['Guava', true], ['Lychee', true], ['Apple', false]], o.locked)]),
    text('Every combination is listed. Tick the ones you have; the rest stay out. Labels come from the option names in each language.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }), bulk, card('variant grid', [head].concat(rows)),
    text('Product side: barcode, ship weight and image (from the product gallery). Your side: SKU, price, stock and Selling. Turning Selling off keeps the variant; turn it on again any time.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })];
}
function pvForm(state, kids, ws) {
  ws = ws || 'Seller';
  const head = pageTitle('Mango juice', ws === 'Seller' ? 'Your product · Draft changes not yet submitted' : 'Platform product · Australia', [btn('Discard', 'Secondary', 'Md'), btn(ws === 'Seller' ? 'Submit for review' : 'Publish', 'Primary', 'Md')]);
  const tabs = tabsBar([['Details', null, false], ['Images', null, false], ['Variants', '4', true], ['Certifications', null, false]]);
  return pvTag(screen(PV + ' · Product form · ' + state, ws, 'nav-catalogue', (ws === 'Seller' ? 'Products' : 'Catalog / Products') + ' / Mango juice', [head, tabs].concat(kids), { minH: PANEL_MIN_H, gap: 'space/4' }));
}
function pvSimple() {
  const card1 = card('Simple product', [frame({ name: 'body', dir: 'V', gap: 'space/3', pad: 24, sizeH: 'FILL' }, [
    text('This product has one size', 'Heading/H2'), text('Sella basmati rice 5 kg sells as one item. Add sizes to sell 1 kg, 10 kg and more on the same page. Your 5 kg price, stock and SKU stay as the first size.', 'Body/Default', 'text/secondary', { sizeH: 'FILL' }),
    pcField('Variant type', inst('Select', { State: 'Filled', Value: 'Pack size' }, { name: 'type', w: 280 }), 'From the Rice and grains feature set. You can add a second type once, later.'),
    frame({ name: 'act', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [btn('Add sizes', 'Primary', 'Md', { 'Leading icon': true, Icon: { icon: 'plus' } })])])]);
  const second = card('Add a second type', [frame({ name: 'body', dir: 'V', gap: 'space/3', pad: 24, sizeH: 'FILL' }, [
    frame({ name: 'title', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text('Add a second variant type', 'Heading/H2'), bdg('Neutral', 'None', 'Once')]),
    text('Variant types can’t change after the first publish. You can add a second type once. Every variant you have gets one value of it; prices and stock stay.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    pcField('Second type', inst('Select', { State: 'Filled', Value: 'Grain' }, { name: 'type2', w: 280 })), pcField('Value for your 3 sizes now', inst('Select', { State: 'Filled', Value: 'White' }, { name: 'fill', w: 280 })),
    frame({ name: 'act', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, [btn('Cancel', 'Secondary', 'Sm'), btn('Add type', 'Primary', 'Sm')])])]);
  return [frame({ name: 'two', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [card1, second])];
}
// Buyer product page: a sketch of the picker; the storefront page layout itself comes from the storefront design.
function pvBuyerOpt(label, st) {
  const on = st === 'on', out = st === 'out', na = st === 'na';
  return frame({ name: 'opt · ' + label, dir: 'V', gap: 0, align: 'center', pad: [8, 14, 8, 14], radius: 'radius/control', stroke: on ? 'action/primary' : 'border/default', fill: on ? 'bg/selected' : 'bg/surface', strokeW: on ? 2 : 1 }, [text(label, on ? 'Body/Strong' : 'Body/Default', out || na ? 'text/muted' : 'text/primary', { strike: na }), out ? text('Out of stock', 'Caption/Default', 'text/muted') : null]);
}
function pvBuyerDesktop() {
  const gallery = frame({ name: 'gallery', dir: 'V', gap: 'space/2', w: 520 }, [rect({ name: 'image 5 kg', w: 520, h: 420, fill: 'bg/muted', radius: 'radius/card' }), frame({ name: 'thumbs', dir: 'H', gap: 'space/2' }, [0, 1, 2, 3].map(function (i) { return rect({ name: 'thumb', w: 72, h: 72, fill: 'bg/muted', radius: 'radius/control', stroke: i === 0 ? 'action/primary' : null }); }))]);
  const seller = function (n, p, on) { return frame({ name: 'seller · ' + n, dir: 'H', gap: 'space/2', align: 'center', pad: [10, 12, 10, 12], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(n, 'Body/Default', 'text/primary', { sizeH: 'FILL' }), text(p, 'Body/Strong'), btn('Add', on ? 'Primary' : 'Secondary', 'Sm')]); };
  const info = frame({ name: 'info', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [
    text('Tilda', 'Body/Small', 'text/link'), text('Sella basmati rice', 'Heading/H1'),
    frame({ name: 'price', dir: 'H', gap: 'space/2', align: 'end' }, [text('$18.50', 'Heading/H1'), text('$3.70 / kg', 'Body/Small', 'text/muted')]),
    text('Pack size: 5 kg', 'Body/Strong'), frame({ name: 'options', dir: 'H', gap: 'space/2', wrap: true }, [pvBuyerOpt('1 kg'), pvBuyerOpt('5 kg', 'on'), pvBuyerOpt('10 kg'), pvBuyerOpt('20 kg', 'out')]),
    text('3 sellers have this size · from $18.50', 'Body/Small', 'text/secondary'),
    card('sellers', [seller('Kuraby Fresh · today', '$18.50', true), seller('Logan Halal Grocer · tomorrow', '$19.20'), seller('Sunnybank Pantry · tomorrow', '$19.90')]),
    text('Address bar: /p/sella-basmati-rice?v=02 · canonical without ?v · first in-stock size is chosen when there is no ?v', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]);
  const scr = frame({ name: PV + ' · Buyer · Product page (sketch)', dir: 'V', w: 1280, pad: 40, gap: 'space/6', fill: 'bg/page' }, [
    text('Buyer product page · variant picker (sketch, storefront layout comes from the storefront design)', 'Caption/Strong', 'text/muted'),
    frame({ name: 'layout', dir: 'H', gap: 'space/8', align: 'start', sizeH: 'FILL' }, [gallery, info]),
    text('On a product card in lists', 'Caption/Strong', 'text/muted'),
    frame({ name: 'card', dir: 'V', gap: 'space/1', pad: 'space/3', w: 240, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [rect({ name: 'img', w: 216, h: 160, fill: 'bg/muted', radius: 'radius/control' }), text('Sella basmati rice', 'Body/Strong'), text('From $6.20 · 4 sizes', 'Body/Small', 'text/secondary')])]);
  tag(scr); return pvTag(scr);
}
function pvBuyerPhone(name, sel, rtl) {
  const opts = rtl ? [['۱ کیلوگرم'], ['۵ کیلوگرم'], ['۱۰ کیلوگرم'], ['۲۰ کیلوگرم', 'out']] : [['1 kg'], ['5 kg'], ['10 kg'], ['20 kg', 'out']];
  const row1 = frame({ name: 'options', dir: 'H', gap: 'space/2', sizeH: 'FILL', clip: true }, opts.map(function (o, i) { return pvBuyerOpt(o[0], i === sel ? (o[1] === 'out' ? 'out' : 'on') : o[1]); }));
  if (rtl) row1.counterAxisAlignItems = 'CENTER';
  const out = opts[sel][1] === 'out';
  const t = function (str, st, c, o) { return text(str, st, c, Object.assign({ sizeH: 'FILL' }, rtl ? { align: 'right' } : {}, o || {})); };
  const body = frame({ name: 'body', dir: 'V', gap: 'space/3', pad: 16, sizeH: 'FILL' }, [rect({ name: 'image', w: 328, h: 240, fill: 'bg/muted', radius: 'radius/card' }),
    t(rtl ? 'برنج باسماتی سلا' : 'Sella basmati rice', 'Heading/H2'), t(out ? (rtl ? 'ناموجود' : 'Out of stock') : (rtl ? '$18.50 · $3.70 / kg' : '$18.50 · $3.70 / kg'), 'Body/Strong', out ? 'text/muted' : 'text/primary'),
    t(rtl ? 'اندازهٔ بسته: ' + opts[sel][0] : 'Pack size: ' + opts[sel][0], 'Body/Strong'), row1, t(rtl ? 'گزینه‌ها افقی اسکرول می‌شوند' : 'Options scroll sideways', 'Caption/Default', 'text/muted')]);
  const bar = frame({ name: 'sticky add to cart', dir: 'H', gap: 'space/2', align: 'center', pad: 12, fill: 'bg/surface', stroke: 'border/default', sides: ['top'], sizeH: 'FILL' }, [btn(out ? (rtl ? 'ناموجود' : 'Out of stock') : (rtl ? 'افزودن ۵ کیلوگرم به سبد' : 'Add 5 kg to cart'), 'Primary', 'Md', out ? { State: 'Disabled' } : {})]);
  bar.children[0].layoutSizingHorizontal = 'FILL';
  const scr = frame({ name: PV + ' · Buyer · ' + name, dir: 'V', w: 360, h: 780, fill: 'bg/page', clip: true }, [frame({ name: 'spacer', dir: 'V', sizeH: 'FILL', sizeV: 'FILL' }, [body]), bar]);
  tag(scr); return pvTag(scr);
}
function pvStates() {
  const b = function (n, tone, t, body, act) { return inst('InfoBanner', Object.assign({ Tone: tone, Title: t, Body: body, 'Show action': !!act }, act ? { Action: act } : {}), { name: n, sizeH: 'FILL' }); };
  const field = function (n, v, msg) { return frame({ name: n, dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [pcIn(v, 'Error'), text(msg, 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' })]); };
  const remove = pcDialog('Remove variant', 'Remove 2 L · Guava?', 'This size has live prices and stock. Removing it ends them. Adding it again later starts from empty.', [pcImpact([['Your stock that stops selling', '8'], ['Carts that show it as unavailable', '3', true]])], 'Remove variant', { destructive: true, focusCancel: true, w: 480 });
  const scr = frame({ name: PV + ' · States and messages', dir: 'V', w: 900, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Variants: states and messages', 'Heading/H1'),
    para('Plan section 16. Copy is a draft for Jafar (product designer) and Reza (UI/UX).', 820),
    text('Variant grid', 'Caption/Strong', 'text/muted'), b('limit', 'Critical', 'You’ve reached 100 variants.', 'Remove one before adding another.'), b('near', 'Attention', '96 of 100 variants', 'Ticking all 12 would go over the limit.'),
    b('locked', 'Info', 'Variant types can’t change after the first publish.', 'You can add a second type once.'), b('move', 'Critical', 'Move needs the same variant types.', 'The new category’s feature set has no Pack size. Ask an admin to add it.'),
    field('gtin-dup', '9 312345 67890 1', 'This barcode is already on a product in the catalogue. You can sell on that product instead.'), field('gtin-bad', '9 312345 67890 2', 'Check the barcode. The last digit doesn’t match.'),
    text('Removing a published variant', 'Caption/Strong', 'text/muted'), remove,
    text('Buyer', 'Caption/Strong', 'text/muted'), frame({ name: 'buyer', dir: 'H', gap: 'space/2' }, [pvBuyerOpt('20 kg', 'out'), pvBuyerOpt('2 L', 'na')]), text('Out of stock: shown, can’t be added. No such combination with the current choice: faded and struck through.', 'Caption/Default', 'text/muted'),
    b('cart', 'Attention', 'This size is no longer available.', 'In the cart, for a removed variant.'),
    text('Admin', 'Caption/Strong', 'text/muted'), b('view-only', 'Info', 'View only', 'You can view variants. Ask a Platform Administrator to change them.'),
    inst('EmptyState', { Size: 'Card', Title: 'No requests are waiting for you', Body: 'Seller requests for new variants and options show here.', Icon: { icon: 'inbox' } }, { name: 'queue-empty', sizeH: 'FILL' })]);
  tag(scr); return pvTag(scr);
}
PROPOSALS['variants'] = { title: PV, rows: function () {
  return [[pvScreen('Variant types', { body: pvTypes() }), pvScreen('Variants', { tab: 'Variants', body: pvAll() }), pvScreen('Waiting for you', { tab: 'Waiting for you', body: pvWaiting() })],
    [pvForm('Seller · Variant grid', pvGrid()), pvForm('Admin · Platform product, published', pvGrid({ locked: true }), 'Admin'), pvForm('Seller · Simple product, Add sizes', pvSimple())],
    [pvBuyerDesktop(), pvBuyerPhone('Phone · 5 kg', 1), pvBuyerPhone('Phone · 20 kg out of stock', 3), pvBuyerPhone('Phone · Persian', 1, true), pvStates()]];
} };

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
