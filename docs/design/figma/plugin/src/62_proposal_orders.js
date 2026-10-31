// ---- Panels · List framework and Orders (owner's brief, 31 Oct 2026): every list with many records (products, orders,
// customers, sellers, offers, review queues…) uses one framework with the features of the admin products list: view tabs
// and saved filters, search, filter conditions, sort, column picker, Bulk action, export, rows per page and the total.
// Owner decisions (31 Oct): 1 every big list, each moved when its page is redesigned; 2 page numbers by default, and a
// per-Market platform setting "List paging" switches every list in both panels to Previous and next; 3 saved filters for
// the user, shared ones with their own permission; 4 seller orders have both the table and the Order board; 5 bulk actions on
// orders are Export (and Print packing slips for sellers); status changes stay on each order's own page.
const PO = 'Proposal · Panels · Lists and Orders';
function poTag(n) { n.setPluginData('proposal', 'lists-orders'); return n; }
function poSp() { return frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }); }
function poScreen(ws, state, crumb, kids, overlay, active) {
  const scr = screen(PO + ' · ' + ws + ' · ' + state, ws, active || (ws === 'Seller' ? 'nav-all-orders' : 'nav-orders'), crumb, kids, { minH: PANEL_MIN_H, gap: 'space/4' });
  (overlay ? [].concat(overlay) : []).forEach(function (o) { add(scr, o); });
  return poTag(scr);
}

// ---- Framework parts, the same in every list
// Footer: the range and the total, rows per page, then page numbers or Previous and next (the platform setting decides).
function poPager(mode, range, o) {
  o = o || {};
  const size = frame({ name: 'page-size', dir: 'H', gap: 'space/2', align: 'center' }, [text('Rows per page', 'Body/Small', 'text/muted'), btn(o.size || '25', 'Secondary', 'Sm', { 'Trailing icon': true })]);
  let controls;
  if (mode === 'next') {
    controls = frame({ name: 'controls', dir: 'H', gap: 'space/2', align: 'center' }, [btn('Previous', 'Secondary', 'Sm', { State: o.first === false ? 'Default' : 'Disabled' }), btn('Next', 'Secondary', 'Sm', { State: o.last ? 'Disabled' : 'Default' })]);
  } else {
    const pages = o.pages || ['1', '2', '3', '4', '5', '…', '497'];
    const cur = o.current || '1';
    controls = frame({ name: 'controls', dir: 'H', gap: 'space/1', align: 'center' }, [ppIconButton('chevron-left', 'previous', cur === '1' ? 'Disabled' : 'Default')].concat(pages.map(function (p) {
      return p === '…' ? text('…', 'Body/Small', 'text/muted', { name: 'gap' }) : btn(p, p === cur ? 'Primary' : 'Ghost', 'Sm');
    }), [ppIconButton('chevron-right', 'next', o.last ? 'Disabled' : 'Default')]));
  }
  return frame({ name: 'Pagination · ' + (mode === 'next' ? 'Previous and next' : 'Page numbers'), dir: 'H', gap: 'space/4', align: 'center', pad: [12, 14, 12, 14], sizeH: 'FILL' }, [text(range, 'Body/Small', 'text/muted', { name: 'range' }), poSp(), size, controls]);
}
// Toolbar: search, then the filter (with the number of conditions), sort and column icons, then the sort in words.
function poToolbar(placeholder, sortLabel, o) {
  o = o || {};
  const search = inst('Input', { Type: 'Text', State: o.query ? 'Filled' : 'Default', Value: o.query || placeholder, 'Leading icon': true }, { name: 'search', w: o.searchW || 440 });
  const filter = frame({ name: 'filter', dir: 'H', gap: 'space/1', align: 'center' }, [ppIconButton('sliders', 'filter-button', o.open === 'filter' ? 'Focus' : 'Default')].concat(o.filters ? [inst('CountBadge', { Tone: 'Info', Count: String(o.filters) }, { name: 'filter-count' })] : []));
  const icons = [filter, ppIconButton('arrow-down', 'sort-button', o.open === 'sort' ? 'Focus' : 'Default')];
  if (!o.noColumns) icons.push(ppIconButton('columns', 'columns-button', o.open === 'columns' ? 'Focus' : 'Default'));
  return frame({ name: 'toolbar', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [search, frame({ name: 'icons', dir: 'H', gap: 'space/2', align: 'center' }, icons), poSp(), text(sortLabel, 'Body/Small', 'text/muted', { name: 'sort-label' })]);
}
function poChips(list, resultText) {
  const kids = list.map(function (c) { return inst('FilterChip', { Type: 'Applied', Label: c }, { name: 'chip' }); });
  kids.push(ppLink('Clear all', null, 'clear-all'), ppLink('Save filter…', 'star', 'save-filter'), poSp(), text(resultText, 'Body/Small Strong', 'text/secondary', { name: 'result-count' }));
  return frame({ name: 'applied', dir: 'H', gap: 'space/2', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, kids);
}
function poViews(list, active) {
  return frame({ name: 'views', dir: 'H', gap: 'space/3', align: 'end', sizeH: 'FILL' }, [tabsBar(list.map(function (v) { return [v[0], v[1], v[0] === active]; })), ppLink('Manage filters', 'sliders', 'manage-filters')]);
}
// cols: [label, width or 'fill', sorted, align end]; rows: one array of cell nodes per row, in column order.
function poTable(name, cols, rows, o) {
  o = o || {};
  const sel = (o.selected || []).length;
  const head = headerRow(cols.map(function (c) { return [c[0], c[1], c[2]]; }).concat([['', 56]]));
  head.insertChild(0, selectHeader(sel === 0 ? 'Unchecked' : (sel === rows.length ? 'Checked' : 'Indeterminate')));
  const kids = [head];
  rows.forEach(function (r, i) {
    const on = (o.selected || []).indexOf(i) >= 0;
    const cells = [[inst('Checkbox', { Value: on ? 'Checked' : 'Unchecked', State: 'Default' }, { name: 'select' }), 56, { justify: 'center' }]];
    cols.forEach(function (c, j) { cells.push([r[j], c[1], c[3] ? { justify: 'end' } : {}]); });
    cells.push([rowAction(), 56, { justify: 'center' }]);
    kids.push(row(cells, on, (o.attention || []).indexOf(i) >= 0, 60));
  });
  kids.push(poPager(o.mode || 'numbers', o.range, o.pager));
  return card(name, kids);
}
function poBulkButton(o) {
  const b = btn('Bulk action', 'Secondary', 'Md', { State: o.open === 'actions' ? 'Focus' : (o.selected ? 'Default' : 'Disabled'), 'Trailing icon': true });
  b.name = 'actions-button';
  return b;
}
function poBulkMenu(n, noun, total, items) {
  return ppPopover('Bulk action menu (open)', 320, [text(n + ' ' + noun + ' selected', 'Caption/Strong', 'text/muted', { name: 'title' }),
    frame({ name: 'items', dir: 'V', sizeH: 'FILL' }, items.map(function (i) { return ppActionItem('Default', i[0], i[1], i[2]); })),
    frame({ name: 'scope', dir: 'V', gap: 'space/1', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [ppLink('Select all ' + total + ' ' + noun + ' in this filter', null, 'select-all-matching'), ppLink('Clear selection', null, 'clear-selection')])]);
}
function poFilterPanel(title, conds) {
  return ppPopover('Filter panel (open)', 520, [
    frame({ name: 'head', dir: 'H', align: 'center', sizeH: 'FILL' }, [text(title, 'Heading/H2', 'text/primary', { sizeH: 'FILL' }), text('Match all conditions', 'Body/Small', 'text/muted')]),
  ].concat(conds.map(function (c) { return ppCondition(c[0], c[1], c[2]); }), [ppLink('Add condition', 'plus', 'add-condition'),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', align: 'center', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [ppLink('Save as filter…', 'star', 'save-as'), poSp(), btn('Cancel', 'Secondary', 'Md'), btn('Apply', 'Primary', 'Md')])]));
}
function poSortMenu(fields, current, dirs) {
  const item = function (label) { return inst('MenuItem', { State: label === current ? 'Selected' : 'Default', Label: label, 'Leading icon': false, 'Show description': false }, { name: 'sort-' + label, sizeH: 'FILL' }); };
  const seg = inst('SegmentedControl', { 'Segment 1': dirs[0], 'Segment 2': dirs[1] }, { name: 'direction' });
  const third = seg.findOne(function (n) { return n.name === 'segment-3'; }); if (third) third.visible = false;
  return ppPopover('Sort menu (open)', 280, [text('Sort by', 'Caption/Strong', 'text/muted', { name: 'title' }), frame({ name: 'fields', dir: 'V', sizeH: 'FILL' }, fields.map(item)),
    frame({ name: 'direction-row', dir: 'V', gap: 'space/2', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text('Order', 'Caption/Strong', 'text/muted'), seg])]);
}
function poColumnsPanel(fixed, optional) {
  return ppPopover('Column picker (open)', 340, [text('Columns', 'Heading/H2'), text('Drag to change the order. Saved for you only.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    frame({ name: 'fixed', dir: 'V', sizeH: 'FILL' }, fixed.map(function (l) { return ppColumnRow(l, true, true); })),
    frame({ name: 'optional', dir: 'V', pad: ['space/2', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, optional.map(function (c) { return ppColumnRow(c[0], c[1]); })),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', align: 'center', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [ppLink('Reset to default', 'undo', 'reset'), poSp(), btn('Save', 'Primary', 'Md')])]);
}
// Order status badges: one tone per meaning, the same in both panels.
const PO_STATUS = { 'Awaiting payment': ['Attention', 'Dot'], Paid: ['Info', 'Dot'], 'To ship': ['Attention', 'Dot'], 'Ready for pickup': ['Info', 'Dot'], Shipped: ['Info', 'Dot'], Delivered: ['Success', 'Dot'], Cancelled: ['Neutral', 'Dot'], Refunded: ['Neutral', 'Dot'], Disputed: ['Critical', 'Dot'] };
function poStatus(s) { const d = PO_STATUS[s]; return bdg(d[0], d[1], s); }
function poText(s, style, color) { return text(s, style || 'Body/Default', color || 'text/primary', { truncate: true }); }

// ---- Admin · Orders
// [order, status, placed, customer, sellers, total, payment, delivery suburb]
const POA_ROWS = [
  ['#AU-10482', 'Paid', '31 Oct, 9:12 am', 'Sara K.', '2', 'A$84.50', 'Card', 'Toowong'],
  ['#AU-10481', 'Shipped', '31 Oct, 8:40 am', 'Omar H.', '1', 'A$32.00', 'Card', 'Sunnybank'],
  ['#AU-10479', 'Disputed', '30 Oct, 7:55 pm', 'Leila M.', '1', 'A$56.20', 'Wallet', 'Kedron'],
  ['#AU-10476', 'Delivered', '30 Oct, 6:31 pm', 'Yusuf A.', '3', 'A$121.80', 'Card', 'Logan Central'],
  ['#AU-10474', 'Awaiting payment', '30 Oct, 5:02 pm', 'Hana R.', '1', 'A$18.90', 'Card', 'Indooroopilly'],
  ['#AU-10470', 'Refunded', '30 Oct, 2:16 pm', 'Daniel P.', '1', 'A$44.00', 'Card', 'Carindale'],
  ['#AU-10468', 'Cancelled', '30 Oct, 11:48 am', 'Amina S.', '2', 'A$67.35', 'Card', 'Chermside'],
  ['#AU-10465', 'Delivered', '30 Oct, 9:05 am', 'Karim T.', '1', 'A$29.95', 'Wallet', 'Springwood'],
];
const POA_VIEWS = [['All', '12,408'], ['Needs attention', '7'], ['Paid, not shipped', '86'], ['Disputed', '3'], ['Refunded', '41'], ['Cancelled', '118'], ['Brisbane today', '64']];
const POA_SEARCH = 'Search by order number, customer or seller';
const POA_SORT = 'Sorted by Placed, newest first';
function poaHeader(o) {
  o = o || {};
  return pageTitle('Orders', '12,408 orders in the Australia market · times in Brisbane time (AEST)', [poBulkButton(o), btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } })]);
}
function poaTable(o) {
  o = o || {};
  const extra = o.extra || [];
  const cols = [['Order', 130, o.sortedBy === 'Order'], ['Status', 170], ['Placed', 160, !o.sortedBy || o.sortedBy === 'Placed'], ['Customer', 'fill'], ['Sellers', 90], ['Total', 110, false, true]]
    .concat(extra.map(function (c) { return [c, c === 'Payment' ? 110 : 150]; }));
  const rows = (o.rows || POA_ROWS).map(function (r) {
    return [poText(r[0], 'Body/Strong'), poStatus(r[1]), poText(r[2]), poText(r[3]), poText(r[4]), poText(r[5], 'Body/Strong')].concat(extra.map(function (c) { return poText(c === 'Payment' ? r[6] : r[7]); }));
  });
  return poTable('Order list', cols, rows, { selected: o.selected, attention: o.attention, mode: o.mode, range: o.range || '1–25 of 12,408 orders', pager: o.pager });
}
function poaDefault() { return poScreen('Admin', 'Orders · Default', 'Orders', [poaHeader(), poViews(POA_VIEWS, 'All'), poToolbar(POA_SEARCH, POA_SORT), poaTable({ attention: [2] })]); }
function poaFilter() {
  const rows = [POA_ROWS[0], POA_ROWS[6]];
  const scr = poScreen('Admin', 'Orders · Filter open', 'Orders', [poaHeader(), poViews(POA_VIEWS, 'All'), poToolbar(POA_SEARCH, POA_SORT, { open: 'filter', filters: 2 }), poChips(['Placed is in the last 7 days', 'Seller is Al-Noor Butcher'], '143 orders match'), poaTable({ rows: rows, range: '1–25 of 143 orders', pager: { pages: ['1', '2', '3', '4', '5', '6'] } })]);
  ppUnder(scr, 'filter-button', poFilterPanel('Filter orders', [['Placed', 'is in the last', '7 days'], ['Seller', 'is', 'Al-Noor Butcher'], ['Status', 'is any of', 'Paid, Shipped']]));
  return scr;
}
function poaSelected() {
  const scr = poScreen('Admin', 'Orders · Rows selected, Bulk action open', 'Orders', [poaHeader({ selected: 3, open: 'actions' }), poViews(POA_VIEWS, 'All'), poToolbar(POA_SEARCH, POA_SORT), poaTable({ selected: [0, 1, 3] })]);
  ppUnder(scr, 'actions-button', poBulkMenu(3, 'orders', '12,408', [['Export', 'download', 'CSV or XLSX, with the columns shown']]), true);
  return scr;
}
function poaSort() {
  const scr = poScreen('Admin', 'Orders · Sort menu open', 'Orders', [poaHeader(), poViews(POA_VIEWS, 'All'), poToolbar(POA_SEARCH, POA_SORT, { open: 'sort' }), poaTable()]);
  ppUnder(scr, 'sort-button', poSortMenu(['Placed', 'Paid', 'Total', 'Status', 'Order number'], 'Placed', ['Newest first', 'Oldest first']));
  return scr;
}
function poaColumns() {
  const scr = poScreen('Admin', 'Orders · Column picker open', 'Orders', [poaHeader(), poViews(POA_VIEWS, 'All'), poToolbar(POA_SEARCH, POA_SORT, { open: 'columns' }), poaTable({ extra: ['Payment', 'Delivery suburb'] })]);
  ppUnder(scr, 'columns-button', poColumnsPanel(['Order', 'Status', 'Placed', 'Total'], [['Customer', true], ['Sellers', true], ['Payment', true], ['Delivery suburb', true], ['Paid', false], ['Delivery method', false], ['Refunded amount', false], ['Service area', false]]));
  return scr;
}
// The platform setting set to Previous and next: the same list, only the footer changes.
function poaNextMode() {
  return poScreen('Admin', 'Orders · Paging set to Previous and next', 'Orders', [poaHeader(), poViews(POA_VIEWS, 'All'), poToolbar(POA_SEARCH, POA_SORT), poaTable({ mode: 'next', range: '26–50 of 12,408 orders', pager: { first: false } })]);
}

// ---- Seller · Orders: the table and the Order board, one switch in the header
// [order, status, ship by, items, total, delivery method, customer suburb]
const POS_ROWS = [
  ['MP-10482', 'To ship', 'Today, 2:50 pm', 'Lamb cutlets 500 g ×2, +1 more', 'A$84.50', 'Courier', 'Toowong'],
  ['MP-10483', 'To ship', 'Today, 2:55 pm', 'Chicken thigh fillets 1 kg', 'A$21.90', 'Courier', 'Taringa'],
  ['MP-10481', 'To ship', 'Today, 3:10 pm', 'Beef mince 1 kg, Turkish bread loaf', 'A$26.40', 'Pickup', 'Sunnybank'],
  ['MP-10476', 'Ready for pickup', 'Today, 2:41 pm', 'Basmati rice 5 kg ×2', 'A$38.00', 'Courier', 'Kedron'],
  ['MP-10470', 'To ship', 'Tomorrow, 10:00 am', 'Medjool dates 1 kg, +3 more', 'A$61.75', 'Local delivery', 'Logan Central'],
  ['MP-10466', 'To ship', 'Tomorrow, 11:30 am', 'Whole chicken size 16', 'A$15.50', 'Pickup', 'Carindale'],
];
const POS_VIEWS = [['To ship', '9'], ['Ready for pickup', '2'], ['Shipped', '14'], ['Delivered', '1,206'], ['Cancelled or refunded', '23'], ['All', '1,254']];
const POS_SEARCH = 'Search by order number or product';
const POS_SORT = 'Sorted by Ship by, soonest first';
// Table or Board: a two-segment switch built from tokens (the library SegmentedControl always selects its first segment).
function posSwitch(active) {
  const seg = function (label, ic, on) { return frame({ name: 'segment · ' + label, dir: 'H', gap: 'space/1-5', px: 'space/3', align: 'center', fill: on ? 'bg/selected' : null, sizeV: 'FILL' }, [icon(ic, on ? 'text/link' : 'icon/default', 16), text(label, on ? 'Body/Strong' : 'Body/Default', on ? 'text/link' : 'text/secondary')]); };
  return frame({ name: 'view switch', dir: 'H', h: 'size/control', stroke: 'border/control', radius: 'radius/control', fill: 'bg/surface', clip: true }, [seg('Table', 'menu', active === 'Table'), rect({ name: 'divider', w: 1, h: 10, fill: 'border/control', sizeV: 'FILL' }), seg('Board', 'columns', active === 'Board')]);
}
function posHeader(view, o) {
  o = o || {};
  const right = [posSwitch(view)];
  if (view === 'Table') right.push(poBulkButton(o));
  right.push(btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }));
  return pageTitle('Orders', 'Times in your shop’s time zone (Brisbane, AEST)', right);
}
function posTable(o) {
  o = o || {};
  const cols = [['Order', 130], ['Status', 170], ['Ship by', 170, true], ['Items', 'fill'], ['Total', 110, false, true], ['Delivery', 140]];
  const rows = (o.rows || POS_ROWS).map(function (r) { return [poText(r[0], 'Body/Strong'), poStatus(r[1]), poText(r[2], r[2].indexOf('Today') === 0 ? 'Body/Strong' : 'Body/Default'), poText(r[3]), poText(r[4], 'Body/Strong'), poText(r[5])]; });
  return poTable('Order list', cols, rows, { selected: o.selected, attention: o.attention, range: o.range || '1–9 of 9 orders', pager: o.pager || { pages: ['1'], last: true } });
}
function posDefault() { return poScreen('Seller', 'Orders · Table', 'Orders', [posHeader('Table'), poViews(POS_VIEWS, 'To ship'), poToolbar(POS_SEARCH, POS_SORT), posTable({ attention: [0] })]); }
function posFilter() {
  const scr = poScreen('Seller', 'Orders · Search and filter', 'Orders', [posHeader('Table'), poViews(POS_VIEWS, 'All'), poToolbar(POS_SEARCH, POS_SORT, { query: 'lamb', open: 'filter', filters: 1 }), poChips(['Delivery is Courier'], '31 orders match'), posTable({ rows: [POS_ROWS[0]], range: '1–25 of 31 orders', pager: { pages: ['1', '2'] } })]);
  ppUnder(scr, 'filter-button', poFilterPanel('Filter orders', [['Delivery', 'is', 'Courier'], ['Ship by', 'is', 'Today']]));
  return scr;
}
function posSelected() {
  const scr = poScreen('Seller', 'Orders · Rows selected, Bulk action open', 'Orders', [posHeader('Table', { selected: 3, open: 'actions' }), poViews(POS_VIEWS, 'To ship'), poToolbar(POS_SEARCH, POS_SORT), posTable({ selected: [0, 1, 2] })]);
  ppUnder(scr, 'actions-button', poBulkMenu(3, 'orders', '9', [['Print packing slips', 'file-text', 'One PDF, one page for each order'], ['Export', 'download', 'CSV or XLSX, with the columns shown']]), true);
  return scr;
}
// The Order board on desktop: the same header, search and filter (no sort or columns), the stages as columns.
function posBoard() {
  const col = function (title, count, bg, border, fg, cards, more) {
    return frame({ name: title, dir: 'V', gap: 'space/2-5', pad: 12, fill: bg, stroke: border, radius: 'radius/card', sizeH: 'FILL' }, [
      frame({ name: 'h', dir: 'H', justify: 'between', px: 4, sizeH: 'FILL' }, [text(title, 'Body/Strong', fg), text(count, 'Body/Strong', fg)]),
    ].concat(cards.map(function (v) { return inst('OrderCard', { Variant: v }, { sizeH: 'FILL' }); }), more ? [ppLink(more, null, 'show-more')] : []));
  };
  const board = frame({ name: 'Board', dir: 'H', gap: 'space/3', align: 'start', sizeH: 'FILL' }, [
    col('Needs action', '3', 'board/action-bg', 'board/action-border', 'status/attention/fg', ['Urgent', 'Normal'], 'Show 1 more'),
    col('Preparing', '5', 'board/prep-bg', 'board/prep-border', 'status/info/fg', ['Preparing'], 'Show 4 more'),
    col('Ready for pickup', '2', 'board/ready-bg', 'board/ready-border', 'status/success/fg', ['Ready'], 'Show 1 more'),
  ]);
  return poScreen('Seller', 'Orders · Board', 'Orders', [posHeader('Board'), poToolbar(POS_SEARCH, 'Each stage: oldest first', { noColumns: true }), text('The board shows today’s open orders. Shipped, delivered and older orders are in the table.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }), board]);
}
// Phone (under 1024 px): each row becomes a card; filter and sort open in a sheet.
function posPhone() {
  const ocard = function (r) {
    return card('order · ' + r[0], [frame({ name: 'body', dir: 'V', gap: 'space/2', pad: 'space/3', sizeH: 'FILL' }, [
      frame({ name: 'top', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(r[0], 'Body/Strong'), poSp(), poStatus(r[1])]),
      text(r[3], 'Body/Default', 'text/secondary', { sizeH: 'FILL', truncate: true }),
      frame({ name: 'bottom', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text('Ship by ' + r[2], 'Caption/Strong', 'text/primary'), poSp(), text(r[4], 'Body/Strong')])])]);
  };
  const tools = frame({ name: 'tools', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [inst('Input', { Type: 'Text', State: 'Default', Value: 'Search orders', 'Leading icon': true }, { name: 'search', sizeH: 'FILL' }), ppIconButton('sliders', 'filter-button'), ppIconButton('arrow-down', 'sort-button')]);
  const views = frame({ name: 'views', dir: 'H', gap: 'space/2', sizeH: 'FILL', clip: true }, [inst('FilterChip', { Type: 'Applied', Label: 'To ship · 9' }, { name: 'view' }), btn('Ready for pickup · 2', 'Ghost', 'Sm')]);
  const kids = [text('Orders', 'Heading/H1'), tools, views].concat(POS_ROWS.slice(0, 4).map(ocard), [frame({ name: 'pager', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text('1–9 of 9', 'Body/Small', 'text/muted'), poSp(), btn('Board', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'columns' } })])]);
  return poTag(phoneScreen(PO + ' · Seller · Orders · Phone', 'Seller', kids, 'Orders'));
}

// ---- Admin · Settings · Lists: the one platform setting every list reads (per Market, like the other platform settings)
const PO_ADMIN_GROUPS = [['Marketplace', 'store', [['Support contact'], ['Smart assistant'], ['Lists']]], ['Delivery', 'package', [['Delivery rules'], ['Delivery fleets']]], ['Money', 'wallet', [['Customer wallet']]], ['People & access', 'users', [['Admins'], ['Roles & permissions']]]];
function poPagingControl(nextMode) {
  const seg = inst('SegmentedControl', { 'Segment 1': nextMode ? 'Previous and next' : 'Page numbers', 'Segment 2': nextMode ? 'Page numbers' : 'Previous and next' }, { name: 'list-paging' });
  const t = seg.findOne(function (n) { return n.name === 'segment-3'; }); if (t) t.visible = false;
  return seg;
}
function poSettings(state, o) {
  o = o || {};
  const rows = [psRow('List paging', 'How long lists move between pages, in both panels. Page numbers let people jump to a page; Previous and next stays fast when lists get very long.', poPagingControl(o.changed), { changed: o.changed }),
    psRow('Rows per page', 'What every list shows first. People can change it for themselves.', psSelect('25'))];
  const note = text('Page numbers go up to row 10,000; after that the list asks people to narrow it with a filter. If this setting can’t be read, lists use Previous and next.', 'Body/Small', 'text/muted', { name: 'limits', sizeH: 'FILL' });
  const head = pageTitle('Lists', 'How lists work for every admin and seller in the Australia market.', []);
  const last = text('Last changed by Sara K. · 3 days ago · View history', 'Caption/Default', 'text/muted', { name: 'last-changed' });
  const content = frame({ name: 'Settings content', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [frame({ name: 'header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [head, last])].concat(
    o.changed ? [psBanner('impact', 'Info', 'This changes every list in both panels', 'Lists switch the next time they load. Saved links that point to a page number open on the first page; filters and sort stay.')] : [],
    [psSection('Paging', 'Applies to products, orders, customers, sellers, offers and every other long list.', rows), note], o.changed ? [psSaveBar('1 unsaved change')] : []));
  return poScreen('Admin', 'Settings · Lists · ' + state, 'Settings / Marketplace / Lists', [frame({ name: 'Settings layout', dir: 'H', gap: 'space/6', align: 'start', sizeH: 'FILL' }, [psSubNav(PO_ADMIN_GROUPS, 'Lists'), content])], null, 'nav-settings');
}

// ---- States: the same for every list
function poStates() {
  const lbl = function (s) { return text(s, 'Caption/Strong', 'text/muted'); };
  const loading = card('Loading', [headerRow([['Order', 130], ['Status', 170], ['Placed', 160], ['Customer', 'fill']])].concat([0, 1, 2, 3].map(function () {
    return frame({ name: 'Row', dir: 'H', sizeH: 'FILL' }, [130, 170, 160, 'fill'].map(function (w) { const c = inst('TableCell', { Type: 'Text', State: 'Loading' }, { sizeH: w === 'fill' ? 'FILL' : null }); if (w !== 'fill') c.resize(w, c.height); return c; }));
  })));
  const none = inst('EmptyState', { Size: 'Card', Title: 'No orders yet', Body: 'Orders show here as soon as customers buy from your shop.', Icon: { icon: 'clipboard' } }, { name: 'empty', sizeH: 'FILL' });
  const nomatch = inst('EmptyState', { Size: 'Card', Title: 'No orders match', Body: 'Try another search or remove a filter.', Icon: { icon: 'search' } }, { name: 'no-match', sizeH: 'FILL' });
  const fail = inst('InfoBanner', { Tone: 'Critical', Title: 'Orders could not be loaded', Body: 'Try again. If it keeps happening, check the status page.', 'Show action': true, Action: 'Try again' }, { name: 'load-error', sizeH: 'FILL' });
  const deep = inst('InfoBanner', { Tone: 'Info', Title: 'Narrow the list to see more', Body: 'Page numbers stop at row 10,000. Add a filter, such as a date range, to see older orders.', 'Show action': false }, { name: 'depth-limit', sizeH: 'FILL' });
  const exp = card('Export dialog', [frame({ name: 'body', dir: 'V', gap: 'space/4', pad: 'space/6', sizeH: 'FILL' }, [
    text('Export 143 orders', 'Heading/H2'), text('Placed is in the last 7 days · Seller is Al-Noor Butcher', 'Body/Small', 'text/secondary', { sizeH: 'FILL' }),
    frame({ name: 'format', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [text('Format', 'Body/Strong'), (function () { const s = inst('SegmentedControl', { 'Segment 1': 'CSV', 'Segment 2': 'XLSX' }, { name: 'format' }); const t = s.findOne(function (n) { return n.name === 'segment-3'; }); if (t) t.visible = false; return s; })()]),
    text('The file has the 6 columns shown. It includes customer names, so the export is recorded in the audit log. Large exports are prepared in the background and you get a notification.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, [btn('Cancel', 'Secondary', 'Md'), btn('Export', 'Primary', 'Md')])])], { w: 480, sizeH: null });
  const toast = psToast('Info', 'Preparing your export. We’ll notify you when it’s ready.');
  const pagers = card('Footers', [poPager('numbers', '1–25 of 12,408 orders'), rect({ name: 'divider', w: 10, h: 1, fill: 'border/row', sizeH: 'FILL' }), poPager('next', '1–25 of 12,408 orders')]);
  const scr = frame({ name: PO + ' · States', dir: 'V', w: 1240, pad: 40, gap: 'space/5', fill: 'bg/page' }, [text('Lists: the parts and states every list shares', 'Heading/H1'),
    para('Header with the total and the page actions; view tabs with saved filters; search, filter, sort and column icons; the applied conditions; the table; the footer. Each page only lists its columns, filters, views and bulk actions. Below 1024 px rows become cards. The address keeps the view, filter, sort and page, so a link opens the same list.', 1100),
    lbl('Footer · Page numbers (default) and Previous and next (Settings › Lists)'), pagers, lbl('Loading'), loading, lbl('No records yet'), none, lbl('No match'), nomatch, lbl('Could not load'), fail, lbl('Past row 10,000 with page numbers'), deep,
    lbl('Export (from the header or Bulk action) and the toast after it'), frame({ name: 'export', dir: 'H', gap: 'space/6', align: 'start', sizeH: 'FILL' }, [exp, toast])]);
  tag(scr); return poTag(scr);
}

PROPOSALS['lists-orders'] = { title: PO, rows: function () {
  return [[poaDefault(), poaFilter(), poaSelected()], [poaSort(), poaColumns(), poaNextMode()],
    [posDefault(), posFilter(), posSelected()], [posBoard(), posPhone(), poSettings('Default'), poSettings('Changed', { changed: true })], [poStates()]];
} };
