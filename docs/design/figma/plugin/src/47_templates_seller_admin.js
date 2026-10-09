// ---------------------------------------------------------------- release 1.10.0 templates: Seller admin (planned as 1.4.0 in sellers ux.md 8.1 item 2)
// Spec: sellers ux.md 3.1 S7 and 3.1a, 3.2 P1 to P4 and C1, 3.2a, 3.4 and section 5 (en-AU copy). Admin frames go to Templates · Admin, the
// store profile (S7) to Templates · Seller. Every frame is new; Update library builds only the names a file does not have yet, so the
// Phase 2 sellers list (1.8.3) and the Phase 2 Admin · Sellers frame are not touched. Rule 4 of 3.0: the register name, the business-number
// label, the address fields, the tax question, the checks and the prepared reasons come from the API; the AU Market's values are shown
// because AU is the launch Market. Names, numbers, addresses, dates and check names are examples. A text with no key in ux.md section 5 is a
// sample, listed in docs/design/figma/README.md. Seller states use Badge with an icon (StatusBadge holds order states only).

const SA_STATUS = { 'Awaiting review': ['Info', 'clock'], 'Details needed': ['Neutral', 'clipboard'], 'Ready to submit': ['Info', 'send'], 'Not in your area yet': ['Attention', 'map-pin'], 'Changes needed': ['Attention', 'alert-circle'],
  'Not approved': ['Critical', 'x'], Approved: ['Success', 'check'], 'Seller approved': ['Success', 'check'], Suspended: ['Critical', 'ban'], Invited: ['Neutral', 'send'] };
function saBadge(s) { const d = SA_STATUS[s]; return bdg(d[0], 'Icon', s, d[1]); }
const SA_REVIEWER = 'Layla Haddad';
const SA_RECORDED = 'Recorded by ' + SA_REVIEWER + ' on 8 Oct 2026, 10:02 AEST';
const SA_NOT_RECORDED = 'Not recorded yet.'; // no key yet (sample)
const SA_MARKET = 'Australia';
const SA_SELLERS = {
  sunnybank: { i: 'SS', tone: 'Purple', store: 'Sunnybank Spice Market', slug: 'sunnybank-spice', name: 'Hana Yusuf', email: 'hana@sunnybankspice.example' },
  darra: { i: 'DA', tone: 'Blue', store: 'Darra Asian Mart', slug: 'darra-asian-mart', name: 'Bilal Ahmed', email: 'bilal@darraasianmart.example' },
  kuraby: { i: 'KF', tone: 'Teal', store: SETUP.store, slug: SETUP.slug, name: 'Yusuf Karimi', email: SETUP.signIn },
  logan: { i: 'LF', tone: 'Amber', store: 'Logan Family Grocer', slug: 'logan-family-grocer', name: 'Ibrahim Musa', email: 'ibrahim@loganfamilygrocer.example' },
  holland: { i: 'HP', tone: 'Neutral', store: 'Holland Park Bakehouse', slug: 'holland-park-bakehouse', name: 'Mariam Khalil', email: 'mariam@hollandparkbakehouse.example' },
  toowoomba: { i: 'TS', tone: 'Blue', store: 'Toowoomba Spice House', slug: 'toowoomba-spice', name: 'Omar Farouk', email: 'omar@toowoombaspice.example' },
  goldcoast: { i: 'GP', tone: 'Purple', store: 'Gold Coast Pantry', slug: 'gold-coast-pantry', name: 'Aisha Rahman', email: 'aisha@goldcoastpantry.example' },
  noor: { i: 'NP', tone: 'Amber', store: 'Noor Pantry', slug: 'noor-pantry', name: 'Faisal Noor', email: 'faisal@noorpantry.example' },
  gabba: { i: 'WO', tone: 'Teal', store: 'Woolloongabba Grocers', slug: 'gabba-grocers', name: 'Zainab Ali', email: 'zainab@gabbagrocers.example' },
  moorooka: { i: 'MG', tone: 'Blue', store: 'Moorooka Grocer', slug: 'moorooka-grocer', name: 'Rashid Omar', email: 'rashid@moorookagrocer.example' },
  slacks: { i: 'SC', tone: 'Neutral', store: 'Slacks Creek Butchers', slug: 'slacks-creek-butchers', name: 'Khalid Rahimi', email: 'khalid@slackscreekbutchers.example' },
};
// An InfoBanner with a title only (the body layer is hidden), for the one-sentence messages of section 5. An Info banner here shows the
// info icon (an override in this instance): the InfoBanner's own Info icon is badge-check, the certificate chip's glyph, which would read as
// "verified" next to a register result or the certificate slot.
function saBanner(tone, title, action, name) {
  const p = { Tone: tone, Title: title, Body: ' ', 'Show action': !!action }; if (action) p.Action = action;
  const b = inst('InfoBanner', p, { name: name || 'banner', sizeH: 'FILL' });
  const bodyT = b.findOne(function (n) { return n.name === 'body'; }); if (bodyT) bodyT.visible = false;
  if (tone === 'Info') infoIcon(b);
  return b;
}
function infoIcon(b) {
  const ic = b.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'icon-badge-check'; }); if (!ic) return;
  ic.swapComponent(S.icons.info); ic.name = 'icon-info'; recolor(ic, 'text/link');
}
function saLine(s, name, color) { return text(s, 'Body/Small', color || 'text/muted', { name: name || 'note', sizeH: 'FILL' }); }
function linkBtn(label, ic, name) { const p = { Variant: 'Link', Size: 'Sm', State: 'Default', Label: label }; if (ic) { p['Leading icon'] = true; p.Icon = { icon: ic }; } return inst('Button', p, { name: name || 'link' }); }
function backTo(label) { return inst('Button', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Label: label, 'Leading icon': true, Icon: { icon: 'chevron-left' } }, { name: 'back' }); }
// A card with a CardHeader and a padded body.
function saCard(title, kids, o) { o = o || {}; return card(title, [header(title, o.action || null), frame({ name: 'body', dir: 'V', gap: o.gap || 'space/3', pad: [0, 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, kids)], o.w ? { sizeH: null, w: o.w } : undefined); }

// A DataRow: o = { label, value, compare, valueLabel, compareLabel, state, narrow, note, flag: [tone, leading, label, icon], action, second }
function saRow(o) {
  const p = { Layout: o.compare !== undefined ? 'Compare' : 'Single', Width: o.narrow ? 'Narrow' : 'Wide', State: o.state || 'Default', Label: o.label, 'Show action': !!o.action, 'Show flag': !!o.flag, 'Show note': !!o.note, 'Show second action': !!o.second };
  if (o.value !== undefined) p.Value = o.value;
  if (o.compare !== undefined) { p['Compare value'] = o.compare; p['Value label'] = o.valueLabel; p['Compare label'] = o.compareLabel; }
  if (o.note) p.Note = o.note;
  const r = inst('DataRow', p, { name: 'row · ' + o.label, sizeH: 'FILL' });
  if (o.flag) setNested(r, 'flag', Object.assign({ Tone: o.flag[0], Leading: o.flag[1] }, prop('Badge', 'Label', o.flag[2]), o.flag[3] ? prop('Badge', 'Icon', S.icons[o.flag[3]].id) : {}));
  if (o.action) setNested(r, 'action', prop('Button', 'Label', o.action));
  if (o.second) setNested(r, 'second-action', prop('Button', 'Label', o.second));
  return r;
}
const FLAG = { matches: ['Success', 'Icon', 'Matches', 'check'], differs: ['Attention', 'Icon', 'Differs', 'alert-circle'], notCompared: ['Neutral', 'None', 'Not compared'], waiting: ['Info', 'Icon', 'Waiting for review', 'clock'], notAccepted: ['Critical', 'Icon', 'Not accepted', 'x'] };
// A reviewer check (CheckboxRow, 1.10.0): c = { label, desc, value, state, required, undo }; "Required" is the row's badge.
function reviewCheck(c) {
  const r = inst('CheckboxRow', { Value: c.value || 'Unchecked', State: c.state || 'Default', Label: c.label, Description: c.desc || SA_NOT_RECORDED, 'Show badge': !!c.required, 'Show undo': !!c.undo }, { name: 'check · ' + c.label, sizeH: 'FILL' });
  if (c.required) setNested(r, 'badge', Object.assign({ Tone: 'Neutral', Leading: 'None' }, prop('Badge', 'Label', 'Required')));
  return r;
}
// A SettingRow (1.10.0): o = { label, desc, state, meta, msg, seg: [segment 1, segment 2], off }
function settingRow(o) {
  const p = { State: o.state || 'Default', Label: o.label, 'Show meta': !!o.meta };
  if (o.desc) p.Description = o.desc;
  if (o.meta) p.Meta = o.meta;
  if (o.msg || SETTINGROW_MSG[p.State]) p.Message = o.msg || SETTINGROW_MSG[p.State][2];
  if (o.seg) p.Control = { comp: S.sets.SegmentedControl.comp };
  const r = inst('SettingRow', p, { name: 'setting · ' + o.label, sizeH: 'FILL' });
  if (!o.desc) { const d = r.findOne(function (n) { return n.name === 'description'; }); if (d) d.visible = false; }
  if (o.seg) {
    setNested(r, 'control', Object.assign(prop('SegmentedControl', 'Segment 1', o.seg[0]), prop('SegmentedControl', 'Segment 2', o.seg[1])));
    const third = r.findOne(function (n) { return n.name === 'segment-3'; }); if (third) third.visible = false;
  } else if (o.off) setNested(r, 'control', { On: 'False' });
  return r;
}
function confirmDlg(name, title, body, primary, o) { o = o || {}; return dlg({ name: name, title: title, text: body, primary: primary, secondary: o.secondary || 'Cancel', tone: o.tone, size: o.size, focusCancel: o.tone === 'Destructive' }); }

// ---- P1 Sellers (Phase 3 frame; ux.md 3.2 P1, F16, F17)
const P1P3_NAME = 'Admin · Sellers (Phase 3)';
const P1P3_TABS = ['Awaiting review', 'Incomplete', 'Changes needed', 'Not approved', 'Approved', 'Suspended', 'Invited', 'All'];
const P1P3_COUNTS = ['5', '2', '1', '1', '3', '1', '1', '13'];
// Awaiting review, oldest first: [seller, kind, since, status, flags]; Since is the date of the current submission. flags: locked (a change
// request, not selectable), busy (a decision is being recorded). All counts each seller once: Kuraby's change request is an approved seller's row.
const P1P3_AWAITING = [['darra', 'New application', '2 Oct 2026'], ['logan', 'New application', '5 Oct 2026'], ['sunnybank', 'New application', '6 Oct 2026'],
  ['kuraby', 'Change request', '7 Oct 2026', 'Approved', { locked: true }], ['holland', 'New application', '7 Oct 2026', null, { busy: true }]];
const P1P3_SELECTED = [0, 1, 2];
const P1P3_INCOMPLETE = [['toowoomba', null, '4 Oct 2026', 'Not in your area yet'], ['goldcoast', null, '6 Oct 2026', 'Not in your area yet']];
const P1P3_APPROVED = [['kuraby', null, '12 Mar 2026', 'Approved'], ['noor', null, '4 Feb 2026', 'Approved'], ['gabba', null, '7 Jul 2026', 'Approved']];
const P1P3_ALL = [['sunnybank', null, '6 Oct 2026', 'Awaiting review'], ['toowoomba', null, '4 Oct 2026', 'Not in your area yet'], ['moorooka', null, '5 Oct 2026', 'Not approved'],
  ['kuraby', null, '12 Mar 2026', 'Approved'], ['slacks', null, '20 Jan 2026', 'Suspended'], ['gabba', null, '6 Oct 2026', 'Invited']];
const SEARCH_HELP = 'Store name, shop web address, or the full ' + SETUP.idLabel + '.';
const SEARCH_DISABLED = 'Search works on All, Awaiting review and Incomplete.';
const BULK_CAP = 'You can select up to 50 sellers at a time.';
const CHANGE_LOCKED = 'Change requests are decided one at a time.';
function p1p3Search(disabled, touch) {
  return frame({ name: 'search', dir: 'V', gap: 'space/1', w: touch ? undefined : 360, sizeH: touch ? 'FILL' : null }, [
    inst('Input', { Type: 'Text', State: disabled ? 'Disabled' : 'Default', Value: 'Search sellers' }, { name: 'search-input', sizeH: 'FILL' }),
    text(disabled ? SEARCH_DISABLED : SEARCH_HELP, 'Caption/Default', 'text/muted', { name: 'search-help', sizeH: 'FILL' }),
  ]);
}
function p1p3SellerCell(m, extra) {
  const lines = [text(m.store, 'Body/Strong', 'text/primary', { name: 'store', sizeH: 'FILL', truncate: true }), text(m.slug, 'Caption/Default', 'text/muted', { name: 'slug', sizeH: 'FILL', truncate: true }),
    text(m.name + ' · ' + m.email, 'Caption/Default', 'text/muted', { name: 'owner', sizeH: 'FILL', truncate: true })];
  if (extra) lines.push(text(extra, 'Caption/Default', 'text/secondary', { name: 'note', sizeH: 'FILL' }));
  return [inst('IdentityTile', { Tone: m.tone, Shape: 'Rounded', Initials: m.i }), frame({ name: 'seller', dir: 'V', sizeH: 'FILL' }, lines)];
}
function addChip(label, name) {
  const c = inst('FilterChip', { Type: 'Add' }, { name: name });
  const t = c.findOne(function (n) { return n.name === 'add-label'; }); if (t) t.characters = '+ ' + label;
  return c;
}
function selectHeader(value, state) { return frame({ name: 'th select', dir: 'H', w: 56, h: 42, align: 'center', justify: 'center', fill: 'bg/subtle', stroke: 'border/default', sides: ['bottom'] }, [inst('Checkbox', { Value: value, State: state || 'Default' }, { name: 'select-all' })]); }
// o: { tab, rows, selected (indexes), select (checkbox column), viewOnly }
function p1p3Table(o) {
  const awaiting = o.tab === 'Awaiting review';
  const cols = [['Seller', 'fill'], ['Status', 200]].concat(awaiting ? [['Kind', 160]] : [], [['Since', 130], ['', 56]]);
  const head = headerRow(cols);
  if (o.select) {
    const sel = (o.selected || []).length; const free = o.rows.filter(function (r) { return !(r[4] && (r[4].locked || r[4].busy)); }).length;
    head.insertChild(0, selectHeader(sel === 0 ? 'Unchecked' : (sel === free ? 'Checked' : 'Indeterminate'), o.viewOnly ? 'Disabled' : 'Default'));
  }
  const kids = [head];
  o.rows.forEach(function (r, i) {
    const m = SA_SELLERS[r[0]]; const f = r[4] || {}; const on = (o.selected || []).indexOf(i) >= 0;
    const cells = [];
    if (o.select) cells.push([inst('Checkbox', { Value: on ? 'Checked' : 'Unchecked', State: o.viewOnly || f.locked || f.busy ? 'Disabled' : 'Default' }, { name: 'select' }), 56, { justify: 'center' }]);
    cells.push([p1p3SellerCell(m, f.locked ? CHANGE_LOCKED : null), 'fill']);
    cells.push([f.busy ? frame({ name: 'status', dir: 'V', gap: 'space/1' }, [saBadge(r[3] || 'Awaiting review'), text('Decision being recorded', 'Caption/Default', 'text/secondary', { name: 'busy' })]) : saBadge(r[3] || 'Awaiting review'), 200]);
    if (awaiting) cells.push([text(r[1], 'Body/Default'), 160]);
    cells.push([text(r[2], 'Body/Default'), 130], [f.busy ? null : rowAction(), 56, { justify: 'center' }]);
    kids.push(row(cells, on, false, f.locked ? 96 : 80));
  });
  return card('Seller list', kids);
}
function bulkBar(count, cap) {
  const bar = inst('BulkActionBar', {}, { name: 'BulkActionBar' });
  setNested(bar, 'count-badge', prop('CountBadge', 'Count', count));
  setNested(bar, 'action-3', prop('Button', 'Label', 'Reject…'));
  const two = bar.findOne(function (n) { return n.name === 'action-2'; }); if (two) two.visible = false;
  const kids = [bar];
  if (cap) kids.push(frame({ name: 'cap', dir: 'H', gap: 'space/1-5', align: 'center' }, [icon('info', 'status/attention/fg', 16), text(BULK_CAP, 'Body/Small Strong', 'status/attention/fg', { name: 'cap-text' })]));
  return frame({ name: 'bulk-wrap', dir: 'H', gap: 'space/3', align: 'center', justify: 'center', sizeH: 'FILL' }, kids);
}
// state: null (Awaiting review), Selected, Selection limit, Incomplete, Approved, View only
function tplP1P3(state) {
  const tab = { Incomplete: 'Incomplete', Approved: 'Approved', 'View only': 'All' }[state] || 'Awaiting review';
  const view = state === 'View only', limit = state === 'Selection limit';
  const counts = limit ? ['64'].concat(P1P3_COUNTS.slice(1, 7), ['72']) : P1P3_COUNTS;
  const kids = [pageTitle('Sellers', (limit ? '72' : '13') + ' sellers in the ' + SA_MARKET + ' market', [primaryHeaderButton('Add seller', view ? 'Disabled' : 'Default')])];
  if (view) kids.push(text(SELLERS_VIEW_ONLY, 'Body/Small', 'text/muted', { name: 'view-only-help', sizeH: 'FILL' }));
  const chips = [];
  if (tab === 'Awaiting review') chips.push(addChip('Kind', 'kind-filter'));
  if (tab === 'All') chips.push(addChip('Needs a check', 'needs-check-filter'));
  if (tab === 'Incomplete') chips.push(inst('FilterChip', { Type: 'Applied', Label: 'Outside service area' }, { name: 'outside-filter' }));
  kids.push(frame({ name: 'filters', dir: 'H', gap: 'space/3', align: 'start', sizeH: 'FILL' }, [p1p3Search(tab === 'Approved')].concat(chips)));
  kids.push(tabsBar(P1P3_TABS.map(function (t, i) { return [t, counts[i], t === tab]; })));
  const rows = { Incomplete: P1P3_INCOMPLETE, Approved: P1P3_APPROVED, All: P1P3_ALL }[tab] || P1P3_AWAITING;
  const selected = state === 'Selected' ? P1P3_SELECTED : (limit ? P1P3_SELECTED : []);
  kids.push(p1p3Table({ tab: tab, rows: rows, select: tab === 'Awaiting review', selected: selected }));
  if (state === 'Selected' || limit) kids.push(bulkBar(limit ? '50' : '3', limit));
  const scr = screen(P1P3_NAME + (state ? ' · ' + state : ''), 'Admin', 'nav-sellers', 'Sellers', kids, { minH: PANEL_MIN_H, gap: 'space/5' });
  // View only (All tab): the menu of an approved seller; viewing stays, the identity actions are disabled with the reason (ux.md 3.0 rule 6).
  if (view) openUnderRow(scr, 3, actionMenu([['Default', 'Open', 'eye'], ['Disabled', 'Reset owner’s two-step verification…', 'smartphone', SELLERS_VIEW_ONLY], ['Disabled', 'Suspend…', 'ban', SELLERS_VIEW_ONLY]]));
  return scr;
}
// Empty per tab (ux.md 3.5); a sentence is split into title and body where it has two.
const P1P3_EMPTY = { 'Awaiting review': ['check', 'No sellers are waiting', 'You’re up to date.'], Incomplete: ['clipboard', 'No incomplete applications.'], 'Changes needed, Not approved, Approved, Suspended, Invited': ['users', 'No sellers here.'],
  'Outside service area': ['map-pin', 'No sellers are outside the service area.'], 'Search with no result': ['search', 'No sellers match.', null, 'Clear search'] };
function p1p3Empty(s) {
  const d = P1P3_EMPTY[s];
  const es = inst('EmptyState', { Size: 'Card', Icon: { icon: d[0] }, Title: d[1], Body: d[2] || ' ', 'Show action': !!d[3] }, { name: 'empty-state', sizeH: 'FILL' });
  if (!d[2]) { const b = es.findOne(function (n) { return n.name === 'body'; }); if (b) b.visible = false; }
  if (d[3]) setNested(es, 'action', prop('Button', 'Label', d[3]));
  return es;
}
function tplP1P3Empty() { return stateBoard(P1P3_NAME + ' · Empty states', 'Sellers: empty states', 'The table body when a tab, the outside-area filter or a search has nothing (ux.md 3.5). The tabs, search and header stay. A list that cannot load is the Critical banner with "Try again", not an empty state.', Object.keys(P1P3_EMPTY), p1p3Empty); }
// Below 760 px each row is a card with the same actions menu and no bulk selection (ux.md 6).
function tplP1P3Phone() {
  const kids = [text('Sellers', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), fullButton('Add seller'), p1p3Search(false, true), panelField('Status', { select: { state: 'Filled', value: 'Awaiting review (5)' } })];
  P1P3_AWAITING.slice(0, 3).forEach(function (r) {
    const m = SA_SELLERS[r[0]];
    kids.push(frame({ name: m.store, dir: 'V', gap: 'space/3', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
      frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [inst('IdentityTile', { Tone: m.tone, Shape: 'Rounded', Initials: m.i }), frame({ name: 'seller', dir: 'V', sizeH: 'FILL' }, [text(m.store, 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), text(m.name + ' · ' + m.email, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true })]), rowAction(true)]),
      frame({ name: 'status', dir: 'H', gap: 'space/2', align: 'center', wrap: true, rowGap: 'space/1', sizeH: 'FILL' }, [saBadge(r[3] || 'Awaiting review'), text(r[1] + ' · Since ' + r[2], 'Caption/Default', 'text/muted')]),
    ]));
  });
  const scr = phoneScreen(P1P3_NAME + ' (phone)', 'Admin', kids, null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- P3 Review a submission (ux.md 3.2 P3 and 3.2a, F16)
const P3_NAME = 'Admin · Seller review';
const P3_APP = { seller: 'sunnybank', business: 'Sunnybank Spice Market Pty Ltd', register: 'SUNNYBANK SPICE MARKET PTY LTD', abn: '51 824 753 556', street: '12 Mains Road', locality: 'Sunnybank', postcode: '4109', registerPostcode: '4110',
  phone: '0423 456 789', contact: 'hello@sunnybankspice.example', submission: '2', submitted: '6 Oct 2026, 9:40 AEST', queue: '2 days in the queue' };
// The approved seller behind the change request (the S2 to S6 sample values).
const P3_CHANGE = { seller: 'kuraby', business: SETUP.business, register: 'KURABY FRESH PTY LTD', abn: SETUP.abn, street: SETUP.street, locality: SETUP.locality, postcode: SETUP.postcode, registerPostcode: SETUP.postcode, phone: SETUP.phone };
const STORE_CHECK = 'Store name makes no certification claim and doesn’t imitate another brand.';
const MANUAL_CHECK = 'Record a manual register check';
// Market-configured checks (samples, except the store-name check, which ux.md names): [label, required]
const P3_CHECKS = [[STORE_CHECK, true], ['Business name matches the official register', true], ['Called the business phone number', false]];
const REGISTER = {
  active: ['Info', 'The official register lists this number as active.'], negative: ['Critical', 'The register doesn’t list this number as active.'], 'not-performed': ['Attention', 'Lookup not performed.'],
  unavailable: ['Attention', 'The register couldn’t be reached.'], stale: ['Attention', 'The last lookup is out of date.'], none: ['Info', 'This Market has no register lookup. Record a manual check.'] };
const APPROVE_BLOCK = { 'checks-missing': 'Record 2 required checks first.', 'register-blocks': 'Approve is unavailable while the register result is negative.', 'register-lookup': 'Look it up again or record a manual check first.',
  'not-current-revision': 'This isn’t the current submission.', 'identifier-held': 'Another approved or suspended seller already holds this number.', 'decision-in-progress': 'A decision is being recorded.' };
// The register banner and what goes with it: "Look up again" with the time of the last lookup, or the manual link (admins only, server-built, new tab).
function registerBlock(state) {
  const r = REGISTER[state];
  const kids = [saBanner(r[0], r[1], null, 'register-banner')];
  const tools = state === 'none' ? [] : [inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Look up again', 'Leading icon': true, Icon: { icon: 'refresh-cw' } }, { name: 'look-up-again' })];
  if (state === 'active' || state === 'negative') tools.push(saLine('Looked up on 6 Oct 2026, 9:41 AEST', 'looked-up'));
  if (state === 'not-performed' || state === 'unavailable' || state === 'stale' || state === 'none') tools.push(linkBtn('Open the register’s search page', 'external-link', 'manual-link'));
  kids.push(frame({ name: 'register-tools', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, tools));
  return frame({ name: 'register', dir: 'V', gap: 'space/3', pad: [0, 'space/5', 'space/3', 'space/5'], sizeH: 'FILL' }, kids);
}
function compareRow(label, value, register, flag, note, changed) { return saRow({ label: label, value: value, compare: register, valueLabel: 'Seller entered', compareLabel: 'Official register', flag: flag, note: note, state: changed ? 'Changed' : 'Default' }); }
function registerCard(o) {
  const a = o.change ? P3_CHANGE : P3_APP; const m = SA_SELLERS[a.seller]; const nc = FLAG.notCompared;
  const rows = [];
  if (o.register === 'active') {
    rows.push(compareRow('Business name', a.business, a.register, FLAG.matches, null, !o.change));
    rows.push(compareRow(SETUP.taxQuestion, 'Yes, from ' + SETUP.taxFrom, 'Registered from ' + SETUP.taxFrom, FLAG.matches));
    rows.push(a.postcode === a.registerPostcode ? compareRow('Postcode', a.postcode, a.registerPostcode, FLAG.matches) : compareRow('Postcode', a.postcode, a.registerPostcode, FLAG.differs, 'Differs from the register. Check before you approve.'));
  } else rows.push(saRow({ label: 'Business name', value: a.business, flag: nc, state: o.change ? 'Default' : 'Changed' }));
  rows.push(saRow({ label: 'Store name', value: m.store, flag: nc }), saRow({ label: SETUP.idLabel, value: a.abn, flag: nc }), saRow({ label: 'Operating address', value: a.street + ', ' + a.locality + ' ' + SETUP.region + ' ' + a.postcode, flag: nc }),
    saRow({ label: 'Phone', value: a.phone, flag: nc }), saRow({ label: 'Shop web address', value: SETUP.storefront + m.slug, flag: nc }));
  return card('Details against the register', [header('Details against the register', null), registerBlock(o.register)].concat(rows, [
    frame({ name: 'disclaimer', dir: 'H', pad: ['space/3', 'space/5', 'space/4', 'space/5'], sizeH: 'FILL' }, [saLine('A match doesn’t prove the applicant controls the business.', 'disclaimer-text')])]));
}
// o.checks: per check [value, state] in P3_CHECKS order; o.manual adds the manual register check; o.readOnly for a withdrawn or decided submission.
function checksCard(o) {
  const rows = P3_CHECKS.map(function (c, i) {
    const s = (o.checks || [])[i] || ['Unchecked', 'Default']; const rec = s[0] === 'Checked' && s[1] !== 'Saving';
    return reviewCheck({ label: c[0], required: c[1], value: s[0], state: o.readOnly ? 'Read-only' : s[1], desc: rec ? SA_RECORDED : SA_NOT_RECORDED, undo: rec && !o.readOnly });
  });
  if (o.manual) rows.push(reviewCheck({ label: MANUAL_CHECK, required: true, desc: 'Check the number on the register’s search page, then record it here.' }));
  const done = (o.checks || []).filter(function (s) { return s[0] === 'Checked' && s[1] !== 'Saving'; }).length;
  return card('Checks', [frame({ name: 'card-header', dir: 'H', justify: 'between', align: 'center', pad: [16, 18, 12, 18], sizeH: 'FILL' }, [text('Checks', 'Heading/H2'), text(done + ' of ' + rows.length + ' recorded', 'Body/Small', 'text/muted', { name: 'progress' })])].concat(rows));
}
function changesCard() {
  return card('Changes since the last submission', [header('Changes since the last submission', null), saRow({ label: 'Business name', value: P3_APP.business, state: 'Changed', note: 'Before: Sunnybank Spice Pty Ltd' })]);
}
function historyCard(events, empty) {
  const body = empty ? [saLine(empty, 'empty')] : events.map(function (e) { const p = { Tone: e[0], Who: e[1], What: e[2], When: e[3], 'Show quote': !!e[4] }; if (e[4]) p.Quote = e[4]; return inst('TimelineItem', p, { sizeH: 'FILL' }); });
  return card('History', [header('History', null), frame({ name: 'events', dir: 'V', pad: [0, 18, 6, 18], sizeH: 'FILL' }, body)]);
}
const P3_HISTORY = [['Teal', 'Hana Yusuf', 'submitted again', P3_APP.submitted], ['Blue', SA_REVIEWER, 'asked for changes', '3 Oct 2026, 11:05 AEST', 'Use the legal name of your business, then submit again.'],
  ['Teal', 'Hana Yusuf', 'submitted the application', '29 Sep 2026, 9:40 AEST']];
function sideCard(title, kids) { return card(title, [header(title, null), frame({ name: 'body', dir: 'V', gap: 'space/3', pad: [0, 18, 18, 18], sizeH: 'FILL' }, kids)]); }
function otherSellers(list) {
  if (!list.length) return [saLine('None found.', 'none')];
  return list.map(function (o) { return frame({ name: o[0], dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [frame({ name: 'seller', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(o[0], 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), saBadge(o[1])]), linkBtn('Open', null, 'open')]); });
}
function p3Side(o) {
  return frame({ name: 'Side', dir: 'V', gap: 'space/4', w: 360 }, [
    sideCard('Status', [saBadge(o.status || 'Awaiting review'), readOnlyPair('Email confirmed', 'Yes'), readOnlyPair('Time in the queue', o.queue || P3_APP.queue)]),
    sideCard('Service area and time zone', [readOnlyPair('Service area', 'Greater Brisbane'), readOnlyPair('Work time zone', SETUP.zone + ' (' + SETUP.zoneId + ')')]),
    sideCard('Other sellers with this ' + SETUP.idLabel, otherSellers(o.others || [])),
  ]);
}
// The decision buttons; a disabled Approve names the missing item beside it, in text (ux.md 3.2a).
function decisionButtons(o) {
  const approve = btn(o.change ? 'Approve change' : 'Approve', 'Primary', 'Md', { State: o.block || o.busy ? 'Disabled' : 'Default' });
  const reject = btn(o.change ? 'Reject change…' : 'Reject…', 'Destructive', 'Md', { State: o.busy ? 'Disabled' : 'Default' });
  return [reject, approve];
}
function blockReason(text_, link) {
  return frame({ name: 'decision-reason', dir: 'H', gap: 'space/1-5', align: 'center', justify: 'end', sizeH: 'FILL' }, [icon('info', 'icon/muted', 16), text(text_, 'Body/Small Strong', 'text/secondary', { name: 'reason-text' }), link ? linkBtn(link, null, 'reason-link') : null]);
}
// o: { register, checks, manual, block, change, withdrawn, others, history }
function tplP3(state, o) {
  const m = SA_SELLERS[o.change ? 'kuraby' : P3_APP.seller];
  const kind = bdg('Neutral', 'None', o.change ? 'Change request' : 'New application');
  const meta = 'Submission ' + (o.change ? '4' : P3_APP.submission) + ' · Submitted on ' + (o.change ? '7 Oct 2026, 8:15 AEST' : P3_APP.submitted) + ' · Submitted by the seller · ' + (o.change ? '1 day in the queue' : P3_APP.queue);
  const head = [backTo('Sellers'), pageTitle('Review ' + m.store, meta, o.withdrawn ? [] : decisionButtons(o), kind)];
  if (o.block) head.push(blockReason(APPROVE_BLOCK[o.block]));
  const kids = [frame({ name: 'Header', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, head)];
  if (o.withdrawn) kids.push(saBanner('Info', 'This submission was withdrawn.', 'Back to sellers', 'withdrawn'));
  const main = [];
  if (o.change) main.push(card('Requested change', [header('Requested change', null), saRow({ label: 'Store name', value: SETUP.store, compare: 'Kuraby Fresh Grocers', valueLabel: 'Current', compareLabel: 'Requested', state: 'Changed' })]));
  main.push(registerCard(o), checksCard(o));
  if (!o.change) main.push(changesCard());
  main.push(o.change ? historyCard([['Teal', 'Yusuf Karimi', 'asked to change the store name', '7 Oct 2026, 8:15 AEST'], ['Blue', SA_REVIEWER, 'approved the seller', '12 Mar 2026, 10:02 AEST']]) : historyCard(P3_HISTORY));
  kids.push(frame({ name: 'Body', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [frame({ name: 'Main column', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, main),
    p3Side({ others: o.others, status: o.change ? 'Approved' : (o.withdrawn ? 'Ready to submit' : 'Awaiting review'), queue: o.change ? '1 day' : null })]));
  return screen(P3_NAME + ' · ' + state, 'Admin', 'nav-sellers', 'Sellers', kids, { minH: PANEL_MIN_H, gap: 'space/5', pad: [24, 32, 40, 32] });
}
const P3_ALL_DONE = [['Checked', 'Default'], ['Checked', 'Default'], ['Unchecked', 'Default']];
const P3_OTHERS = [['Sunnybank Spice Co', 'Not approved']];
const P3_FRAMES = [
  ['Application', { register: 'active', checks: P3_ALL_DONE, others: P3_OTHERS }],
  ['Checks missing', { register: 'active', checks: [['Checked', 'Saving'], ['Unchecked', 'Default'], ['Unchecked', 'Default']], block: 'checks-missing', others: P3_OTHERS }],
  ['Register negative', { register: 'negative', checks: P3_ALL_DONE, block: 'register-blocks', others: [] }],
  ['Lookup not performed', { register: 'not-performed', checks: P3_ALL_DONE, manual: true, block: 'register-lookup', others: [] }],
  ['Change request', { register: 'active', checks: [['Checked', 'Default'], ['Checked', 'Default'], ['Unchecked', 'Default']], change: true, others: [] }],
  ['Withdrawn', { register: 'active', checks: P3_ALL_DONE, withdrawn: true, readOnly: true, others: P3_OTHERS }],
];
// Every register state of 3.2a: the banner, its tools and what it does to Approve.
const REGISTER_EFFECT = { active: 'Mismatches are flagged on the rows. Approve is allowed.', negative: 'Approve is disabled: "' + APPROVE_BLOCK['register-blocks'] + '" Reject is allowed.', 'not-performed': 'Approve is disabled until a lookup succeeds or a manual check is recorded: "' + APPROVE_BLOCK['register-lookup'] + '"',
  unavailable: 'As Lookup not performed.', stale: 'A result older than the maximum age (30 days) counts as not performed.', none: 'The Market has no register adapter; the manual link shows when the Market has one. Approve needs the manual check.' };
function tplP3Register() {
  return stateBoard(P3_NAME + ' · Register states', 'Seller review: register states', 'The banner at the top of "Details against the register" for each register state (ux.md 3.2a). Admins only; the register\'s values never reach a seller screen.', Object.keys(REGISTER), function (s) {
    return frame({ name: 'state', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [registerBlock(s), saLine(REGISTER_EFFECT[s], 'effect', 'text/secondary')]);
  });
}
function tplP3Blocked() {
  const links = { 'identifier-held': 'Open that seller' };
  return stateBoard(P3_NAME + ' · Approve disabled', 'Seller review: Approve disabled', 'Approve is disabled when the API\'s denial code says so; the missing item is text beside the button, never a tooltip (ux.md 3.2a). During a decision both buttons are disabled.', Object.keys(APPROVE_BLOCK), function (s) {
    const busy = s === 'decision-in-progress';
    return frame({ name: 'state', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [frame({ name: 'buttons', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, decisionButtons({ block: s, busy: busy })), blockReason(APPROVE_BLOCK[s], links[s])]);
  });
}

// ---- P2 Seller page (ux.md 3.2 P2, F18, C1 and P2-H)
const P2_NAME = 'Admin · Seller detail';
const P2_AI_HELP = 'Turns AI suggestions on or off for this shop. AI never decides approvals, certificates or payments.';
const C1_LOCK_ROLE = 'Your role can view these settings but not change them.';
const C1_LOCK_TYPES = 'Restricting types arrives with the product catalog.';
const C1_META = 'Changed by ' + SA_REVIEWER + ' on 6 Oct 2026';
function certSlot() { return frame({ name: 'certification-slot', dir: 'H', px: 'space/2', py: 'space/1', stroke: 'border/input', dash: [4, 4], radius: 'radius/pill' }, [text('Certificate chip (certification)', 'Caption/Default', 'text/muted')]); }
// C1 Admin-only settings: o.locked (role), o.state per row
function c1Rows(o) {
  o = o || {};
  const lock = o.locked ? { state: 'Locked', msg: C1_LOCK_ROLE } : {};
  return [
    settingRow({ label: 'Allowed product types', seg: ['All types', 'Only selected types'], state: 'Locked', msg: o.locked ? C1_LOCK_ROLE : C1_LOCK_TYPES }),
    settingRow(Object.assign({ label: 'Category proposals', desc: 'Lets this seller suggest categories.', off: true, meta: C1_META }, lock)),
    settingRow(Object.assign({ label: 'AI features', desc: P2_AI_HELP, off: true }, lock)),
  ];
}
function c1Card(o) {
  return card('Admin-only settings', [frame({ name: 'card-header', dir: 'V', gap: 'space/0-5', pad: [16, 18, 8, 18], sizeH: 'FILL' }, [text('Admin-only settings', 'Heading/H2'), text('The seller can’t change these.', 'Body/Small', 'text/muted', { name: 'subtitle' })])].concat(c1Rows(o)));
}
function businessCard(s) {
  return card('Business details', [header('Business details', null)].concat(s.rows.map(function (r) { return saRow({ label: r[0], value: r[1] }); })));
}
const P2_KURABY = { seller: 'kuraby', status: 'Seller approved', since: 'Approved on 12 Mar 2026, 10:02 AEST', rows: [['Store name', SETUP.store], ['Business name', SETUP.business], [SETUP.idLabel, SETUP.abn],
  ['Operating address', SETUP.street + ', ' + SETUP.locality + ' ' + SETUP.region + ' ' + SETUP.postcode], ['Phone', SETUP.phone], ['Contact email', SETUP.contact], ['Work time zone', SETUP.zone + ' (' + SETUP.zoneId + ')'],
  ['Shop web address', SETUP.storefront + SETUP.slug], [SETUP.taxQuestion, 'Yes, from ' + SETUP.taxFrom], ['Created', '3 Mar 2026'], ['Origin', 'Self-registered']] };
const P2_MOOROOKA = { seller: 'moorooka', status: 'Not approved', since: 'Not approved on 5 Oct 2026, 15:20 AEST', rows: [['Store name', 'Moorooka Grocer'], ['Business name', 'Moorooka Grocer Pty Ltd'], [SETUP.idLabel, '83 914 562 007'],
  ['Operating address', '88 Beaudesert Road, Moorooka ' + SETUP.region + ' 4105'], ['Phone', '0431 222 908'], ['Work time zone', SETUP.zone + ' (' + SETUP.zoneId + ')'], ['Shop web address', SETUP.storefront + 'moorooka-grocer'], ['Created', '28 Sep 2026'], ['Origin', 'Invited by MondaPac']],
  reason: 'The business details you gave don’t meet our requirements for new shops.' };
function p2Header(s, o) {
  const m = SA_SELLERS[s.seller];
  const edit = function () { return btn('Edit details', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'pencil' } }); };
  let actions = [];
  if (o.viewOnly || o.edit) actions = [];
  else if (s.status === 'Not approved') actions = [edit(), btn('Allow one more application', 'Primary', 'Md')];
  else actions = [edit(), btn('Change web address', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'globe' } }), btn('Correct time zone', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'clock' } })];
  const kids = [backTo('Sellers'), pageTitle(m.store, m.name + ' · ' + m.email, actions, frame({ name: 'badges', dir: 'H', gap: 'space/2', align: 'center' }, [saBadge(s.status), certSlot()]))];
  if (o.viewOnly) kids.push(text(SELLERS_VIEW_ONLY, 'Body/Small', 'text/muted', { name: 'view-only-help', sizeH: 'FILL' }));
  return frame({ name: 'Header', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, kids);
}
function p2Side(s) {
  const kids = [saBadge(s.status), saLine(s.since, 'since', 'text/secondary')];
  if (s.reason) kids.push(inst('ReasonQuote', { Label: 'Reason sent to the seller', Reason: s.reason, Date: 'Written on 5 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }));
  kids.push(readOnlyPair('Decisions', s.reason ? '1 change request, 1 not approved' : '1 approval'), linkBtn('Open the last review', null, 'last-review'));
  return frame({ name: 'Side', dir: 'V', gap: 'space/4', w: 360 }, [sideCard('Status', kids)]);
}
function certificatesSlot() {
  return card('Certificates', [header('Certificates', null), frame({ name: 'slot', dir: 'H', pad: [0, 18, 18, 18], sizeH: 'FILL' }, [frame({ name: 'certification-slot', dir: 'H', px: 'space/3', py: 'space/4', stroke: 'border/input', dash: [4, 4], radius: 'radius/control', sizeH: 'FILL' }, [text('Slot for the certificates card (owned by certification)', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })])])]);
}
// state: null, Edit, Not approved, View only, History
function tplP2(state) {
  const s = state === 'Not approved' ? P2_MOOROOKA : P2_KURABY; const view = state === 'View only', edit = state === 'Edit';
  const kids = [p2Header(s, { viewOnly: view, edit: edit })];
  if (!edit) kids.push(tabsBar([['Overview', null, state !== 'History'], ['History', null, state === 'History']]));
  let main;
  if (state === 'History') main = [p2History()];
  else if (edit) main = p2Edit();
  else main = [businessCard(s), c1Card({ locked: view }), certificatesSlot()];
  kids.push(frame({ name: 'Body', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [frame({ name: 'Main column', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, main), p2Side(s)]));
  return screen(P2_NAME + (state ? ' · ' + state : ''), 'Admin', 'nav-sellers', 'Sellers', kids, { minH: PANEL_MIN_H, gap: 'space/5', pad: [24, 32, 40, 32] });
}
// Edit an approved seller (F18 steps 1 and 2): the S2 to S5 fields, the checks and the register state of P3, one save that applies at once.
function p2Edit() {
  const checks = card('Checks', [header('Checks', null), reviewCheck({ label: STORE_CHECK, required: true, value: 'Checked', desc: SA_RECORDED, undo: true }), reviewCheck({ label: P3_CHECKS[1][0], required: true })]);
  const bar = setupBar({ primary: 'Save changes', secondary: 'Cancel', state: 'Dirty', disabled: true });
  return [saBanner('Info', 'Changes to business identity apply at once and the owner is emailed.', null, 'edit-banner'),
    setupCard('Business details', [setupField('Store name', { value: SETUP.store, helper: STORE_HELP }), setupField('Business name', { value: 'Kuraby Fresh Grocers Pty Ltd' }), setupField('Phone', { value: SETUP.phone }), setupField('Contact email', { value: SETUP.contact, optional: true })]),
    setupCard('Address and area', addressFields(false)), setupCard('Business number', [numberField('Matched')]),
    card('Register', [header('Details against the register', null), registerBlock('active')]), checks,
    frame({ name: 'save', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [blockReason('Record 1 required check first.'), saLine('Changes to business identity apply at once and the owner is emailed.', 'save-note', 'text/secondary'), bar])];
}
// P2-H: revisions with their values hidden until "Show values" (protected permission; each reveal is recorded).
function p2History() {
  const cols = [['Date', 220], ['Kind', 200], ['Author', 160], ['Result', 'fill']];
  const rows = [['12 Mar 2026, 10:02 AEST', 'Decision', 'Admin', 'Approved'], ['11 Mar 2026, 16:40 AEST', 'Submission', 'Seller', 'Submitted again'], ['6 Mar 2026, 11:05 AEST', 'Decision', 'Admin', 'Changes needed'], ['4 Mar 2026, 9:12 AEST', 'Submission', 'Seller', 'Submitted']];
  return card('History', [frame({ name: 'card-header', dir: 'H', gap: 'space/3', align: 'center', pad: [16, 18, 12, 18], sizeH: 'FILL' }, [text('History', 'Heading/H2'), frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), saLine('Viewing this is recorded.', 'reveal-notice'), btn('Show values', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'eye' } })]),
    headerRow(cols)].concat(rows.map(function (r) { return row([[text(r[0], 'Body/Default'), 220], [text(r[1], 'Body/Default'), 200], [text(r[2], 'Body/Default'), 160], [text(r[3], 'Body/Default'), 'fill']]); })));
}
const P2_BANNERS = { 'Invited, not accepted': ['Info', 'This seller hasn’t accepted the invitation yet.'], Suspended: ['Critical', 'This seller is suspended.', 'View reason'],
  'Needs a check': ['Critical', 'This seller is approved but has no reviewed details. They can’t sell until this is checked.'], 'Decision under way': ['Attention', 'A decision is being recorded for this seller. Refresh in a moment.'] };
const P2_EDIT_BANNERS = { Approved: ['Info', 'Changes to business identity apply at once and the owner is emailed.'], 'Awaiting review': ['Attention', 'Saving withdraws the pending submission.'],
  Suspended: ['Attention', 'This seller is suspended. Your edit changes business data only.'], Invited: ['Info', 'This seller hasn’t accepted the invitation yet. Your edit changes their saved details.'],
  'Only seller.edit': ['Attention', 'You also need permission to approve identity changes.'], 'Change pending': ['Attention', 'A change request is waiting. Decide it first.', 'Open the request'] };
function tplP2Banners() { return stateBoard(P2_NAME + ' · Banners', 'Seller page: banners', 'One banner under the summary bar by the seller\'s state (ux.md 3.2 P2, F18 step 7). "Needs a check" has no action until a mini-review designs one.', Object.keys(P2_BANNERS), function (s) { const b = P2_BANNERS[s]; return saBanner(b[0], b[1], b[2]); }); }
function tplP2EditBanners() { return stateBoard(P2_NAME + ' · Edit banners', 'Seller page: edit banners', 'The banner at the top of the edit form (F18 steps 1 and 2). With only the edit permission, Save stays disabled with the same text beside it and nothing is sent.', Object.keys(P2_EDIT_BANNERS), function (s) { const b = P2_EDIT_BANNERS[s]; return saBanner(b[0], b[1], b[2]); }); }
const C1_STATES = { Default: { label: 'Category proposals', desc: 'Lets this seller suggest categories.', off: true }, Saving: { label: 'Category proposals', desc: 'Lets this seller suggest categories.', state: 'Saving' },
  'Saved, with who and when': { label: 'AI features', desc: P2_AI_HELP, meta: C1_META }, 'Locked by role': { label: 'Category proposals', desc: 'Lets this seller suggest categories.', off: true, state: 'Locked', msg: C1_LOCK_ROLE },
  'Locked until the catalog': { label: 'Allowed product types', seg: ['All types', 'Only selected types'], state: 'Locked', msg: C1_LOCK_TYPES }, 'Save failed': { label: 'Category proposals', desc: 'Lets this seller suggest categories.', off: true, state: 'Error' } };
function tplC1States() { return stateBoard(P2_NAME + ' · Admin-only settings states', 'Admin-only settings: row states', 'Each row saves on its own after a confirm dialog (F19). A failed save puts the old value back and says so; a locked row gives its reason in text.', Object.keys(C1_STATES), function (s) { return settingRow(C1_STATES[s]); }); }

// ---- P4 Seller settings (Market; ux.md 3.2 P4, F20)
const P4_NAME = 'Shared · Settings · Seller settings';
function p4Row(o) { return settingRow(Object.assign({ label: 'Require approval for new sellers', desc: 'New sign-ups wait for a person to approve them.', meta: C1_META }, o || {})); }
function tplP4(state) {
  const view = state === 'View only';
  return screen(P4_NAME + (state ? ' · ' + state : ''), 'Admin', 'nav-settings', 'Settings', [
    pageTitle('Seller settings', SA_MARKET, []),
    frame({ name: 'content', dir: 'V', gap: 'space/3', w: 'size/form-max' }, [card('Seller settings', [p4Row(view ? { state: 'Locked', msg: C1_LOCK_ROLE } : null)]), saLine('Applies to new sign-ups in ' + SA_MARKET + ' only.', 'market-note')]),
  ], { minH: PANEL_MIN_H });
}
function tplP4States() {
  const st = { Default: {}, Saving: { state: 'Saving', off: true }, 'Locked (view only)': { state: 'Locked', msg: C1_LOCK_ROLE }, 'Save failed': { state: 'Error' } };
  return stateBoard(P4_NAME + ' · States', 'Seller settings: states', 'Turning approval off opens a destructive confirm dialog with its consequences; turning it on, a plain one (ux.md 3.4). A failed save puts the old value back.', Object.keys(st), function (s) { return p4Row(st[s]); });
}

// ---- Dialogs (ux.md 3.4): D3 uses, D4 modes, D7, D8, D9, D10
const PREPARED = 'Business details incomplete';
const PREPARED_TEXT = 'Some of the business details you gave are incomplete. Check them and submit again.';
function preparedSelect(state, value) { return panelField('Prepared reason', { select: { state: state, value: value } }); }
function preview(label, value) { return frame({ name: 'preview', dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text(label, 'Caption/Default', 'text/muted'), text(value, 'Body/Default', 'text/primary', { name: 'preview-text', sizeH: 'FILL' })]); }
function bodyRejectApplication() {
  const ta = S.sets.Textarea.set.children.filter(function (c) { return c.name === 'State=Default'; })[0];
  const f = inst('Field', { Label: 'Reason for the seller', Helper: REASON_HELP + ' Don’t copy values from the official register.', 'Show helper': true, 'Show counter': true, Counter: REASON_COUNTER, 'Show error': false, Control: { comp: ta } }, { name: 'field-reason-for-the-seller', sizeH: 'FILL' });
  return [preparedSelect('Default', 'Choose a prepared reason (optional)'), f];
}
function bodyRejectBulk() { return [preparedSelect('Filled', PREPARED), preview('The shop owner sees the text of this reason.', PREPARED_TEXT)]; }
function bodyRejectChange() { return [preparedSelect('Filled', 'Store name not accepted'), preview('The shop owner sees the text of this reason.', 'We couldn’t accept this store name. Use the name customers know your shop by.')]; }
function bodyBulkResult() {
  const count = function (ic, token, s) { return frame({ name: s, dir: 'H', gap: 'space/2', align: 'center' }, [icon(ic, token, 16), text(s, 'Body/Strong')]); };
  const item = function (store, why) { return frame({ name: store, dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(store, 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), text(why, 'Body/Small', 'text/secondary', { sizeH: 'FILL' })]); };
  return [frame({ name: 'counts', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [count('check', 'status/success/fg', '1 done'), count('minus', 'icon/muted', '1 skipped'), count('x', 'status/critical/fg', '1 refused')]),
    text('Skipped: no current submission, or a decision is under way.', 'Body/Small', 'text/muted', { name: 'skipped-help', sizeH: 'FILL' }),
    item('Darra Asian Mart', 'Skipped: this isn’t the current submission.'), item('Logan Family Grocer', 'Refused: record 2 required checks first.')];
}
function bodySlug() { return [readOnlyPair('Current address', SETUP.storefront + SETUP.slug), setupField('Shop web address', { value: 'kuraby-fresh-grocers', prefix: SETUP.storefront, helper: SLUG_HELP, status: ['Success', 'Available now.'] }), saBanner('Attention', 'The old address is retired and can never be used again.', null, 'warning')]; }
function bodyZone() { return [readOnlyPair('Current time zone', SETUP.zone + ' (' + SETUP.zoneId + ')'), panelField('Time zone', { select: { state: 'Filled', value: 'Sydney time (Australia/Sydney)' }, helper: 'This changes cut-off and expiry times for this seller. The change is recorded.' })]; }
function bodyConfirmYou() { return [text('Enter your password to change your business details.', 'Body/Default', 'text/secondary', { name: 'note', sizeH: 'FILL' }), authField('Password', { type: 'Password', filled: true }), authField('6-digit code', { type: 'Code', filled: true })]; }
function tplDialogsReview() {
  const b4 = tplBody('Template body · D4 Reject (application)', bodyRejectApplication);
  const b4b = tplBody('Template body · D4 Reject (bulk)', bodyRejectBulk);
  const b4c = tplBody('Template body · D4 Reject (change request)', bodyRejectChange);
  const b10 = tplBody('Template body · D10 Bulk result', bodyBulkResult);
  return tallScene('Dialogs · Seller review · Admin', [
    confirmDlg('D3 Approve', 'Approve this seller?', SA_SELLERS.sunnybank.store + ' gets full access to the seller panel and an email.', 'Approve seller'),
    confirmDlg('D3 Approve change', 'Approve this change?', 'The new details go live at once and the owner is emailed.', 'Approve change'),
    confirmDlg('D3 Approve selected', 'Approve 3 sellers?', 'Sellers without a current submission are skipped.', 'Approve 3 sellers'),
    dlg({ name: 'D4 Reject (application)', size: 'Md', tone: 'Destructive', title: 'Reject this application?', primary: 'Reject application', secondary: 'Cancel', content: b4, focusCancel: true }),
    dlg({ name: 'D4 Reject (bulk)', size: 'Md', tone: 'Destructive', title: 'Reject 3 applications?', primary: 'Reject 3 applications', secondary: 'Cancel', content: b4b, focusCancel: true }),
    dlg({ name: 'D4 Reject (change request)', size: 'Md', tone: 'Destructive', title: 'Not accept this change?', primary: 'Not accept change', secondary: 'Cancel', content: b4c, focusCancel: true }),
    dlg({ name: 'D10 Bulk result', title: 'Result', primary: 'Close', hideSecondary: true, content: b10 }),
  ]);
}
function tplDialogsDetail() {
  const b7 = tplBody('Template body · D7 Change shop web address', bodySlug);
  const b8 = tplBody('Template body · D8 Correct time zone', bodyZone);
  return tallScene('Dialogs · Seller detail · Admin', [
    confirmDlg('D3 Submit for this seller', 'Submit these details for this seller?', 'It’s recorded as submitted by MondaPac.', 'Submit for this seller'),
    confirmDlg('D3 Save and withdraw the submission', 'Save and withdraw the submission?', 'The pending submission leaves the review queue and the owner is told.', 'Save and withdraw'),
    confirmDlg('D3 Allow one more application', 'Allow one more application?', 'The owner can submit again and is emailed.', 'Allow one more application'),
    dlg({ name: 'D7 Change shop web address', size: 'Md', title: 'Change shop web address', primary: 'Change address', secondary: 'Cancel', content: b7 }),
    dlg({ name: 'D8 Correct time zone', title: 'Correct time zone', primary: 'Correct time zone', secondary: 'Cancel', content: b8 }),
  ]);
}
function tplDialogsSettings() {
  return tallScene('Dialogs · Seller settings · Admin', [
    confirmDlg('D3 Restrict product types', 'Only allow selected types?', 'Offers of a type that’s no longer allowed are taken off sale.', 'Only allow selected types', { tone: 'Destructive' }),
    confirmDlg('D3 Turn off category proposals', 'Turn off category proposals?', 'Suggestions waiting for a decision are closed.', 'Turn off', { tone: 'Destructive' }),
    confirmDlg('D3 Turn on AI features', 'Turn on AI features?', 'We’ll email the shop owner that AI is on for their shop.', 'Turn on'),
    confirmDlg('D3 Turn off approval', 'Turn off approval?', 'New sign-ups in ' + SA_MARKET + ' won’t need a person to approve them. A seller whose details are complete, and whose business number the register lists as active with no differences, is approved automatically. Everyone else still goes to a person. Sellers already waiting aren’t approved.', 'Turn off approval', { tone: 'Destructive', size: 'Md' }),
    confirmDlg('D3 Require approval', 'Require approval?', 'New sign-ups will wait for approval.', 'Require approval'),
  ]);
}
function tplDialogsSellerDetails() {
  const b9 = tplBody('Template body · D9 Confirm it’s you', bodyConfirmYou);
  return tallScene('Dialogs · Seller details · Seller', [
    dlg({ name: 'D9 Confirm it’s you', title: 'Confirm it’s you', primary: 'Continue', secondary: 'Cancel', content: b9 }),
    confirmDlg('D3 Cancel change request', 'Cancel this request?', 'Your current details stay as they are.', 'Cancel request', { tone: 'Destructive', secondary: 'Keep request' }),
    confirmDlg('D3 Withdraw submission', 'Withdraw your submission?', 'It leaves MondaPac’s review queue. Your details stay saved.', 'Withdraw submission', { tone: 'Destructive' }),
    confirmDlg('D3 Save and withdraw', 'Save and withdraw your submission?', 'Your details will be saved and your submission withdrawn. Submit again when you’re ready.', 'Save and withdraw'),
  ]);
}
function tplSheetConfirmYou() {
  const b9 = tplBody('Template body · D9 Confirm it’s you', bodyConfirmYou);
  return sheetScene('Dialog sheet · Confirm it’s you (phone)', dlg({ name: 'D9 Confirm it’s you (sheet)', layout: 'Sheet', title: 'Confirm it’s you', primary: 'Continue', secondary: 'Cancel', content: b9 }));
}

// ---- S7 Store profile (ux.md 3.1 S7 and 3.1a, F21), full seller shell
const S7_NAME = 'Seller · Store profile';
const S7_REQUESTED = 'Kuraby Fresh Grocers';
const S7_REJECTED = 'We couldn’t accept this store name. Use the name customers know your shop by.';
const PLAIN_TEXT = 'Plain text only. Web addresses and formatting are shown as typed.';
// The AU Market's sample money values: the currency code and tax phrase come from Market configuration, amounts are formatted with Intl.
const MIN_CURRENCY = 'AUD';
const MIN_MONEY = { saved: 'A$50.00', latest: 'A$40.00', example: 'A$25.00' };
const MIN_UNIT = 'Amount in ' + MIN_CURRENCY + ', including GST';
const ACTING_AS = 'You’re signed in as this seller. Edit their details from the seller’s page.';
const MIN_APPLIES = 'Customers can’t check out your items with less than this. Shipping isn’t counted. A change applies at once, including to open carts.';
function s7Field(label, value, o) {
  o = o || {};
  if (!o.area) return setupField(label, { value: value, helper: o.helper, optional: o.optional, state: o.readOnly ? 'Disabled' : null });
  const ta = S.sets.Textarea.set.children.filter(function (c) { return c.name === (o.readOnly ? 'State=Disabled' : (value ? 'State=Filled' : 'State=Default')); })[0];
  const p = { Label: label, Helper: o.helper || PLAIN_TEXT, 'Show helper': true, 'Show counter': true, Counter: o.counter || (value.length + ' / 2000'), 'Show error': false, Control: { comp: ta } };
  const f = inst('Field', p, { name: 'field-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), sizeH: 'FILL' });
  if (value) setNested(f, 'control', prop('Textarea', 'Value', value));
  return f;
}
function saveBar(state) { return setupBar({ primary: 'Save', secondary: null, state: state || 'Clean' }); }
// The identity rows: owner (Request a change), Staff (the reason instead), pending or not accepted (the store name as a Compare row).
const S7_OWNER_ONLY = 'Only the shop owner can change these details.';
const S7_PENDING = 'Another change request is waiting. Cancel it or wait for the decision.';
// A DataRow "Request a change" that is disabled, with its reason as the row's note.
function askOff(r) { setNested(r, 'action', { State: 'Disabled' }); return r; }
function identityRows(o) {
  const ask = o.readOnly ? null : 'Request a change'; const off = o.staff || o.pending; const note = o.staff ? S7_OWNER_ONLY : (o.pending ? S7_PENDING : null);
  let store;
  if (o.pending) store = saRow({ label: 'Store name', value: SETUP.store, compare: S7_REQUESTED, valueLabel: 'Current', compareLabel: 'Requested', flag: FLAG.waiting, action: 'Cancel request', note: 'Your current details stay in use until MondaPac reviews this.' });
  else if (o.notAccepted) store = saRow({ label: 'Store name', value: SETUP.store, compare: S7_REQUESTED, valueLabel: 'Current', compareLabel: 'Requested', flag: FLAG.notAccepted, action: 'Request a change', note: S7_REJECTED });
  else store = saRow({ label: 'Store name', value: SETUP.store, action: ask, note: note, narrow: o.narrow });
  const rows = [saRow({ label: 'Business name', value: SETUP.business, action: ask, note: note, narrow: o.narrow }), saRow({ label: SETUP.idLabel, value: SETUP.abn, action: ask, note: note, narrow: o.narrow })];
  if (off && ask) { if (o.staff) askOff(store); rows.forEach(askOff); }
  return [store].concat(rows);
}
function s7General(o) {
  const kids = [header('General', null), frame({ name: 'locked-note', dir: 'H', pad: [0, 'space/5', 'space/2', 'space/5'], sizeH: 'FILL' }, [saLine('These details need a review before they change.', 'identity-note')])].concat(identityRows(o));
  if (o.readOnly) kids.push(saRow({ label: 'Phone', value: SETUP.phone, narrow: o.narrow }), saRow({ label: 'Contact email', value: SETUP.contact, narrow: o.narrow }));
  kids.push(saRow({ label: 'Sign-in email', value: SETUP.signIn, note: 'To change it, contact us.', narrow: o.narrow }));
  if (!o.readOnly) {
    const form = [setupField('Phone', { value: SETUP.phone }), setupField('Contact email', { value: SETUP.contact, optional: true, helper: CONTACT_HELP })];
    if (o.ai) form.push(saLine('AI is on for your shop.', 'ai-on', 'text/secondary'));
    if (!o.narrow) form.push(saveBar());
    kids.push(frame({ name: 'body', dir: 'V', gap: 'space/4', pad: ['space/4', 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, form));
  }
  return card('General', kids);
}
function s7Address(o) {
  const ask = o.readOnly ? null : 'Request a change';
  const where = saRow({ label: 'Where your shop works from', value: SETUP.street + ', ' + SETUP.locality + ' ' + SETUP.region + ' ' + SETUP.postcode, action: ask, note: o.staff ? S7_OWNER_ONLY : (o.pending ? S7_PENDING : null), narrow: o.narrow });
  if (ask && (o.staff || o.pending)) askOff(where);
  return card('Address', [header('Address', null), where,
    saRow({ label: 'Work time zone', value: SETUP.zone + ' (' + SETUP.zoneId + ')', note: 'To change this, contact us.', narrow: o.narrow }), saRow({ label: 'Shop web address', value: SETUP.storefront + SETUP.slug, note: 'To change this, contact us.', narrow: o.narrow })]);
}
const S7_TEXTS = { description: 'Fresh lamb, beef and poultry, cut to order in Kuraby since 2009. Order by 2 pm for same-day pickup.', policies: 'Unopened items can be returned within 7 days. Chilled items can’t be returned once collected.' };
function s7Texts(o) {
  const ro = o.readOnly;
  const cards = [];
  if (o.langs) cards.push(tabsBar([['English', null, true], ['Persian', null, false]]));
  cards.push(setupCard('Description', [s7Field('Shop description', S7_TEXTS.description, { area: true, readOnly: ro })]),
    setupCard('Policies', [s7Field('Returns and refunds', S7_TEXTS.policies, { area: true, readOnly: ro })]),
    setupCard('SEO', [s7Field('Search title', 'Kuraby Fresh: fresh meat in Kuraby', { readOnly: ro }), s7Field('Keywords', 'lamb, beef, chicken, Kuraby', { readOnly: ro }), s7Field('Search description', 'Fresh lamb, beef and poultry, cut to order.', { area: true, counter: '43 / 160', readOnly: ro })]),
    setupCard('Social', [s7Field('Instagram', 'https://instagram.com/kurabyfresh', { helper: 'Links to facebook.com, instagram.com or youtube.com only.', readOnly: ro }), s7Field('Facebook', '', { optional: true, readOnly: ro })]));
  if (!ro) cards.push(saveBar('Dirty'));
  return frame({ name: 'texts', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, cards);
}
function s7Tax(o) { return card('Tax registration', [header('Tax registration', null), saRow({ label: SETUP.taxQuestion, value: 'Yes, from ' + SETUP.taxFrom, action: o.readOnly ? null : 'Record a change', note: 'MondaPac doesn’t decide whether you must register.' })]); }
// The Settings card: the minimum order in each state of 3.1a.
const MIN_STATES = ['None', 'Set', 'Dirty', 'Saving', 'Removed', 'Invalid amount', 'Wrong currency', 'Save conflict', 'Load error', 'No edit permission', 'Acting-as'];
function minField(value, error) { return setupField('Minimum order (optional)', { value: value, prefix: MIN_CURRENCY, helper: error ? null : MIN_UNIT, error: error }); }
function minOrder(state) {
  const kids = [];
  if (state === 'Load error') return [saBanner('Critical', 'We couldn’t load this card.', 'Try again', 'load-error')];
  if (state === 'No edit permission') return [saRow({ label: 'Minimum order', value: MIN_MONEY.saved })];
  if (state === 'Acting-as') return [saBanner('Attention', ACTING_AS, null, 'acting-as'), saRow({ label: 'Minimum order', value: MIN_MONEY.saved })];
  if (state === 'Invalid amount') kids.push(saBanner('Critical', 'Check the details below', null, 'error-summary'));
  if (state === 'Wrong currency') kids.push(saBanner('Attention', 'This amount isn’t in ' + MIN_CURRENCY + '. Reload the page and try again.', 'Reload', 'currency'));
  if (state === 'Save conflict') kids.push(saBanner('Attention', 'This setting was changed somewhere else. The latest value is ' + MIN_MONEY.latest + '. Check it and save again.', null, 'conflict'));
  const value = { None: '', Removed: '', Dirty: '60.00', Saving: '60.00', 'Invalid amount': '0', 'Save conflict': '60.00', 'Wrong currency': '60' }[state];
  kids.push(minField(value === undefined ? '50.00' : value, state === 'Invalid amount' ? 'Enter an amount greater than zero, for example ' + MIN_MONEY.example + '.' : null), setupNote(MIN_APPLIES, 'applies'));
  if (state === 'None' || state === 'Removed') kids.push(setupNote('No minimum. Customers can order any amount.', 'none'));
  else kids.push(frame({ name: 'current', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [saLine('Current minimum: ' + (state === 'Save conflict' ? MIN_MONEY.latest : MIN_MONEY.saved), 'current-text', 'text/secondary'), linkBtn('Remove minimum', null, 'remove')]));
  const bar = { None: ['Clean', true, true], Set: ['Clean'], Dirty: ['Dirty'], Saving: ['Saving'], Removed: ['Clean'], 'Invalid amount': ['Error'], 'Wrong currency': ['Dirty'], 'Save conflict': ['Dirty'] }[state];
  kids.push(setupBar({ primary: 'Save', secondary: null, state: bar[0], disabled: bar[1], noStatus: bar[2] }));
  if (state === 'Removed') kids.push(inst('Toast', { Tone: 'Success', Message: 'Minimum removed.', 'Show action': false }, { name: 'Toast' }));
  return kids;
}
function s7Settings(o) { return setupCard('Settings', o.readOnly ? minOrder('No edit permission') : minOrder('None')); }
// o: { pending, notAccepted, staff, readOnly, langs, ai }
function s7Content(o) {
  const kids = [pageTitle('Store profile', null, [])];
  if (o.readOnly) kids.push(saBanner('Info', 'You can view this page but not change it.', null, 'view-only'));
  kids.push(s7General(o), s7Address(o), s7Texts(o), s7Tax(o), s7Settings(o));
  return kids;
}
function shopSwitcher(scr) { // the sample shop name of 1.10.0 frames, also in a file whose Sidebar still has an older sample
  const t = scr.findOne(function (n) { return n.type === 'TEXT' && n.parent && n.parent.name === 'button' && n.parent.parent && n.parent.parent.name === 'shop-switcher'; });
  if (t && t.characters !== SETUP.store) t.characters = SETUP.store;
}
function tplS7(state, o) {
  const scr = screen(S7_NAME + (state ? ' · ' + state : ''), 'Seller', 'nav-settings', 'Store profile', [frame({ name: 'content', dir: 'V', gap: 'space/5', w: 760 }, s7Content(o || {}))], { minH: PANEL_MIN_H });
  shopSwitcher(scr);
  return scr;
}
function tplS7Min() { return stateBoard(S7_NAME + ' · Minimum order states', 'Store profile: minimum order', 'The Settings card in each state of ux.md 3.1a. The prefix is the Market\'s ISO currency code, never a bare "$"; amounts are formatted with Intl in the page locale. No view permission is B5, as for the whole page.', MIN_STATES, function (s) { return frame({ name: 'card-body', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, minOrder(s)); }); }
function tplS7Phone() {
  const o = { narrow: true };
  const scr = phoneScreen(S7_NAME + ' (phone)', 'Seller', [text('Store profile', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), s7General(o), s7Address(o), s7Settings(o)], 'More');
  applyDensity(scr, 'touch');
  return scr;
}

// ---- the list of 1.10.0 frames: [group, name, make]
// At most six desktop frames per row, so Templates · Admin keeps the width the earlier rows gave it; the admin state boards share one row.
const SELLER_ADMIN_ROWS = ['sa-sellers', 'sa-review', 'sa-detail', 'sa-settings', 'sa-boards', 'sa-profile', 'sa-dialogs', 'sa-phone'];
function sellerAdminDefs() {
  const p1 = function (s) { return ['sa-sellers', P1P3_NAME + (s ? ' · ' + s : ''), function () { return tplP1P3(s); }]; };
  const p2 = function (s) { return ['sa-detail', P2_NAME + (s ? ' · ' + s : ''), function () { return tplP2(s); }]; };
  return {
    'tpl-admin': [p1(null), p1('Selected'), p1('Selection limit'), p1('Incomplete'), p1('Approved'), p1('View only'), ['sa-boards', P1P3_NAME + ' · Empty states', tplP1P3Empty]]
      .concat(P3_FRAMES.map(function (f) { return ['sa-review', P3_NAME + ' · ' + f[0], function () { return tplP3(f[0], f[1]); }]; }), [
        ['sa-boards', P3_NAME + ' · Register states', tplP3Register], ['sa-boards', P3_NAME + ' · Approve disabled', tplP3Blocked],
        p2(null), p2('Edit'), p2('Not approved'), p2('View only'), p2('History'),
        ['sa-boards', P2_NAME + ' · Banners', tplP2Banners], ['sa-boards', P2_NAME + ' · Edit banners', tplP2EditBanners], ['sa-boards', P2_NAME + ' · Admin-only settings states', tplC1States],
        ['sa-settings', P4_NAME, function () { return tplP4(null); }], ['sa-settings', P4_NAME + ' · View only', function () { return tplP4('View only'); }], ['sa-boards', P4_NAME + ' · States', tplP4States],
        ['sa-dialogs', 'Dialogs · Seller review · Admin', tplDialogsReview], ['sa-dialogs', 'Dialogs · Seller detail · Admin', tplDialogsDetail], ['sa-dialogs', 'Dialogs · Seller settings · Admin', tplDialogsSettings],
        ['sa-phone', P1P3_NAME + ' (phone)', tplP1P3Phone],
      ]),
    'tpl-seller': [
      ['sa-profile', S7_NAME, function () { return tplS7(null, { ai: true }); }], ['sa-profile', S7_NAME + ' · Pending change', function () { return tplS7('Pending change', { pending: true }); }],
      ['sa-profile', S7_NAME + ' · Not accepted', function () { return tplS7('Not accepted', { notAccepted: true }); }], ['sa-profile', S7_NAME + ' · Staff', function () { return tplS7('Staff', { staff: true }); }],
      ['sa-profile', S7_NAME + ' · View only', function () { return tplS7('View only', { readOnly: true }); }], ['sa-profile', S7_NAME + ' · Languages', function () { return tplS7('Languages', { langs: true }); }],
      ['sa-profile', S7_NAME + ' · Minimum order states', tplS7Min],
      ['sa-dialogs', 'Dialogs · Seller details · Seller', tplDialogsSellerDetails],
      ['sa-phone', S7_NAME + ' (phone)', tplS7Phone], ['sa-phone', 'Dialog sheet · Confirm it’s you (phone)', tplSheetConfirmYou],
    ],
  };
}
function sellerAdminNames(key) { return sellerAdminDefs()[key].map(function (d) { return d[1]; }); }
// The sets the 1.10.0 templates place (a template is built only when each one is the plugin's own).
const SELLER_ADMIN_TEMPLATE_NEEDS = ['Sidebar', 'Topbar', 'PhoneTopbar', 'BottomTabBar', 'Button', 'IconButton', 'Input', 'Field', 'FieldStatus', 'Select', 'Textarea', 'Badge', 'CountBadge', 'InfoBanner', 'CardHeader', 'TableCell',
  'Checkbox', 'CheckboxRow', 'SettingRow', 'SegmentedControl', 'Switch', 'Tab', 'FilterChip', 'IdentityTile', 'Menu', 'MenuItem', 'BulkActionBar', 'DataRow', 'FormActionBar', 'EmptyState', 'ReasonQuote', 'TimelineItem', 'Dialog', 'DialogBody', 'Toast'];
// Dark preview copies added in 1.10.0.
const DARK_1100 = [P3_NAME + ' · Application', S7_NAME + ' · Pending change'];
