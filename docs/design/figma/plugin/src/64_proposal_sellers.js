// ---- Admin · Seller management (owner's brief, 31 Oct 2026): one place for every admin task on a seller, on the shared list
// framework. The KPI cards of the old Admin · Sellers template are gone (they move to the reports pages, RPT-04).
// Owner decisions (31 Oct): 1 the list opens on All; 2 search, filter and sort work in every status (sellers keeps a read
// copy of identity's state); 3 bulk actions are Export, and Approve and Reject on Awaiting review only; 4 orders (30 days),
// cancelled, Health and certificate columns are built now (a read model fed by other modules; Health needs its formula);
// 5 one seller page with tabs, and the cross-seller queues stay and link to it; 6 Add seller is a full page: the admin fills
// the file and invites the owner, the file joins the queue and another admin approves it; 7 Suspend now (reversible, with a
// reason), Close for good (SEL-09) after the ordering module and a short review.
const SM = 'Proposal · Admin · Sellers';
function smTag(n) { n.setPluginData('proposal', 'admin-sellers'); return n; }
function smScreen(state, crumb, kids) { return smTag(screen(SM + ' · ' + state, 'Admin', 'nav-sellers', crumb, kids, { minH: PANEL_MIN_H, gap: 'space/4' })); }
function smSp() { return frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }); }

// ---- List
// [initials, tone, store, web address, status, certificates, health, orders 30 days, cancelled, area, joined, kind]
const SM_ROWS = [
  ['KF', 'Teal', 'Kuraby Fresh Halal', 'kuraby-fresh-halal', 'Approved', [['Seller', '· exp 15 Nov']], 'Healthy', '412', '0.8%', 'Greater Brisbane', '12 Mar 2026'],
  ['SS', 'Purple', 'Sunnybank Spice Market', 'sunnybank-spice', 'Awaiting review', [], 'No data', '0', '—', 'Greater Brisbane', '29 Sep 2026', 'New application'],
  ['DA', 'Blue', 'Darra Asian Mart', 'darra-asian-mart', 'Approved', [['Seller', '· exp 23 Nov']], 'At risk', '268', '3.1%', 'Greater Brisbane', '4 Apr 2026'],
  ['LF', 'Neutral', 'Logan Family Grocer', 'logan-family-grocer', 'Approved', [['Manufacturer']], 'Healthy', '190', '1.2%', 'Greater Brisbane', '18 May 2026'],
  ['HP', 'Amber', 'Holland Park Bakehouse', 'holland-park-bakehouse', 'Changes needed', [['Seller'], ['Vegan']], 'Healthy', '356', '0.4%', 'Greater Brisbane', '2 Feb 2026'],
  ['SC', 'Neutral', 'Slacks Creek Butchers', 'slacks-creek-butchers', 'Suspended', [['Revoked']], 'Unhealthy', '12', '9.8%', 'Greater Brisbane', '20 Jan 2026'],
  ['WO', 'Teal', 'Woolloongabba Grocers', 'gabba-grocers', 'Invited', [], 'No data', '0', '—', 'Greater Brisbane', '28 Oct 2026'],
];
const SM_AWAITING = [
  ['SS', 'Purple', 'Sunnybank Spice Market', 'sunnybank-spice', 'Awaiting review', [], 'No data', '0', '—', 'Greater Brisbane', '29 Sep 2026', 'New application'],
  ['MK', 'Amber', 'Mariam’s Kitchen', 'mariams-kitchen', 'Awaiting review', [], 'No data', '0', '—', 'Greater Brisbane', '2 Oct 2026', 'New application'],
  ['DA', 'Blue', 'Darra Asian Mart', 'darra-asian-mart', 'Awaiting review', [['Seller']], 'At risk', '268', '3.1%', 'Greater Brisbane', '5 Oct 2026', 'Change request'],
  ['BB', 'Teal', 'Bald Hills Butcher', 'bald-hills-butcher', 'Awaiting review', [], 'No data', '0', '—', 'Greater Brisbane', '6 Oct 2026', 'New application'],
  ['CH', 'Purple', 'Calamvale Harvest', 'calamvale-harvest', 'Awaiting review', [], 'No data', '0', '—', 'Greater Brisbane', '7 Oct 2026', 'New application'],
  ['IN', 'Neutral', 'Inala Noodle House', 'inala-noodle-house', 'Awaiting review', [], 'No data', '0', '—', 'Greater Brisbane', '8 Oct 2026', 'New application'],
];
const SM_VIEWS = [['All', '128'], ['Awaiting review', '6'], ['Approved', '109'], ['Suspended', '3'], ['Changes needed', '4'], ['Incomplete', '6']];
const SM_SEARCH = 'Search by store name, web address or ABN';
function smSeller(r) { return frame({ name: 'seller', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [inst('IdentityTile', { Tone: r[1], Shape: 'Rounded', Initials: r[0] }), twoLine(r[2], r[3])]); }
function smCerts(list) {
  if (!list.length) return text('None', 'Body/Default', 'text/muted');
  return frame({ name: 'certs', dir: 'H', gap: 'space/1-5', align: 'center' }, list.map(function (c) { const i = inst('CertChip', { Kind: c[0] }); if (c[1]) i.setProperties(Object.assign(prop('CertChip', 'Note', c[1]), prop('CertChip', 'Show note', true))); return i; }));
}
function smRate(v) { return text(v, v === '9.8%' || v === '3.1%' ? 'Body/Strong' : 'Body/Default', v === '9.8%' ? 'status/critical/fg' : (v === '3.1%' ? 'status/attention/fg' : 'text/primary')); }
function smHeader(o) {
  o = o || {};
  return pageTitle('Sellers', '128 sellers in the Australia market', [poBulkButton(o), btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), btn('Add seller', 'Primary', 'Md', { 'Leading icon': true, Icon: { icon: 'plus' } })]);
}
function smTable(o) {
  o = o || {};
  const awaiting = o.view === 'Awaiting review';
  const extra = o.extra || [];
  const cols = [['Seller', 'fill'], ['Status', 170]].concat(awaiting ? [['Kind', 150], ['Submitted', 130, true]] : [['Certificates', 200], ['Health', 110], ['Orders, 30 days', 120, false, true], ['Cancelled', 100, false, true], ['Joined', 120, true]], extra.map(function (c) { return [c, 150]; }));
  const rows = (o.rows || SM_ROWS).map(function (r) {
    const base = [smSeller(r), saBadge(r[4])];
    const rest = awaiting ? [poText(r[11]), poText(r[10])] : [smCerts(r[5]), inst('HealthIndicator', { State: r[6] }), poText(r[7]), smRate(r[8]), poText(r[10])];
    return base.concat(rest, extra.map(function (c) { return poText(c === 'Service area' ? r[9] : 'Self sign-up'); }));
  });
  return poTable('Seller list', cols, rows, { selected: o.selected, attention: o.attention, range: o.range || '1–25 of 128 sellers', pager: o.pager || { pages: ['1', '2', '3', '4', '5', '6'] } });
}
function smDefault() { return smScreen('List · All (default)', 'Sellers', [smHeader(), poViews(SM_VIEWS, 'All'), poToolbar(SM_SEARCH, 'Sorted by Joined, newest first'), smTable({ attention: [5] })]); }
function smFilter() {
  const scr = smScreen('List · Filter open', 'Sellers', [smHeader(), poViews(SM_VIEWS, 'All'), poToolbar(SM_SEARCH, 'Sorted by Joined, newest first', { open: 'filter', filters: 2 }), poChips(['Status is Approved', 'Health is At risk or Unhealthy'], '9 sellers match'), smTable({ rows: [SM_ROWS[2]], range: '1–9 of 9 sellers', pager: { pages: ['1'], last: true } })]);
  ppUnder(scr, 'filter-button', poFilterPanel('Filter sellers', [['Status', 'is any of', 'Approved'], ['Health', 'is any of', 'At risk, Unhealthy'], ['Service area', 'is', 'Greater Brisbane']]));
  return scr;
}
function smAwaitingSelected() {
  const scr = smScreen('List · Awaiting review, rows selected, Bulk action open', 'Sellers', [smHeader({ selected: 3, open: 'actions' }), poViews(SM_VIEWS, 'Awaiting review'), poToolbar(SM_SEARCH, 'Sorted by Submitted, oldest first'), smTable({ view: 'Awaiting review', rows: SM_AWAITING, selected: [0, 1, 3], range: '1–6 of 6 sellers', pager: { pages: ['1'], last: true } }),
    text('Change requests can’t be decided in bulk: open each one. At most 50 sellers at a time.', 'Body/Small', 'text/muted', { sizeH: 'FILL' })]);
  ppUnder(scr, 'actions-button', poBulkMenu(3, 'sellers', '6', [['Approve…', 'check', 'Each one still needs its checks and register result'], ['Reject…', 'x', 'With a prepared reason the sellers see'], ['Export', 'download', 'CSV or XLSX, with the columns shown']]), true);
  return scr;
}
function smSort() {
  const scr = smScreen('List · Sort menu open', 'Sellers', [smHeader(), poViews(SM_VIEWS, 'All'), poToolbar(SM_SEARCH, 'Sorted by Joined, newest first', { open: 'sort' }), smTable()]);
  ppUnder(scr, 'sort-button', poSortMenu(['Joined', 'Last changed', 'Store name', 'Orders, 30 days', 'Cancelled'], 'Joined', ['Newest first', 'Oldest first']));
  return scr;
}
function smColumns() {
  const scr = smScreen('List · Column picker open', 'Sellers', [smHeader(), poViews(SM_VIEWS, 'All'), poToolbar(SM_SEARCH, 'Sorted by Joined, newest first', { open: 'columns' }), smTable({ extra: ['Service area'] })]);
  ppUnder(scr, 'columns-button', poColumnsPanel(['Seller', 'Status'], [['Certificates', true], ['Health', true], ['Orders, 30 days', true], ['Cancelled', true], ['Joined', true], ['Service area', true], ['Owner', false], ['Origin', false], ['Last changed', false], ['Time zone', false]]));
  return scr;
}

// ---- Add seller: a full page; the owner gets an invitation and sets their own password and two-step sign-in
function smSection(title, sub, kids) { return podCard(title, [text(sub, 'Body/Small', 'text/muted', { sizeH: 'FILL' })].concat(kids)); }
function smInput(label, value, help, o) { o = o || {}; return podField(label, inst('Input', { Type: 'Text', State: value ? 'Filled' : 'Default', Value: value || o.placeholder || ' ' }, { name: 'input', sizeH: 'FILL' }), help); }
function smTwo(a, b) { return frame({ name: 'pair', dir: 'H', gap: 'space/4', sizeH: 'FILL' }, [a, b]); }
function smAdd() {
  const form = frame({ name: 'form', dir: 'V', gap: 'space/4', w: 760 }, [
    smSection('Owner', 'They get an email invitation. Nobody at MondaPac sets or sees their password.', [smTwo(smInput('Full name', 'Hana Yusuf'), smInput('Email', 'hana@kurabyfresh.com.au'))]),
    smSection('Store', 'What customers see.', [smTwo(smInput('Store name', 'Kuraby Fresh Halal'), smInput('Web address', 'kuraby-fresh-halal', 'mondapac.com.au/store/kuraby-fresh-halal'))]),
    smSection('Business', 'Checked against the business register when the file is reviewed.', [smTwo(smInput('Legal business name', 'Kuraby Fresh Pty Ltd'), smInput('ABN', '51 824 753 556')), smTwo(smInput('Phone', '07 3341 0000'), smInput('Contact email', 'orders@kurabyfresh.com.au'))]),
    smSection('Address and area', 'Decides the service area and the shop’s time zone.', [smInput('Operating address', '1520 Beenleigh Rd, Kuraby QLD 4112'), smTwo(podField('Service area', psSelect('Greater Brisbane')), podField('Time zone', psSelect('Brisbane (AEST)')))]),
    frame({ name: 'footer', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text('The file joins Awaiting review. Another admin approves it.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }), btn('Cancel', 'Secondary', 'Md'), btn('Save draft', 'Secondary', 'Md'), btn('Save and invite owner', 'Primary', 'Md')])]);
  return smScreen('Add seller', 'Sellers / Add seller', [podHeader('Add seller', [], 'Create the seller’s file and invite the owner.', [], 'Sellers'), form]);
}

// ---- The seller page: header with the actions for the state, then tabs
const SM_TABS = ['Overview', 'Details', 'Review', 'Certificates', 'Offers', 'Orders', 'Money', 'Delivery', 'Team & access', 'Settings', 'Activity'];
function smTabs(active) { return tabsBar(SM_TABS.map(function (t) { return [t, null, t === active]; })); }
function smMore() { const b = btn('More', 'Secondary', 'Md', { 'Trailing icon': true }); b.name = 'more-button'; return b; }
function smPageHeader(state, o) {
  o = o || {};
  const right = { Approved: [btn('Suspend…', 'Secondary', 'Md'), smMore()], 'Awaiting review': [btn('Reject…', 'Secondary', 'Md'), btn('Approve', 'Primary', 'Md'), smMore()], Suspended: [btn('Lift suspension', 'Primary', 'Md'), smMore()] }[state];
  const sub = state === 'Awaiting review' ? 'sunnybank-spice · Greater Brisbane · submitted 29 Sep 2026, 2 days in the queue' : 'kuraby-fresh-halal · Greater Brisbane · joined 12 Mar 2026 · owner Hana Yusuf';
  return podHeader(o.name || (state === 'Awaiting review' ? 'Sunnybank Spice Market' : 'Kuraby Fresh Halal'), [saBadge(state)].concat(o.cert ? [inst('CertChip', { Kind: 'Seller' })] : []), sub, right, 'Sellers');
}
function smPage(state, tab, crumbName, kids, o) { return smScreen('Seller · ' + tab + (o && o.label ? ' · ' + o.label : ''), 'Sellers / ' + crumbName, [smPageHeader(state, o)].concat(o && o.banner ? [o.banner] : [], [smTabs(tab)], kids)); }
function smAttention(items) {
  return podCard('Needs attention', items.map(function (i) { return frame({ name: 'item', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [icon(i[0], i[1], 16), text(i[2], 'Body/Default', 'text/primary', { sizeH: 'FILL' }), ppLink(i[3], null, 'open')]); }));
}
function smOwner() { return podCard('Owner', [frame({ name: 'owner', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, personCell({ tone: 'Blue', i: 'HY', name: 'Hana Yusuf', email: 'hana@kurabyfresh.com.au' })), podPair('Two-step sign-in', 'On'), podPair('Last signed in', '31 Oct, 8:02 am')]); }
function smSnapshot() { return podCard('Last 30 days', [podPair('Orders', '412'), podPair('Cancelled', '0.8%'), podPair('Dispatched on time', '97%'), frame({ name: 'health', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [text('Health', 'Body/Default', 'text/secondary', { sizeH: 'FILL' }), inst('HealthIndicator', { State: 'Healthy' })]), text('Sales figures and trends are in Reports › Sellers.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]); }
const SM_ACTIVITY = [['31 Oct', 'Minimum order changed to A$25', 'Hana Yusuf (seller)'], ['20 Oct', 'Halal certificate approved', 'Layla Haddad'], ['12 Mar', 'Seller approved', 'Layla Haddad · checks 4 of 4, register active']];
function smOverview() {
  return smPage('Approved', 'Overview', 'Kuraby Fresh Halal', [podColumns([smAttention([['alert-triangle', 'status/attention/fg', 'Halal certificate expires in 14 days (15 Nov 2026)', 'Open certificate'], ['clock', 'status/info/fg', '1 offer is waiting for price review', 'Open queue'], ['info', 'icon/muted', 'Payout account verified by Stripe', 'Open Money']]),
    podCard('Business', [podPair('Legal name', 'Kuraby Fresh Pty Ltd'), podPair('ABN', '51 824 753 556 · active on the register'), podPair('Operating address', '1520 Beenleigh Rd, Kuraby QLD 4112'), podPair('Time zone', 'Brisbane (AEST)'), ppLink('Open Details', 'arrow-right', 'open-details')]),
    podNotes('Admins only. The seller never sees these notes.', [['Asked about adding a frozen range; told them the category opens in December.', 'Layla Haddad · 2 Oct']])],
    [smOwner(), smSnapshot(), podActivity(SM_ACTIVITY)])], { cert: true });
}
// Built from basic parts so the frames build on any library version (CheckboxRow and DataRow differ between releases).
function smCompare(label, mine, reg, flag) {
  const f = flag === 'Matches' ? bdg('Success', 'Icon', 'Matches', 'check') : bdg('Attention', 'Icon', 'Differs', 'alert-circle');
  const col = function (k, v) { return frame({ name: k, dir: 'V', sizeH: 'FILL' }, [text(k, 'Caption/Default', 'text/muted'), text(v, 'Body/Default', 'text/primary', { sizeH: 'FILL' })]); };
  return frame({ name: 'compare · ' + label, dir: 'H', gap: 'space/3', align: 'center', py: 'space/2', stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(label, 'Body/Strong', 'text/primary', { w: 150 }), col('Seller', mine), col('Register', reg), f]);
}
function smCheck(label, on, desc) {
  return frame({ name: 'check · ' + label, dir: 'H', gap: 'space/3', align: 'start', py: 'space/2', sizeH: 'FILL' }, [inst('Checkbox', { Value: on ? 'Checked' : 'Unchecked', State: 'Default' }, { name: 'box' }),
    frame({ name: 'text', dir: 'V', sizeH: 'FILL' }, [text(label, 'Body/Default', 'text/primary', { sizeH: 'FILL' }), text(desc, 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]), bdg('Neutral', 'None', 'Required')].concat(on ? [ppLink('Undo', 'undo', 'undo')] : []));
}
// Review tab: the existing review page, inside the seller page; after a decision, Next in queue opens the next file.
function smReview() {
  const compare = podCard('Details against the register', [psBanner('register', 'Info', 'The register lists this ABN as active.', 'Looked up today, 9:41 am.'),
    smCompare('Business name', 'Sunnybank Spice Market Pty Ltd', 'SUNNYBANK SPICE MARKET PTY LTD', 'Matches'),
    smCompare('Postcode', '4109', '4109', 'Matches'),
    smCompare('GST registration', 'From 1 Jul 2024', 'Not registered', 'Differs'),
    text('A match doesn’t prove the applicant controls the business.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]);
  const checks = podCard('Checks', [smCheck('Identity of the owner checked', true, 'Recorded by Layla Haddad, 9:44 am'), smCheck(STORE_CHECK, true, 'Recorded by Layla Haddad, 9:45 am'), smCheck('Food business licence seen', false, 'Not recorded')]);
  const side = [podCard('Decision', [text('Record 1 required check first.', 'Body/Small', 'status/attention/fg', { sizeH: 'FILL' }), frame({ name: 'buttons', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [btn('Reject…', 'Secondary', 'Md'), btn('Approve', 'Primary', 'Md', { State: 'Disabled' })]), ppLink('Next in queue: Mariam’s Kitchen', 'arrow-right', 'next-in-queue')]),
    podCard('Other sellers with this ABN', [text('None found', 'Body/Default', 'text/muted')]), podActivity([['29 Sep', 'Submitted by the seller', 'Submission 1'], ['27 Sep', 'Signed up', 'Email confirmed']])];
  return smPage('Awaiting review', 'Review', 'Sunnybank Spice Market', [podColumns([compare, checks], side)]);
}
// Details tab in edit mode: identity changes on an approved seller apply at once, with a reason, an email and a new register check.
function smDetailsEdit() {
  const form = podCard('Business details', [psBanner('impact', 'Attention', 'Changes to the business apply at once', 'The owner is emailed, the ABN is looked up again, and the change is recorded in Activity.'),
    smTwo(smInput('Legal business name', 'Kuraby Fresh Pty Ltd'), smInput('ABN', '51 824 753 556')), smTwo(smInput('Store name', 'Kuraby Fresh Halal'), smInput('Web address', 'kuraby-fresh-halal', 'Old links redirect for 90 days.')),
    smInput('Operating address', '1520 Beenleigh Rd, Kuraby QLD 4112'), smTwo(podField('Time zone', psSelect('Brisbane (AEST)')), smInput('Phone', '07 3341 0000')),
    podField('Reason for the change', psTextarea('Owner moved the shop to the new address on 28 Oct; confirmed by phone.', 'Filled'), 'Required. Kept in Activity; the owner sees it in the email.')]);
  return smPage('Approved', 'Details', 'Kuraby Fresh Halal', [form, psSaveBar('2 unsaved changes')], { label: 'Editing', cert: true });
}
function smMoney() {
  return smPage('Approved', 'Money', 'Kuraby Fresh Halal', [podColumns([
    podCard('Commission', [podPair('Rate', '12% of the item price, before GST'), podPair('From', '1 Apr 2026'), ppLink('Change rate…', 'pencil', 'change-rate')]),
    podCard('Ledger', [podPair('Earned, not paid', 'A$1,842.30'), podPair('Next payout', 'Tue 4 Nov · A$1,842.30'), podPair('Paid this month', 'A$6,120.75'), ppLink('Open ledger', 'arrow-right', 'open-ledger')]),
    podCard('Payout holds', [text('No holds.', 'Body/Default', 'text/muted'), ppLink('Place a hold…', 'lock', 'place-hold')])],
    [podCard('Payout account', [podPair('Provider', 'Stripe'), podPair('Status', 'Verified'), podPair('Bank account', 'ending 4412')]), podCard('Payout terms', [podPair('Schedule', 'Weekly, Tuesday'), podPair('Delay', '7 days after delivery'), ppLink('Change terms…', 'pencil', 'change-terms')])])], { cert: true });
}
function smTeam() {
  const people = [{ tone: 'Blue', i: 'HY', name: 'Hana Yusuf', email: 'hana@kurabyfresh.com.au', role: 'Owner', system: true }, { tone: 'Teal', i: 'RS', name: 'Rami S.', email: 'rami@kurabyfresh.com.au', role: 'Packer' }];
  const list = podCard('Team', people.map(function (m) { return frame({ name: 'member · ' + m.name, dir: 'H', gap: 'space/3', align: 'center', py: 'space/2', sizeH: 'FILL' }, personCell(m).concat([frame({ name: 'role', dir: 'H', gap: 'space/1', align: 'center', w: 140 }, roleNodes(m)), text(m.system ? 'Two-step on' : 'Two-step on', 'Body/Small', 'text/muted', { w: 110 })])); }).concat([text('Sellers manage their own team. Admins can only reset the owner’s two-step sign-in.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]));
  const access = podCard('Owner access', [podPair('Two-step sign-in', 'On since 12 Mar 2026'), btn('Reset owner’s two-step sign-in…', 'Secondary', 'Md'), text('They sign in with their password and set two-step up again. Their sessions end.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]);
  const inv = podCard('Invitations', [text('No open invitations.', 'Body/Default', 'text/muted')]);
  return smPage('Approved', 'Team & access', 'Kuraby Fresh Halal', [podColumns([list], [access, inv])], { cert: true });
}
function smSettings() {
  const seg = inst('SegmentedControl', { 'Segment 1': 'All types', 'Segment 2': 'Only selected types' }, { name: 'types' }); const t = seg.findOne(function (n) { return n.name === 'segment-3'; }); if (t) t.visible = false;
  const rows = [psRow('Allowed product types', 'Offers of a type that’s no longer allowed are taken off sale.', seg), psRow('Category proposals', 'Lets this seller suggest new categories.', inst('Switch', { On: 'False', Size: 'Md' }, { name: 'proposals' })),
    psRow('AI features', 'AI suggestions for this shop. AI never decides approvals, certificates or payments. The owner is emailed when it’s turned on.', inst('Switch', { On: 'False', Size: 'Md' }, { name: 'ai' })), psRow('Blog', 'Lets this seller publish posts on the MondaPac blog.', inst('Switch', { On: 'True', Size: 'Md' }, { name: 'blog' }))];
  return smPage('Approved', 'Settings', 'Kuraby Fresh Halal', [psSection('Admin-only settings', 'The seller can’t change these. Each change saves on its own and is recorded in Activity.', rows)], { cert: true });
}
function smOrders() {
  const rows = POA_ROWS.slice(0, 5).map(function (r) { return [poText(r[0], 'Body/Strong'), poStatus(r[1]), poText(r[2]), poText(r[3]), poText(r[5], 'Body/Strong')]; });
  return smPage('Approved', 'Orders', 'Kuraby Fresh Halal', [poToolbar('Search by order number or customer', 'Sorted by Placed, newest first'), poTable('Seller orders', [['Order', 130], ['Status', 170], ['Placed', 170, true], ['Customer', 'fill'], ['Total', 110, false, true]], rows, { range: '1–25 of 1,206 orders', pager: { pages: ['1', '2', '3', '…', '49'] } }),
    text('The same list as Orders, filtered to this seller. Certificates, Offers and Delivery work the same way: the module’s own list, filtered here, with the cross-seller queue still in the menu.', 'Body/Small', 'text/muted', { sizeH: 'FILL' })], { cert: true });
}
function smSuspended() {
  const banner = psBanner('suspended', 'Critical', 'Suspended on 20 Oct 2026 by Layla Haddad', 'Reason: repeated late deliveries and a revoked halal certificate. The seller can’t sign in and their offers are off sale. Open orders continue.', 'View reason');
  return smPage('Suspended', 'Overview', 'Slacks Creek Butchers', [podColumns([smAttention([['alert-circle', 'status/critical/fg', 'Halal certificate revoked on 18 Oct 2026', 'Open certificate'], ['clock', 'status/info/fg', '2 open orders still to deliver', 'Open orders']]), podNotes('Admins only. The seller never sees these notes.', [])], [podActivity([['20 Oct', 'Seller suspended', 'Layla Haddad · reason given'], ['18 Oct', 'Halal certificate revoked', 'Omar Siddiq']])])], { name: 'Slacks Creek Butchers', banner: banner });
}

// ---- Dialogs: approve, reject, suspend, lift suspension, and the More menu
function smDialogs() {
  const approve = podDialog('Approve seller', 'Approve Sunnybank Spice Market?', [text('All 3 required checks are recorded and the register lists the ABN as active. We’ll email the owner, and they can start listing offers.', 'Body/Default', 'text/secondary', { sizeH: 'FILL' })], 'Approve');
  const reject = podDialog('Reject application', 'Reject Sunnybank Spice Market’s application?', [podField('Prepared reason', psSelect('Business details don’t match the register')), podField('Message to the seller', psTextarea('Your GST registration date doesn’t match the business register. Please check it and submit again.', 'Filled'), 'The seller sees this. They can fix it and submit again.')], 'Reject', 'Destructive');
  const suspend = podDialog('Suspend seller', 'Suspend Kuraby Fresh Halal?', [
    frame({ name: 'effects', dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, ['Everyone in their team is signed out at once.', 'Their 38 offers go off sale.', '3 open orders continue; they can still deliver them.', 'Payouts keep their schedule unless you place a hold.'].map(function (s) { return text('• ' + s, 'Body/Small', 'text/secondary', { sizeH: 'FILL' }); })),
    podField('Reason', psSelect('Repeated late deliveries')), podField('Message to the owner', psTextarea('Add details the owner should see', 'Default'), 'Only the owner sees the reason.')], 'Suspend seller', 'Destructive');
  const lift = podDialog('Lift suspension', 'Lift Slacks Creek Butchers’ suspension?', [text('They can sign in again. Their offers come back on sale only if each still passes its checks; offers that needed the revoked certificate stay off.', 'Body/Default', 'text/secondary', { sizeH: 'FILL' }), podField('Note for Activity', psTextarea('Certificate renewed and approved on 30 Oct.', 'Filled'))], 'Lift suspension');
  const more = ppPopover('More menu (open)', 300, [ppActionItem('Default', 'Edit details', 'pencil'), ppActionItem('Default', 'Change web address', 'external-link'), ppActionItem('Default', 'Correct time zone', 'clock'), ppActionItem('Default', 'Reset owner’s two-step sign-in', 'key'), ppActionItem('Default', 'Export seller file', 'download'), ppActionItem('Default', 'Close seller…', 'ban', 'Arrives after the orders module')]);
  const lbl = function (s) { return text(s, 'Caption/Strong', 'text/muted'); };
  const scr = frame({ name: SM + ' · Dialogs', dir: 'V', w: 1240, pad: 40, gap: 'space/5', fill: 'bg/page' }, [text('Seller management: dialogs', 'Heading/H1'),
    para('Each decision states what happens. Approve and Reject come from the header or the Review tab; Suspend and Lift suspension from the header; the rest from More. Every action is recorded in Activity with the admin’s name.', 1100),
    frame({ name: 'row 1', dir: 'H', gap: 'space/6', align: 'start', sizeH: 'FILL' }, [frame({ name: 'a', dir: 'V', gap: 'space/2' }, [lbl('Approve'), approve]), frame({ name: 'b', dir: 'V', gap: 'space/2' }, [lbl('Reject'), reject])]),
    frame({ name: 'row 2', dir: 'H', gap: 'space/6', align: 'start', sizeH: 'FILL' }, [frame({ name: 'c', dir: 'V', gap: 'space/2' }, [lbl('Suspend'), suspend]), frame({ name: 'd', dir: 'V', gap: 'space/2' }, [lbl('Lift suspension'), lift])]),
    frame({ name: 'row 3', dir: 'V', gap: 'space/2' }, [lbl('More menu (approved seller)'), more])]);
  tag(scr); return smTag(scr);
}
// ---- States
function smStates() {
  const lbl = function (s) { return text(s, 'Caption/Strong', 'text/muted'); };
  const none = inst('EmptyState', { Size: 'Card', Title: 'No sellers waiting', Body: 'New applications and change requests show here.', Icon: { icon: 'check' } }, { name: 'empty-awaiting', sizeH: 'FILL' });
  const nomatch = inst('EmptyState', { Size: 'Card', Title: 'No sellers match', Body: 'Try another search or remove a filter.', Icon: { icon: 'search' } }, { name: 'no-match', sizeH: 'FILL' });
  const fail = psBanner('load-error', 'Critical', 'Sellers could not be loaded', 'Try again. If it keeps happening, check the status page.', 'Try again');
  const viewOnly = psBanner('view-only', 'Info', 'Your role can view sellers but not change them', 'Actions are hidden. Ask an admin with seller permissions.');
  const busy = psBanner('busy', 'Info', 'A decision is being recorded for this seller', 'Refresh in a moment.', 'Refresh');
  const invited = psBanner('invited', 'Attention', 'Invitation sent on 28 Oct, not accepted yet', 'The invitation expires on 4 Nov.', 'Resend invitation');
  const scr = frame({ name: SM + ' · States', dir: 'V', w: 1240, pad: 40, gap: 'space/5', fill: 'bg/page' }, [text('Seller management: states', 'Heading/H1'),
    para('The list uses the shared list states (loading, no match, could not load, past row 10,000). Tabs a role may not use are hidden, not disabled. Everything is limited to the current Market. Below 1024 px the list rows become cards and the seller page tabs scroll sideways.', 1100),
    lbl('Awaiting review, nothing waiting'), none, lbl('No match'), nomatch, lbl('Could not load'), fail, lbl('View-only role'), viewOnly, lbl('Decision being recorded'), busy, lbl('Invited, not accepted (seller page)'), invited]);
  tag(scr); return smTag(scr);
}

PROPOSALS['admin-sellers'] = { title: SM, rows: function () {
  return [[smDefault(), smFilter(), smAwaitingSelected()], [smSort(), smColumns(), smAdd()],
    [smOverview(), smReview(), smDetailsEdit()], [smMoney(), smTeam(), smSettings()], [smOrders(), smSuspended(), smDialogs(), smStates()]];
} };
