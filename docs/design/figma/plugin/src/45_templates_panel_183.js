// ---------------------------------------------------------------- release 1.8.3 templates: Sellers list (P1), role editor (B3), dialogs D4 to D6 and the unsaved-changes dialog
// Spec: figma-1.2.0-spec.md section 3.6 (planned there as 1.2.1) and identity ux.md sections 3.2 to 3.3 and 5 (en-AU copy). Names, emails,
// role names and dates are examples. The permission rows are the rows of the catalogue table in identity DD 5.3 (14 in the admin panel,
// 4 in the seller panel); their labels and descriptions are samples until identity writes permission.<key>.label and .description.
// The D6 name label is "Owner's name" (Hadi, 2026-10-08). The unsaved-changes copy was approved by the owner on 2026-10-08.
// The unsaved-changes dialog has a scene of its own (Dialogs · Role editor · Admin), so Update library adds a frame and never edits
// the 1.8.0 confirm scene. Every frame here is new; Update library builds only the names a file does not have yet.

// ---- Sellers list (P1, Admin; a Phase 2 frame beside Admin · Sellers, which is not touched)
const P1_NAME = 'Admin · Sellers (Phase 2)';
const SELLER_STATUS = { 'Awaiting approval': ['Info', 'clock'], 'Changes needed': ['Attention', 'alert-circle'], Approved: ['Success', 'check'], Suspended: ['Critical', 'ban'], Invited: ['Neutral', 'send'] };
function sellerStatusBadge(s) { const d = SELLER_STATUS[s]; return bdg(d[0], 'Icon', s, d[1]); }
const SELLERS_VIEW_ONLY = 'Your role can view sellers but not change them.';
const RESET_WAITING = 'Two-step reset waiting for the owner (link expires 9 Oct 2026, 3:40 pm)';
// The Seller column is the owner's name over the email (ux.md P1), never the business name.
const P1_AWAITING = [
  { i: 'HY', tone: 'Teal', name: 'Hana Yusuf', email: 'hana@sunnybankspice.example', status: 'Awaiting approval', since: '29 Sep 2026' },
  { i: 'BA', tone: 'Blue', name: 'Bilal Ahmed', email: 'bilal@darraasianmart.example', status: 'Awaiting approval', since: '2 Oct 2026' },
  { i: 'MK', tone: 'Amber', name: 'Mariam Khalil', email: 'mariam@hollandparkbakehouse.example', status: 'Awaiting approval', since: '5 Oct 2026' },
];
const P1_ALL = [P1_AWAITING[0],
  { i: 'IM', tone: 'Purple', name: 'Ibrahim Musa', email: 'ibrahim@logangrocer.example', status: 'Changes needed', since: '3 Oct 2026' },
  { i: 'FN', tone: 'Amber', name: 'Faisal Noor', email: 'faisal@noorpantry.example', status: 'Approved', since: '4 Feb 2026' },
  { i: 'YK', tone: 'Teal', name: 'Yusuf Karimi', email: 'yusuf@kurabyfresh.example', status: 'Approved', since: '12 Mar 2026', reset: true },
  { i: 'KR', tone: 'Neutral', name: 'Khalid Rahimi', email: 'khalid@slackscreekbutchers.example', status: 'Suspended', since: '20 Jan 2026' },
  { i: 'ZA', tone: 'Blue', name: 'Zainab Ali', email: 'zainab@gabbaorganics.example', status: 'Invited', since: '6 Oct 2026' },
];
// Tab counts: [Awaiting approval, Approved, Changes needed, Suspended, Invited, All]; the empty frame has nobody waiting.
const P1_TABS = ['Awaiting approval', 'Approved', 'Changes needed', 'Suspended', 'Invited', 'All'];
function p1Tabs(sel, empty) { const n = empty ? ['0', '6', '1', '1', '1', '9'] : ['3', '6', '1', '1', '1', '12']; return tabsBar(P1_TABS.map(function (t, i) { return [t, n[i], t === sel]; })); }
function p1Count(empty) { return (empty ? '9' : '12') + ' sellers in the Australia market'; }
function sellerCell(m) {
  const kids = personCell(m);
  if (m.reset) add(kids[1], text(RESET_WAITING, 'Caption/Default', 'text/muted', { name: 'reset-waiting', sizeH: 'FILL' }));
  return kids;
}
function sellersTable(list, state) {
  if (state === 'Load error') return listLoadError();
  const kids = [headerRow([['Seller', 'fill'], ['Status', 200], ['Since', 160], ['', 56]])];
  if (state === 'Loading') return card('Seller list', kids.concat(loadingRows([['Two-line', 'fill'], ['Text', 200], ['Text', 160], ['Actions', 56]])));
  if (state === 'Empty') return card('Seller list', kids.concat([inst('EmptyState', { Size: 'Card', Icon: { icon: 'check' }, Title: 'No sellers are waiting', Body: 'You’re up to date.', 'Show action': false }, { name: 'empty-state', sizeH: 'FILL' })]));
  list.forEach(function (m) { kids.push(row([[sellerCell(m), 'fill'], [sellerStatusBadge(m.status), 200], [text(m.since, 'Body/Default'), 160], [rowAction(), 56, { justify: 'center' }]], false, false, m.reset ? 80 : 64)); });
  return card('Seller list', kids);
}
function sellerSearch(touch) {
  return frame({ name: 'search', dir: 'V', gap: 'space/1', w: touch ? undefined : 360, sizeH: touch ? 'FILL' : null }, [
    inst('Input', { Type: 'Text', State: 'Default', Value: 'Search sellers' }, { name: 'search-input', sizeH: 'FILL' }),
    text('Enter the full email address.', 'Caption/Default', 'text/muted', { name: 'search-help', sizeH: 'FILL', truncate: true }), // one short line at 328 px and wider
  ]);
}
// A row menu with 2 or 3 items ([state, label, icon, description]); with 2 the middle item is hidden (Menu "Show item 2").
function actionMenu(items) {
  const two = items.length === 2;
  const m = inst('Menu', { 'Show header': false, 'Show divider': false, 'Show item 2': !two }, { name: 'Row menu (open)' });
  (two ? ['item-1', 'item-3'] : ['item-1', 'item-2', 'item-3']).forEach(function (n, i) { setNested(m, n, menuItemProps(items[i][0], items[i][1], items[i][2], items[i][3])); });
  return m;
}
// Where `node` sits inside `root`, worked out from the auto-layout sizes and alignment (padding, gaps, MIN, CENTER, MAX, SPACE_BETWEEN).
// Only the vertical offset is used: it depends on heights alone, which every hugging frame knows as soon as its children are in place.
function offsetIn(root, node) {
  let x = 0, y = 0;
  for (let n = node; n && n !== root && n.parent; n = n.parent) {
    const p = n.parent;
    if (!p.layoutMode || p.layoutMode === 'NONE' || n.layoutPositioning === 'ABSOLUTE') { x += n.x; y += n.y; continue; }
    const h = p.layoutMode === 'HORIZONTAL';
    const kids = p.children.filter(function (c) { return c.visible && c.layoutPositioning !== 'ABSOLUTE'; });
    const size = function (c) { return h ? c.width : c.height; };
    const total = kids.reduce(function (a, c) { return a + size(c); }, 0);
    const padA = h ? p.paddingLeft : p.paddingTop, avail = (h ? p.width : p.height) - padA - (h ? p.paddingRight : p.paddingBottom);
    let gap = p.itemSpacing, along = padA;
    if (p.primaryAxisAlignItems === 'SPACE_BETWEEN') gap = kids.length > 1 ? (avail - total) / (kids.length - 1) : 0;
    else if (p.primaryAxisAlignItems === 'CENTER') along += (avail - total - gap * (kids.length - 1)) / 2;
    else if (p.primaryAxisAlignItems === 'MAX') along += avail - total - gap * (kids.length - 1);
    for (let k = 0; k < kids.indexOf(n); k++) along += size(kids[k]) + gap;
    const padC = h ? p.paddingTop : p.paddingLeft, cAvail = (h ? p.height : p.width) - padC - (h ? p.paddingBottom : p.paddingRight), cSize = h ? n.height : n.width;
    let across = padC;
    if (p.counterAxisAlignItems === 'CENTER') across += (cAvail - cSize) / 2; else if (p.counterAxisAlignItems === 'MAX') across += cAvail - cSize;
    if (h) { x += along; y += across; } else { x += across; y += along; }
  }
  return [x, y];
}
// Opens `menu` under the actions button of seller row `index` (0-based), 4 px below it, its right edge on the button's right edge.
// The actions column is the last one and the list card fills Main, so the button's right edge is fixed by Main's right padding.
function openUnderRow(scr, index, menu) {
  const rows = scr.findAll(function (n) { return n.type === 'FRAME' && n.name === 'Row' && n.parent && n.parent.name === 'Seller list'; });
  const b = rows[index].findOne(function (n) { return n.name === 'row-actions'; });
  const main = scr.children[1].children[1];
  const right = scr.width - main.paddingRight - (b.parent.width - b.width) / 2;
  setMeta(menu, { abs: [Math.round(Math.max(0, right - menu.width)), Math.round(offsetIn(scr, b)[1] + b.height + 4)] });
  add(scr, menu);
}
function tplSellersP1(state) {
  const all = state === 'Menu open' || state === 'View only', view = state === 'View only', empty = state === 'Empty';
  const kids = [pageTitle('Sellers', p1Count(empty), [primaryHeaderButton('Add seller', view ? 'Disabled' : 'Default')])];
  if (view) kids.push(text(SELLERS_VIEW_ONLY, 'Body/Small', 'text/muted', { name: 'view-only-help', sizeH: 'FILL' }));
  kids.push(sellerSearch(false), p1Tabs(all ? 'All' : 'Awaiting approval', empty), sellersTable(all ? P1_ALL : P1_AWAITING, ['Loading', 'Empty', 'Load error'].indexOf(state) >= 0 ? state : null));
  const scr = screen(P1_NAME + (state ? ' · ' + state : ''), 'Admin', 'nav-sellers', 'Sellers', kids, { minH: PANEL_MIN_H });
  // The menu holds only the actions the API allows for the row (ux.md P1): Approve and Reject… while awaiting approval; an approved seller can be suspended
  // or have the owner's two-step verification reset. View reason, Lift suspension, Resend and Cancel invitation belong to the other rows. The approved
  // row's menu opens on a seller with no reset waiting: on the row that has one, starting again cancels the earlier link (DD 3.7), which this menu does not say.
  if (state === 'Menu open') {
    openUnderRow(scr, 0, actionMenu([['Default', 'Approve', 'check'], ['Destructive', 'Reject…', 'x']]));
    openUnderRow(scr, 2, actionMenu([['Default', 'Reset owner’s two-step verification…', 'smartphone'], ['Destructive', 'Suspend…', 'ban']]));
  }
  if (view) openUnderRow(scr, 0, actionMenu([['Disabled', 'Approve', 'check', SELLERS_VIEW_ONLY], ['Disabled', 'Reject…', 'x', SELLERS_VIEW_ONLY]]));
  return scr;
}
function sellerCard(m) {
  return frame({ name: m.name, dir: 'V', gap: 'space/3', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
    frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, personCell(m).concat([rowAction(true)])),
    frame({ name: 'status', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [sellerStatusBadge(m.status), text('Since ' + m.since, 'Caption/Default', 'text/muted')]),
  ]);
}
// 360 x 780: the six tabs do not fit a phone, so the status is a Select in a Field; the three awaiting sellers are cards.
function tplSellersP1Phone() {
  const kids = [text('Sellers', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), fullButton('Add seller'), sellerSearch(true), panelField('Status', { select: { state: 'Filled', value: 'Awaiting approval (3)' } })];
  P1_AWAITING.forEach(function (m) { kids.push(sellerCard(m)); });
  const scr = phoneScreen(P1_NAME + ' (phone)', 'Admin', kids, null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- Dialogs D4 to D6 (Admin) and the phone sheet
const REASON_HELP = 'The shop owner sees this in an email and when they sign in. Say what was wrong and what to change. Don’t add internal notes.';
const REASON_COUNTER = '0 / 1000'; // the maximum length comes from the API (ux.md D4); 1000 is a sample
// A Field whose control is the Textarea, with the counter on.
function reasonField(error) {
  const ta = S.sets.Textarea.set.children.filter(function (c) { return c.name === 'State=Default'; })[0];
  const props = { Label: 'Reason for the seller', Helper: REASON_HELP, 'Show helper': true, 'Show counter': true, Counter: REASON_COUNTER, 'Show error': !!error, Control: { comp: ta } };
  if (error) props.Error = 'Write a reason before you continue.';
  const f = inst('Field', props, { name: 'field-reason-for-the-seller', sizeH: 'FILL' });
  setNested(f, 'control', { State: error ? 'Error' : 'Default' });
  return f;
}
function bodyReject(error) { return [reasonField(error)]; }
function bodySuspend() { return [text('Everyone on the seller’s team is signed out and can’t sign in until you lift the suspension.', 'Body/Default', 'text/secondary', { name: 'consequence', sizeH: 'FILL' }), reasonField(false)]; }
// Read-only D4 ("View reason"): the text, its author and date (ux.md D4). ReasonQuote keeps no author; the admin view adds one line for it.
function bodyViewReason() { return [inst('ReasonQuote', { Label: 'Reason from MondaPac', Date: 'Written on 3 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }), readOnlyPair('Written by', 'Layla Haddad')]; }
const D6_NAME_HELP = 'The shop owner’s own name, not the business name. They add the store and business names when they set up.';
function bodyAddSeller() {
  return [authField('Owner’s name', { value: 'Rashid Omar', helper: D6_NAME_HELP }), authField('Email', { value: 'rashid@moorookagrocer.example', helper: 'We’ll email them a link to choose their own password. You never see or set it.' }),
    text('The account still needs approval after they accept.', 'Body/Default', 'text/secondary', { name: 'note', sizeH: 'FILL' })];
}
// A scene as tall as its dialogs need (at least 900), so no dialog is cut off.
function tallScene(name, dialogs) {
  const scr = dialogScene(name, dialogs);
  const rowF = scr.children[1], h = Math.max(900, Math.ceil(rowF.y + rowF.height + 80));
  if (h > 900) { scr.resize(1440, h); scr.children[0].resize(1440, h); }
  return scr;
}
function tplDialogsSellers() {
  const b4 = tplBody('Template body · D4 Reject', function () { return bodyReject(false); });
  const b4e = tplBody('Template body · D4 Reject (error)', function () { return bodyReject(true); });
  const b4r = tplBody('Template body · D4 View reason', bodyViewReason);
  const b5 = tplBody('Template body · D5 Suspend', bodySuspend);
  const b6 = tplBody('Template body · D6 Add seller', bodyAddSeller);
  return tallScene('Dialogs · Sellers · Admin', [
    dlg({ name: 'D4 Reject', size: 'Md', tone: 'Destructive', title: 'Reject this seller application?', primary: 'Reject application', secondary: 'Cancel', content: b4, focusCancel: true }),
    dlg({ name: 'D4 Reject · Error', size: 'Md', tone: 'Destructive', title: 'Reject this seller application?', primary: 'Reject application', secondary: 'Cancel', content: b4e }),
    dlg({ name: 'D5 Suspend', size: 'Md', tone: 'Destructive', title: 'Suspend this seller?', primary: 'Suspend seller', secondary: 'Cancel', content: b5, focusCancel: true }),
    // The title has no key in ux.md section 5 yet (sample).
    dlg({ name: 'D4 View reason', size: 'Md', title: 'Reason for Ibrahim Musa', primary: 'Close', hideSecondary: true, content: b4r }),
    dlg({ name: 'D6 Add seller', title: 'Add a seller', primary: 'Send invitation', secondary: 'Cancel', content: b6 }),
  ]);
}
function tplSheetReject() {
  const b4e = tplBody('Template body · D4 Reject (error)', function () { return bodyReject(true); });
  return sheetScene('Dialog sheet · Reject (phone)', dlg({ name: 'D4 Reject (sheet)', layout: 'Sheet', tone: 'Destructive', title: 'Reject this seller application?', primary: 'Reject application', secondary: 'Cancel', content: b4e }));
}
// Leaving the role editor with unsaved changes (approved copy; it opens with focus on "Keep editing").
function tplDialogsRoleEditor() {
  return dialogScene('Dialogs · Role editor · Admin', [
    dlg({ name: 'Unsaved changes', tone: 'Destructive', title: 'Leave without saving?', text: 'You have unsaved changes. They’ll be lost if you leave.', primary: 'Leave', secondary: 'Keep editing', focusCancel: true }),
  ]);
}

// ---- Role editor (B3, both panels)
// [group, label, description, protected (R11)]: one row per row of the catalogue table in identity DD 5.3.
const ADMIN_PERMS = [
  ['Seller access', 'View sellers', 'See sellers awaiting a decision, their status and the reason.'],
  ['Seller access', 'Approve and reject sellers', 'Decide on seller applications.'],
  ['Seller access', 'Suspend sellers', 'Suspend a seller and lift the suspension.'],
  ['Seller accounts', 'Add sellers', 'Invite a new seller; resend or cancel the invitation.'],
  ['Seller accounts', 'Reset a shop owner’s two-step verification', 'Start a reset that the shop owner confirms by email.'],
  ['Customer accounts', 'View customer accounts', 'Find a customer account by email and see its status.'],
  ['Customer accounts', 'Deactivate customer accounts', 'Deactivate and reactivate a customer account.'],
  ['Admin accounts', 'View admins', 'See admin accounts, their roles and open invitations.'],
  ['Admin accounts', 'Invite admins', 'Invite an admin; resend or cancel the invitation.', true],
  ['Admin accounts', 'Deactivate admins', 'Deactivate and reactivate an admin account.', true],
  ['Admin accounts', 'Reset an admin’s two-step verification', 'Reset another admin’s two-step verification.', true],
  ['Roles', 'View roles', 'See roles and their permissions.'],
  ['Roles', 'Create, edit and delete roles', 'Use this role editor.', true],
  ['Roles', 'Change an admin’s role', 'Give an admin a different role.', true],
];
const SELLER_PERMS = [
  ['Team', 'View the team', 'See team members, their roles and open invitations.'],
  ['Team', 'Manage the team', 'Invite and remove team members, change their roles and reset their two-step verification.', true],
  ['Roles', 'View roles', 'See roles and their permissions.'],
  ['Roles', 'Create, edit and delete roles', 'Use this role editor.', true],
];
const R10_HELP = 'New features are never added to a custom role automatically. You choose when to add them.';
const PROTECTED_ADMIN = 'Only a Platform owner can give this permission.'; // role.help.protected with {systemRoleName}; the role name is a sample
const PROTECTED_SELLER = 'Only the shop owner can do this. It can’t be given to team members yet.';
const ACTOR_NOT_HELD = [3, 6]; // the signed-in admin (Layla Haddad, Compliance lead) does not hold Add sellers and Deactivate customer accounts (R1)
// A ticked permission the actor does not hold stays ticked and locked: they can neither give it nor take it away (sample copy, no ux.md key yet).
const NOT_HELD_CHANGE = 'You can’t change a permission you don’t have.';
// Row states of one editor: o.checked (indexes), o.readOnly; editable rows are disabled when protected or not held, with the reason.
// Only a duplicate drops what the actor does not hold (o.dropNotHeld, with the banner); editing an existing role keeps its stored value.
function permRows(perms, ws, o) {
  return perms.map(function (p, i) {
    const r = { group: p[0], label: p[1], desc: p[2], badge: !!p[3], value: o.checked.indexOf(i) >= 0 ? 'Checked' : 'Unchecked', state: o.readOnly ? 'Read-only' : 'Default' };
    if (o.readOnly) return r;
    if (p[3]) { r.state = 'Disabled'; r.desc = ws === 'Admin' ? PROTECTED_ADMIN : PROTECTED_SELLER; }
    else if (ws === 'Admin' && ACTOR_NOT_HELD.indexOf(i) >= 0) {
      r.state = 'Disabled';
      if (o.dropNotHeld) r.value = 'Unchecked';
      r.desc = r.value === 'Checked' ? NOT_HELD_CHANGE : NOT_HELD;
    }
    return r;
  });
}
// "Select all in {group}" ticks and clears only the rows the actor can give, so its state comes from those rows alone; with none it is disabled.
function permCard(group, rows, readOnly) {
  const free = rows.filter(function (r) { return r.state === 'Default'; }), counted = free.length ? free : rows;
  const on = counted.filter(function (r) { return r.value === 'Checked'; }).length;
  const all = on === 0 ? 'Unchecked' : (on === counted.length ? 'Checked' : 'Indeterminate');
  const head = frame({ name: 'card-header', dir: 'H', gap: 'space/3', align: 'center', justify: 'between', px: 'space/4', py: 'space/3', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [
    text(group, 'Heading/H2', 'text/primary', { name: 'resource' }),
    readOnly ? null : frame({ name: 'select-all', dir: 'H', gap: 'space/2', align: 'center' }, [inst('Checkbox', { Value: all, State: free.length ? 'Default' : 'Disabled' }, { name: 'select-all-checkbox' }), text('Select all in ' + group, 'Body/Default', free.length ? 'text/primary' : 'text/muted', { name: 'select-all-label' })]),
  ]);
  return card('Permissions · ' + group, [head].concat(rows.map(function (r) {
    return inst('CheckboxRow', { Value: r.value, State: r.state, Label: r.label, Description: r.desc, 'Show badge': r.badge }, { name: 'permission · ' + r.label, sizeH: 'FILL' });
  })));
}
function permCards(rows, readOnly) {
  const groups = []; rows.forEach(function (r) { if (groups.indexOf(r.group) < 0) groups.push(r.group); });
  return groups.map(function (g) { return permCard(g, rows.filter(function (r) { return r.group === g; }), readOnly); });
}
function backLink(touch) { return inst('Button', { Variant: 'Ghost', Size: touch ? 'Touch' : 'Sm', State: 'Default', Label: 'Roles', 'Leading icon': true, Icon: { icon: 'chevron-left' } }, { name: 'back' }); }
function actionBar(touch) {
  const b = function (label, variant) { return inst('Button', { Variant: variant, Size: touch ? 'Touch' : 'Md', State: 'Default', Label: label }, { name: variant === 'Primary' ? 'save' : 'cancel', sizeH: touch ? 'FILL' : null }); };
  // On a phone the bar sits above the safe area (the larger bottom padding).
  return frame({ name: 'Action bar', dir: 'H', gap: 'space/2', align: 'center', pad: touch ? ['space/3', 'space/4', 'space/8', 'space/4'] : ['space/3', 'space/8', 'space/3', 'space/8'], fill: 'bg/surface', stroke: 'border/default', sides: ['top'], sizeH: 'FILL' }, [b('Save role', 'Primary'), b('Cancel', 'Secondary')]);
}
// The editor content: o = { ws, title, type, readOnly, checked, banner: [title, body], nameValue, nameError, info: [title, body] }
function editorContent(o) {
  const rows = permRows(o.ws === 'Admin' ? ADMIN_PERMS : SELLER_PERMS, o.ws, o);
  const kids = [];
  if (o.banner) { const bn = panelBanner(o.banner[0], o.banner[1] || ' '); if (!o.banner[1]) bn.findOne(function (n) { return n.name === 'body'; }).visible = false; kids.push(bn); }
  if (!o.readOnly) {
    kids.push(authField('Role name', { value: o.nameValue || '', helper: R10_HELP, error: o.nameError }));
    kids.push(text(rows.filter(function (r) { return r.value === 'Checked'; }).length + ' of ' + rows.length + ' permissions selected', 'Body/Strong', 'text/primary', { name: 'selected-count' }));
  }
  return kids.concat(permCards(rows, o.readOnly));
}
function titleBlock(o) { return pageTitle(o.title, null, o.duplicate ? [btn('Duplicate', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'copy' } })] : [], typeBadge(o.type)); }
function tplRoleEditor(o) {
  const admin = o.ws === 'Admin';
  // At 1440 the cards sit in one column of readable width; the rest of the row stays empty (spec 3.6).
  const column = frame({ name: 'Content column', dir: 'V', gap: 'space/5', w: 760 }, editorContent(o));
  const scr = shellPage('Shared · Role editor · ' + o.ws + ' · ' + o.suffix, o.ws, admin ? 'Roles & permissions' : 'Team & roles', [backLink(false), titleBlock(o), column]);
  // "Save role" and "Cancel" are pinned to the bottom in code; the frame shows the whole list with the bar at its end. Read-only roles have no bar.
  if (!o.readOnly) add(scr.children[1], actionBar(false));
  return scr;
}
function tplRoleEditorPhone() {
  const o = SELLER_EDITORS[0];
  const main = frame({ name: 'Main', dir: 'V', gap: 'space/3', pad: 'space/4', sizeH: 'FILL' }, [backLink(true), titleBlock(o)].concat(editorContent(o)));
  // The whole editor at 360 wide (it is longer than one screen); the bar is pinned in code.
  const scr = frame({ name: 'Shared · Role editor · Seller (phone)', dir: 'V', w: 360, fill: 'bg/page' }, [phoneTopbar('Seller'), main, actionBar(true)]);
  scr.minHeight = 780;
  applyDensity(scr, 'touch');
  tag(scr);
  return scr;
}
const ADMIN_EDITORS = [
  // A custom role being edited (the Roles list still shows it with no permissions: the changes are not saved). It holds Add sellers, which this admin
  // does not hold, so that row is ticked and locked.
  { ws: 'Admin', suffix: 'Custom', title: 'Content editor', type: 'Custom', nameValue: 'Content editor', checked: [0, 3, 5, 11] },
  { ws: 'Admin', suffix: 'Default', title: 'Seller reviewer', type: 'Default', readOnly: true, duplicate: true, checked: [0, 1, 2, 3], banner: ['Default role from MondaPac.', 'It can’t be changed. Duplicate it to make your own version.'] },
  { ws: 'Admin', suffix: 'System', title: 'Platform owner', type: 'System', readOnly: true, checked: ADMIN_PERMS.map(function (p, i) { return i; }), banner: ['System role.', 'It always has every permission in this panel and can’t be changed or deleted.'] },
  { ws: 'Admin', suffix: 'Duplicate', title: 'Copy of Seller reviewer', type: 'Custom', nameValue: 'Copy of Seller reviewer', checked: [0, 1, 2, 3], dropNotHeld: true, banner: ['Some permissions weren’t copied because you can’t give them.'] },
  { ws: 'Admin', suffix: 'Errors', title: 'Content editor', type: 'Custom', nameValue: 'Finance reviewer', nameError: 'A role with this name already exists.', checked: [0, 3, 5, 11] },
];
const SELLER_EARLY = ['Only a few permissions exist so far.', 'More appear here as MondaPac adds features.'];
const SELLER_EDITORS = [
  { ws: 'Seller', suffix: 'Custom', title: 'Weekend staff', type: 'Custom', nameValue: 'Weekend staff', checked: [0, 2], banner: SELLER_EARLY },
  { ws: 'Seller', suffix: 'Ready-made', title: 'Order packer', type: 'Ready-made', readOnly: true, duplicate: true, checked: [0, 2], banner: ['Ready-made role from MondaPac.', 'It can’t be changed. Duplicate it to make your own version.'] },
  { ws: 'Seller', suffix: 'Owner', title: 'Owner', type: 'Owner', readOnly: true, checked: [0, 1, 2, 3], banner: ['Owner role.', 'It always has every permission in this panel and can’t be changed or deleted.'] },
  // A new role: no name yet and nothing ticked; Save stays enabled (a role with no permissions can be saved, DD 5.6).
  { ws: 'Seller', suffix: 'New role · early catalogue', title: 'Create role', type: 'Custom', nameValue: '', checked: [], banner: SELLER_EARLY },
];

// ---- the list of 1.8.3 frames: [group, name, make]
const PANEL183_ROWS = ['sellers', 'role-editor', 'dialogs', 'phone'];
function panel183Defs() {
  const editor = function (o) { return ['role-editor', 'Shared · Role editor · ' + o.ws + ' · ' + o.suffix, function () { return tplRoleEditor(o); }]; };
  return {
    'tpl-admin': [
      ['sellers', P1_NAME, function () { return tplSellersP1(null); }],
      ['sellers', P1_NAME + ' · Menu open', function () { return tplSellersP1('Menu open'); }],
      ['sellers', P1_NAME + ' · View only', function () { return tplSellersP1('View only'); }],
      ['sellers', P1_NAME + ' · Loading', function () { return tplSellersP1('Loading'); }],
      ['sellers', P1_NAME + ' · Empty', function () { return tplSellersP1('Empty'); }],
      ['sellers', P1_NAME + ' · Load error', function () { return tplSellersP1('Load error'); }],
    ].concat(ADMIN_EDITORS.map(editor), [
      ['dialogs', 'Dialogs · Sellers · Admin', tplDialogsSellers],
      ['dialogs', 'Dialogs · Role editor · Admin', tplDialogsRoleEditor],
      ['phone', P1_NAME + ' (phone)', tplSellersP1Phone],
      ['phone', 'Dialog sheet · Reject (phone)', tplSheetReject],
    ]),
    'tpl-seller': SELLER_EDITORS.map(editor).concat([['phone', 'Shared · Role editor · Seller (phone)', tplRoleEditorPhone]]),
  };
}
// The desktop pages of 1.8.3 that hug their content with the 900 px minimum (the role editor phone frame has its own 780 minimum).
function panel183ShellNames(key) { return panel183Defs()[key].filter(function (d) { return d[0] === 'sellers' || d[0] === 'role-editor'; }).map(function (d) { return d[1]; }); }
// The sets the 1.8.3 templates place, on top of the 1.8.0 ones (a template is built only when each one is the plugin's own).
const PANEL183_TEMPLATE_NEEDS = PANEL_TEMPLATE_NEEDS.concat(['Textarea', 'CheckboxRow', 'ReasonQuote']);
