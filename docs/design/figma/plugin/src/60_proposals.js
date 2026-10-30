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
