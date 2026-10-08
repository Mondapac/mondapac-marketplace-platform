// ---------------------------------------------------------------- release 1.8.0 templates: Members, Roles, No access, Not found, Account security and the dialogs D1 to D3
// Spec: figma-1.2.0-spec.md (renumbered 1.8.0) section 3 and identity ux.md section 5 (en-AU copy). Names, emails and role names are
// examples (the ready-made role set is not approved yet, DD 14.4). Admin frames go to Templates · Admin, Seller frames to Templates · Seller.
// Not in 1.8.0 (they are 1.8.3, 45_templates_panel_183.js): the Sellers list (P1), the role editor (B3), dialogs D4 to D6 and the unsaved-changes dialog.
// No Sidebar item is active on these pages: the nav-config release adds "Team & roles" (seller) and "Roles & permissions" (admin).
const VIEW_ONLY = 'Your role can view people and roles but not change them.';
const NOT_HELD = 'You can’t give a permission you don’t have.';
const PANEL_BODIES = []; // template-body components made in the current run, placed under the frames by addPanelTemplates

// ---- small parts
function bdg(tone, leading, label, ic) { const p = { Tone: tone, Leading: leading, Label: label }; if (leading === 'Icon') p.Icon = { icon: ic }; return inst('Badge', p); }
const STATUS_BADGE = { Active: ['Success', 'Dot', 'Active'], Invited: ['Neutral', 'Icon', 'Invited', 'send'], Deactivated: ['Neutral', 'Icon', 'Deactivated', 'ban'], On: ['Success', 'Icon', 'On', 'check'], Off: ['Neutral', 'Icon', 'Off', 'x'] };
function statusBadge(k) { const d = STATUS_BADGE[k]; return bdg(d[0], d[1], d[2], d[3]); }
const TYPE_BADGE = { System: ['Neutral', 'Icon', 'System', 'lock'], Owner: ['Neutral', 'Icon', 'Owner', 'lock'], Default: ['Neutral', 'None', 'Default'], 'Ready-made': ['Neutral', 'None', 'Ready-made'], Custom: ['Info', 'None', 'Custom'] };
function typeBadge(k) { const d = TYPE_BADGE[k]; return bdg(d[0], d[1], d[2], d[3]); }
function rowAction(touch) { return inst('IconButton', { Variant: 'Ghost', Size: touch ? 'Touch' : 'Sm', State: 'Default' }, { name: 'row-actions' }); }
function tabsBar(list) {
  return frame({ name: 'tabs', dir: 'H', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, list.map(function (t) {
    const p = { Selected: t[2] ? 'True' : 'False', Label: t[0], 'Show count': t[1] !== null }; if (t[1] !== null) p.Count = t[1];
    return inst('Tab', p);
  }));
}
function personCell(m, touch) {
  const nameRow = frame({ name: 'name-row', dir: 'H', gap: 'space/2', align: 'center' }, [text(m.name, 'Body/Strong'), m.you ? bdg('Neutral', 'None', 'You') : null]);
  return [inst('IdentityTile', { Tone: m.tone, Shape: 'Circle', Initials: m.i }), frame({ name: 'person', dir: 'V', sizeH: 'FILL' }, [nameRow, text(m.email, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true })])];
}
function roleNodes(m) { return m.system ? [icon('lock', 'icon/muted', 14), text(m.role, 'Body/Default')] : [text(m.role, 'Body/Default')]; }
function loadingRows(cols) {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push(frame({ name: 'Row', dir: 'H', sizeH: 'FILL' }, cols.map(function (c) {
      const t = inst('TableCell', { Type: c[0], State: 'Loading' }, { name: 'skeleton ' + c[0], sizeH: c[1] === 'fill' ? 'FILL' : null });
      if (c[1] !== 'fill') t.resize(c[1], t.height);
      return t;
    })));
  }
  return rows;
}
function groupRow(label) { return frame({ name: 'Group · ' + label, dir: 'H', px: 'space/3', py: 'space/2', fill: 'bg/subtle', stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [text(label, 'Caption/Overline', 'text/muted')]); }
function panelBanner(title, bodyText) { return inst('InfoBanner', { Tone: 'Info', Title: title, Body: bodyText, 'Show action': false }, { name: 'banner', sizeH: 'FILL' }); }
function menuItemProps(state, label, ic, desc, leading) {
  const p = Object.assign({ State: state }, prop('MenuItem', 'Label', label), prop('MenuItem', 'Leading icon', leading !== false), prop('MenuItem', 'Show description', !!desc));
  if (ic) Object.assign(p, prop('MenuItem', 'Icon', S.icons[ic].id));
  if (desc) Object.assign(p, prop('MenuItem', 'Description', desc));
  return p;
}
// A row actions menu (no header): items = [state, label, icon, description] for item-1 to item-3.
function rowMenu(items, abs, w) {
  const m = inst('Menu', { 'Show header': false, 'Show divider': false }, { name: 'Row menu (open)', abs: abs, w: w });
  ['item-1', 'item-2', 'item-3'].forEach(function (n, i) { setNested(m, n, menuItemProps(items[i][0], items[i][1], items[i][2], items[i][3])); });
  return m;
}
// 1.8.1: Panel desktop pages hug their content but are at least this high (the Sidebar is FILL; on a short page its items would stick out).
const PANEL_MIN_H = 900;
function shellPage(name, ws, crumb, kids, o) { return screen(name, ws, 'none', crumb, kids, Object.assign({ minH: PANEL_MIN_H }, o)); }
function primaryHeaderButton(label, state) { return btn(label, 'Primary', 'Md', { State: state || 'Default', 'Leading icon': true, Icon: { icon: 'plus' } }); }
function fullButton(label, variant, state) { return inst('Button', { Variant: variant || 'Primary', Size: 'Touch', State: state || 'Default', Label: label }, { name: 'primary-action', sizeH: 'FILL' }); }

// ---- Members (T8, B1)
const ADMIN_MEMBERS = [
  { i: 'LH', tone: 'Teal', name: 'Layla Haddad', email: 'layla.haddad@mondapac.example', you: true, role: 'Compliance lead', status: 'Active' },
  { i: 'OS', tone: 'Blue', name: 'Omar Saleh', email: 'omar.saleh@mondapac.example', role: 'Platform owner', system: true, status: 'Active' },
  { i: 'AS', tone: 'Amber', name: 'Amira Said', email: 'amira.said@mondapac.example', role: 'Finance reviewer', status: 'Active' },
  { i: 'NH', tone: 'Purple', name: 'Noor Hassan', email: 'noor.hassan@mondapac.example', role: 'Seller reviewer', status: 'Invited' },
  { i: 'SO', tone: 'Neutral', name: 'Sam Okafor', email: 'sam.okafor@mondapac.example', role: 'Support agent', status: 'Deactivated' },
];
const SELLER_MEMBERS = [
  { i: 'YK', tone: 'Teal', name: 'Yusuf Karimi', email: 'yusuf@kurabyfresh.example', you: true, role: 'Owner', system: true, two: 'On', status: 'Active' },
  { i: 'AR', tone: 'Amber', name: 'Amina Rahman', email: 'amina.rahman@kurabyfresh.example', role: 'Order packer', two: 'Off', status: 'Active' },
  { i: 'TN', tone: 'Blue', name: 'Tariq Nasser', email: 'tariq.nasser@kurabyfresh.example', role: 'Order packer', two: null, status: 'Invited' },
];
function membersTable(ws, state) {
  const admin = ws === 'Admin';
  const cols = admin ? [['Person', 'fill'], ['Role', 220], ['Status', 170], ['', 56]] : [['Person', 'fill'], ['Role', 200], ['Two-step verification', 200], ['Status', 150], ['', 56]];
  // A list that cannot load is an InfoBanner Critical with "Try again", not an empty state (title: identity.error.list-load.title, body: identity.error.network).
  if (state === 'Load error') return inst('InfoBanner', { Tone: 'Critical', Title: 'We couldn’t load this list', Body: 'You’re offline or the connection dropped. Check it and try again.', 'Show action': true, Action: 'Try again' }, { name: 'load-error', sizeH: 'FILL' });
  const kids = [headerRow(cols)];
  if (state === 'Loading') return card('Member list', kids.concat(loadingRows(admin ? [['Two-line', 'fill'], ['Text', 220], ['Text', 170], ['Actions', 56]] : [['Two-line', 'fill'], ['Text', 200], ['Text', 200], ['Text', 150], ['Actions', 56]])));
  if (state === 'Empty') return card('Member list', kids.concat([inst('EmptyState', { Size: 'Card', Icon: { icon: 'users' }, Title: 'It’s just you so far', Body: 'Invite the people who help run your shop. Each person gets their own sign-in.' }, { name: 'empty-state', sizeH: 'FILL' })]));
  (admin ? ADMIN_MEMBERS : SELLER_MEMBERS).forEach(function (m) {
    const cells = [[personCell(m), 'fill'], [roleNodes(m), admin ? 220 : 200, { gap: 'space/1-5' }]];
    if (!admin) cells.push([m.two ? statusBadge(m.two) : null, 200]);
    cells.push([statusBadge(m.status), admin ? 170 : 150], [rowAction(), 56, { justify: 'center' }]);
    kids.push(row(cells, false, false, 64));
  });
  return card('Member list', kids);
}
function tplMembersAdmin(state) {
  const view = state === 'View only';
  const scr = shellPage('Shared · Members · Admin' + (state ? ' · ' + state : ''), 'Admin', 'Roles & permissions', [
    pageTitle('Roles & permissions', view ? VIEW_ONLY : null, [primaryHeaderButton('Invite admin', view ? 'Disabled' : 'Default')]),
    tabsBar([['Admins', '5', true], ['Roles', null, false]]),
    membersTable('Admin', state === 'Loading' || state === 'Load error' ? state : null),
  ]);
  // The menus are placed by estimate under the actions button of the third row (a peer the actor may manage) or the first row (view only); nudge in Figma.
  // A member who outranks the actor or is the last holder of a system role (Omar Saleh) gets every item disabled (ux.md F11 steps 4-5).
  if (state === 'Menu open') add(scr, rowMenu([['Default', 'Change role', 'user'], ['Default', 'Reset two-step verification', 'smartphone'], ['Destructive', 'Deactivate account…', 'ban']], [1128, 438]));
  if (view) add(scr, rowMenu([['Disabled', 'Change role', 'user', VIEW_ONLY], ['Disabled', 'Reset two-step verification', 'smartphone', VIEW_ONLY], ['Disabled', 'Deactivate account…', 'ban', VIEW_ONLY]], [1128, 310]));
  return scr;
}
function tplMembersSeller(state) {
  const scr = shellPage('Shared · Members · Seller' + (state ? ' · ' + state : ''), 'Seller', 'Team & roles', [
    pageTitle('Team & roles', null, [primaryHeaderButton('Invite team member')]),
    tabsBar([['Team', '2', true], ['Roles', null, false]]),
    panelBanner('Team members can sign in now.', 'The parts of the panel they can use appear as MondaPac adds features.'),
    membersTable('Seller', state),
  ]);
  return scr;
}
function memberCard(m, seller) {
  const badges = [statusBadge(m.status)]; if (seller && m.two) badges.push(bdg('Neutral', 'None', 'Two-step ' + m.two.toLowerCase()));
  return frame({ name: m.name, dir: 'V', gap: 'space/3', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
    frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, personCell(m).concat([rowAction(true)])),
    frame({ name: 'role', dir: 'H', gap: 'space/2', align: 'center' }, [text('Role', 'Caption/Default', 'text/muted')].concat(roleNodes(m))),
    frame({ name: 'badges', dir: 'H', gap: 'space/2', align: 'center' }, badges),
  ]);
}
// 1.8.1: the 360 x 780 admin screen (clipped Main, no bottom bar) has room for three member cards; the other two are on the desktop table.
const ADMIN_PHONE_CARDS = 3;
function tplMembersPhone(ws) {
  const seller = ws === 'Seller';
  const kids = [text(seller ? 'Team & roles' : 'Roles & permissions', 'Heading/H1', 'text/primary', { sizeH: 'FILL' })];
  if (seller) kids.push(panelBanner('Team members can sign in now.', 'The parts of the panel they can use appear as MondaPac adds features.'));
  kids.push(fullButton(seller ? 'Invite team member' : 'Invite admin'));
  (seller ? SELLER_MEMBERS : ADMIN_MEMBERS.slice(0, ADMIN_PHONE_CARDS)).forEach(function (m) { kids.push(memberCard(m, seller)); });
  const scr = phoneScreen('Shared · Members · ' + ws + ' (phone)', ws, kids, seller ? 'More' : null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- Roles (T8, B2)
const ROLE_GROUPS = {
  Admin: [['System', [{ name: 'Platform owner', system: true, type: 'System', perms: 'All', members: '1' }]],
    ['Default', [{ name: 'Seller reviewer', purpose: 'Reviews seller applications and certificates.', type: 'Default', perms: '14', members: '2' }, { name: 'Support agent', purpose: 'Answers sellers and customers.', type: 'Default', perms: '8', members: '3' }]],
    ['Custom', [{ name: 'Compliance lead', type: 'Custom', perms: '12', members: '1' }, { name: 'Finance reviewer', type: 'Custom', perms: '9', members: '1' }, { name: 'Content editor', type: 'Custom', perms: 'None yet', members: '0' }]]],
  Seller: [['Owner', [{ name: 'Owner', system: true, type: 'Owner', perms: 'All', members: '1' }]],
    ['Ready-made', [{ name: 'Order packer', purpose: 'Packs and prepares orders.', type: 'Ready-made', perms: '4', members: '1' }, { name: 'Catalogue editor', purpose: 'Keeps offers and stock up to date.', type: 'Ready-made', perms: '3', members: '0' }]],
    ['Custom', [{ name: 'Shift lead', type: 'Custom', perms: '6', members: '0' }]]],
};
function roleRow(r) {
  const nameNodes = (r.system ? [icon('lock', 'icon/muted', 14)] : []).concat([frame({ name: 'role', dir: 'V', sizeH: 'FILL' }, [text(r.name, 'Body/Strong'), r.purpose ? text(r.purpose, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true }) : null])]);
  return row([[nameNodes, 'fill'], [typeBadge(r.type), 160], [text(r.perms, 'Body/Default'), 140], [text(r.members, 'Body/Default'), 120], [rowAction(), 56, { justify: 'center' }]], false, false, r.purpose ? 64 : 56);
}
function rolesTable(ws, noCustom) {
  const kids = [headerRow([['Role', 'fill'], ['Type', 160], ['Permissions', 140], ['Members', 120], ['', 56]])];
  ROLE_GROUPS[ws].forEach(function (g) {
    kids.push(groupRow(g[0]));
    if (g[0] === 'Custom' && noCustom) {
      const es = inst('EmptyState', { Size: 'Compact', Icon: { icon: 'users' }, Title: 'No custom roles yet', Body: (ws === 'Admin' ? 'Default' : 'Ready-made') + ' roles cover common jobs. Create a role when you need a different mix of permissions.' }, { name: 'empty-state', sizeH: 'FILL' });
      setNested(es, 'action', prop('Button', 'Label', 'Create role'));
      kids.push(es);
    } else g[1].forEach(function (r) { kids.push(roleRow(r)); });
  });
  return card('Role list', kids);
}
function tplRoles(ws, noCustom) {
  const admin = ws === 'Admin';
  return shellPage('Shared · Roles · ' + ws + (noCustom ? ' · No custom roles' : ''), ws, admin ? 'Roles & permissions' : 'Team & roles', [
    pageTitle(admin ? 'Roles & permissions' : 'Team & roles', null, [primaryHeaderButton('Create role')]),
    tabsBar(admin ? [['Admins', '5', false], ['Roles', null, true]] : [['Team', '2', false], ['Roles', null, true]]),
    rolesTable(ws, noCustom),
  ]);
}
function tplRolesPhone(ws) {
  const kids = [text(ws === 'Admin' ? 'Roles & permissions' : 'Team & roles', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), fullButton('Create role')];
  ROLE_GROUPS[ws].forEach(function (g) {
    kids.push(text(g[0], 'Caption/Overline', 'text/muted'));
    g[1].forEach(function (r) {
      kids.push(frame({ name: r.name, dir: 'V', gap: 'space/2', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
        frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', justify: 'between', sizeH: 'FILL' }, [text(r.name, 'Body/Strong', 'text/primary', { sizeH: 'FILL' }), typeBadge(r.type), rowAction(true)]),
        r.purpose ? text(r.purpose, 'Caption/Default', 'text/muted', { sizeH: 'FILL' }) : null,
        text((r.perms === 'All' ? 'All permissions' : (r.perms === 'None yet' ? 'No permissions yet' : r.perms + ' permissions')) + ' · ' + r.members + ' members', 'Body/Small', 'text/secondary'),
      ]));
    });
  });
  const scr = phoneScreen('Shared · Roles · ' + ws + ' (phone)', ws, kids, ws === 'Seller' ? 'More' : null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- No access and Not found (T9, B5): the shell stays, an EmptyState Page fills the content area
const NO_ACCESS = { icon: 'lock', title: 'You don’t have access to this page', action: 'Go to Home',
  Seller: 'Your role doesn’t include it. Ask your shop owner if you need it.', Admin: 'Your role doesn’t include it. Ask an admin who manages roles.' };
const NOT_FOUND = { icon: 'search', title: 'We can’t find that page', body: 'It may have been removed, or the link may be wrong.', action: 'Go to Home' };
function emptyPage(o) {
  const es = inst('EmptyState', { Size: 'Page', Icon: { icon: o.icon }, Title: o.title, Body: o.body }, { name: 'empty-state', sizeH: o.fill ? 'FILL' : null });
  setNested(es, 'action', prop('Button', 'Label', o.action));
  return es;
}
function tplNoAccess(ws) {
  return shellPage('Shared · No access · ' + ws, ws, ws === 'Seller' ? 'Team & roles' : 'Roles & permissions', [
    frame({ name: 'Content', dir: 'V', align: 'center', justify: 'center', sizeH: 'FILL', sizeV: 'FILL' }, [emptyPage({ icon: NO_ACCESS.icon, title: NO_ACCESS.title, body: NO_ACCESS[ws], action: NO_ACCESS.action })]),
  ], { fixedH: 900 });
}
function tplNotFound() {
  // The crumb and the text name no resource: the answer is the same for a missing record and another seller's record.
  return shellPage('Shared · Not found', 'Seller', 'Not found', [
    frame({ name: 'Content', dir: 'V', align: 'center', justify: 'center', sizeH: 'FILL', sizeV: 'FILL' }, [emptyPage(NOT_FOUND)]),
  ], { fixedH: 900 });
}
function tplEmptyPhone(name, ws, o) {
  const scr = phoneScreen(name, ws, [frame({ name: 'Content', dir: 'V', align: 'center', justify: 'center', sizeH: 'FILL', sizeV: 'FILL' }, [emptyPage(Object.assign({ fill: true }, o))])], ws === 'Seller' ? 'More' : null);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- Account security (B4)
function securityPassword(o) {
  const kids = [
    authField('Current password', { type: 'Password', filled: true, error: o.errors ? 'Your current password is incorrect.' : null }),
    authField('New password', { type: 'Password', filled: true, helper: o.errors ? null : AUTH_POLICY, error: o.errors ? 'Use 15 to 128 characters.' : null }),
  ];
  if (o.code) kids.push(authField('6-digit code', { type: 'Code', filled: true }));
  kids.push(inst('Button', { Variant: 'Primary', Size: o.touch ? 'Touch' : 'Md', State: 'Default', Label: 'Change password' }, { name: 'primary-action', sizeH: o.touch ? 'FILL' : null }));
  return card('Password', [header('Password', null), frame({ name: 'form', dir: 'V', gap: 'space/4', pad: [0, 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, kids)], { sizeH: 'FILL' });
}
function securityTwoStep(kind, touch) {
  const on = kind === 'admin' || kind === 'on';
  const size = touch ? 'Touch' : 'Md';
  const b = function (label, variant) { return inst('Button', { Variant: variant || 'Secondary', Size: size, State: 'Default', Label: label }, { name: 'action', sizeH: touch ? 'FILL' : null }); };
  const kids = [frame({ name: 'status', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, [on ? bdg('Success', 'Icon', 'On since 3 Oct 2026', 'check') : bdg('Neutral', 'Icon', 'Off', 'x'), on ? text('8 backup codes left', 'Body/Default', 'text/secondary') : null])];
  if (kind === 'admin') kids.push(text('Admin accounts must keep two-step verification on.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }));
  if (kind === 'off' || kind === 'link') kids.push(text('Shop owners will need two-step verification before payouts are switched on.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }));
  if (kind === 'link') {
    kids.push(text('We’ve sent a link to ' + AUTH.Seller.email + '. Open it within 60 minutes to set up two-step verification.', 'Body/Small', 'text/secondary', { name: 'link-sent', sizeH: 'FILL' }));
    kids.push(inst('Button', { Variant: 'Link', Size: size, State: 'Default', Label: 'Send it again' }, { name: 'resend' }));
  }
  const actions = kind === 'admin' ? [b('Get new backup codes'), b('Move to a new phone')] : (kind === 'on' ? [b('Get new backup codes'), b('Move to a new phone'), b('Turn off…', 'Destructive')] : [b('Set up')]);
  kids.push(frame({ name: 'actions', dir: touch ? 'V' : 'H', gap: 'space/2', wrap: !touch, rowGap: 'space/2', sizeH: 'FILL' }, actions));
  return card('Two-step verification', [header('Two-step verification', null), frame({ name: 'body', dir: 'V', gap: 'space/3', pad: [0, 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, kids)]);
}
function tplSecurity(ws, kind, errors, saved) {
  const admin = ws === 'Admin';
  const suffix = saved ? ' · Saved' : (admin ? '' : ' · ' + { off: 'Off', link: 'Link sent', on: 'On' }[kind]);
  const scr = shellPage('Shared · Account security · ' + ws + suffix + (errors ? ' · Errors' : ''), ws, 'Account security', [
    pageTitle('Account security', null, []),
    frame({ name: 'Cards', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [securityPassword({ code: kind === 'admin' || kind === 'on', errors: errors }), securityTwoStep(kind)]),
  ], saved ? { fixedH: 900 } : undefined);
  // Toast at the bottom end of the content area, 24 px from the edges (its height is about 76 px).
  if (saved) add(scr, inst('Toast', { Tone: 'Success', Message: 'Password changed. You’ve been signed out on your other devices.' }, { name: 'Toast', abs: [1440 - 400 - 24, 900 - 76 - 24] }));
  return scr;
}
function tplSecurityPhone() {
  const scr = phoneScreen('Shared · Account security · Seller (phone)', 'Seller', [text('Account security', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), securityPassword({ code: false, touch: true }), securityTwoStep('off', true)], 'More');
  applyDensity(scr, 'touch');
  return scr;
}

// ---- Dialogs D1 to D3: template bodies (swap targets of the Dialog Content slot), the dialog instances and the scrim scenes
function tplBody(name, build) {
  if (S.sets[name] && S.sets[name].comp) return S.sets[name].comp;
  const c = figma.createComponent(); c.name = name; c.fills = [];
  body(c, { dir: 'V', w: 360, gap: 'space/4' }, build());
  c.description = 'Template body for the dialog frames: the swap target of the Dialog Content slot. Not library API; the code builds these bodies from Field, Input, Select and Textarea.';
  tag(c); S.sets[name] = { comp: c, keys: {}, axes: [] }; PANEL_BODIES.push(c); S.counts.components++;
  return c;
}
// A Field whose control is a Select (o.select = { state, value }) or an Input (see authField).
function panelField(label, o) {
  o = o || {};
  if (!o.select) return authField(label, o);
  const props = { Label: label, 'Show helper': !!o.helper, 'Show error': false, Control: { comp: S.sets.Select.set.children.filter(function (c) { return c.name === 'State=Default'; })[0] } };
  if (o.helper) props.Helper = o.helper;
  const f = inst('Field', props, { name: 'field-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), sizeH: 'FILL' });
  setNested(f, 'control', Object.assign({ State: o.select.state }, prop('Select', 'Value', o.select.value)));
  return f;
}
function readOnlyPair(label, value) { return frame({ name: label, dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(label, 'Caption/Default', 'text/muted'), text(value, 'Body/Default', 'text/primary', { sizeH: 'FILL' })]); }
function roleList() {
  const m = inst('Menu', { 'Show header': false, 'Show divider': false }, { name: 'role-list', sizeH: 'FILL' });
  setNested(m, 'item-1', menuItemProps('Selected', 'Seller reviewer', null, 'Reviews seller applications and certificates.', false));
  setNested(m, 'item-2', menuItemProps('Default', 'Support agent', null, 'Answers sellers and customers.', false));
  setNested(m, 'item-3', menuItemProps('Disabled', 'Platform owner', null, NOT_HELD, false));
  return m;
}
function bodyInvite(ws, open) {
  const admin = ws === 'Admin';
  const helper = 'They’ll get an email with a link to set their own password. The link works for ' + (admin ? '72 hours' : '7 days') + '.';
  const email = panelField('Email', { value: admin ? 'noor.hassan@mondapac.example' : 'tariq.nasser@kurabyfresh.example' });
  if (!open) return [email, panelField('Role', { select: { state: 'Default', value: 'Select a role' }, helper: helper })];
  return [email, frame({ name: 'role-open', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [panelField('Role', { select: { state: 'Open', value: 'Seller reviewer' } }), roleList(), text(helper, 'Caption/Default', 'text/muted', { sizeH: 'FILL' })])];
}
function bodyChangeRole(ws) {
  const admin = ws === 'Admin';
  return [frame({ name: 'current', dir: 'V', gap: 'space/3', sizeH: 'FILL' }, [readOnlyPair('Name', admin ? 'Amira Said' : 'Amina Rahman'), readOnlyPair('Current role', admin ? 'Finance reviewer' : 'Order packer')]),
    panelField('Role', { select: { state: 'Filled', value: admin ? 'Support agent' : 'Catalogue editor' } }),
    text(DIALOGBODY_TEXT, 'Body/Default', 'text/secondary', { name: 'note', sizeH: 'FILL' })];
}
// o: { name, title, primary, secondary, size, tone, layout, content, text, focusCancel, hideSecondary }
function dlg(o) {
  const p = { Size: o.size || 'Sm', Tone: o.tone || 'Default', Layout: o.layout || 'Centred', Title: o.title, 'Show secondary': !o.hideSecondary };
  if (o.content) p.Content = { comp: o.content };
  const d = inst('Dialog', p, { name: o.name });
  setNested(d, 'primary', prop('Button', 'Label', o.primary));
  if (o.secondary) setNested(d, 'secondary', prop('Button', 'Label', o.secondary));
  if (o.focusCancel) setNested(d, 'secondary', { State: 'Focus' }); // Destructive opens with focus on Cancel
  if (o.text) setNested(d, 'content', prop('DialogBody', 'Body', o.text));
  return d;
}
function dialogScene(name, dialogs) {
  const scr = frame({ name: name, w: 1440, h: 900, fill: 'bg/page', clip: true });
  add(scr, frame({ name: 'scrim', w: 1440, h: 900, fill: 'bg/scrim' }));
  const rowF = frame({ name: 'dialogs', dir: 'H', wrap: true, gap: 'space/6', rowGap: 'space/6', align: 'start', justify: 'center', w: 1280 }, dialogs);
  scr.appendChild(rowF); rowF.x = 80; rowF.y = 80;
  tag(scr);
  return scr;
}
function sheetScene(name, d) {
  const scr = frame({ name: name, w: 360, h: 780, fill: 'bg/page', clip: true });
  add(scr, frame({ name: 'scrim', w: 360, h: 780, fill: 'bg/scrim' }));
  scr.appendChild(d); d.x = 0; d.y = 780 - d.height;
  applyDensity(scr, 'touch');
  tag(scr);
  return scr;
}
function tplDialogsMembers() {
  const b1 = tplBody('Template body · D1 Invite (Admin)', function () { return bodyInvite('Admin', false); });
  const b1o = tplBody('Template body · D1 Invite (Admin, list open)', function () { return bodyInvite('Admin', true); });
  const b2 = tplBody('Template body · D2 Change role (Admin)', function () { return bodyChangeRole('Admin'); });
  return dialogScene('Dialogs · Members · Admin', [
    dlg({ name: 'D1 Invite an admin', title: 'Invite an admin', primary: 'Send invitation', secondary: 'Cancel', content: b1 }),
    dlg({ name: 'D1 Invite an admin · list open', title: 'Invite an admin', primary: 'Send invitation', secondary: 'Cancel', content: b1o }),
    dlg({ name: 'D2 Change role', title: 'Change role for Amira Said', primary: 'Change role', secondary: 'Cancel', content: b2 }),
  ]);
}
function tplDialogsConfirm() {
  return dialogScene('Dialogs · Confirm · Admin', [
    dlg({ name: 'Approve', title: 'Approve this seller?', text: 'They get full access to the seller panel and an email to say so.', primary: 'Approve seller', secondary: 'Cancel' }),
    dlg({ name: 'Deactivate admin', tone: 'Destructive', title: 'Deactivate Amira Said’s admin account?', text: 'They’re signed out straight away and can’t sign in.', primary: 'Deactivate account', secondary: 'Cancel', focusCancel: true }),
    dlg({ name: 'Delete role', tone: 'Destructive', title: 'Delete the role “Finance reviewer”?', text: 'This can’t be undone. 2 pending invitations with this role stop working.', primary: 'Delete role', secondary: 'Cancel', focusCancel: true }),
    dlg({ name: 'Cancel invitation', tone: 'Destructive', title: 'Cancel the invitation to noor.hassan@mondapac.example?', text: 'The link in their email stops working.', primary: 'Cancel invitation', secondary: 'Keep invitation', focusCancel: true }),
    dlg({ name: 'Reset two-step verification', tone: 'Destructive', title: 'Reset two-step verification for Amira Said?', text: 'They’re signed out. At their next sign-in we email them a link to set it up again.', primary: 'Reset', secondary: 'Cancel', focusCancel: true }),
  ]);
}
function tplDialogsTeam() {
  const b1 = tplBody('Template body · D1 Invite (Seller)', function () { return bodyInvite('Seller', false); });
  const b2 = tplBody('Template body · D2 Change role (Seller)', function () { return bodyChangeRole('Seller'); });
  return dialogScene('Dialogs · Team · Seller', [
    dlg({ name: 'D1 Invite a team member', title: 'Invite a team member', primary: 'Send invitation', secondary: 'Cancel', content: b1 }),
    dlg({ name: 'D2 Change role', title: 'Change role for Amina Rahman', primary: 'Change role', secondary: 'Cancel', content: b2 }),
    dlg({ name: 'D3 Remove from team', tone: 'Destructive', title: 'Remove Amina Rahman from your team?', text: 'They’re signed out straight away and can’t sign in to your seller panel again.', primary: 'Remove from team', secondary: 'Cancel', focusCancel: true }),
  ]);
}
function tplSheetChangeRole() {
  const b2 = tplBody('Template body · D2 Change role (Admin)', function () { return bodyChangeRole('Admin'); });
  return sheetScene('Dialog sheet · Change role (phone)', dlg({ name: 'D2 Change role (sheet)', layout: 'Sheet', title: 'Change role for Amira Said', primary: 'Change role', secondary: 'Cancel', content: b2 }));
}
function tplSheetRemove() {
  return sheetScene('Dialog sheet · Remove from team (phone)', dlg({ name: 'D3 Remove from team (sheet)', layout: 'Sheet', tone: 'Destructive', title: 'Remove Amina Rahman from your team?', text: 'They’re signed out straight away and can’t sign in to your seller panel again.', primary: 'Remove from team', secondary: 'Cancel', focusCancel: true }));
}

// ---- the list of 1.8.0 frames: [group, name, make]. "Update library" builds only the names a file does not have yet.
const PANEL_ROWS = ['members', 'roles', 'access', 'security', 'dialogs', 'phone'];
function panelDefs() {
  return {
    'tpl-admin': [
      ['members', 'Shared · Members · Admin', function () { return tplMembersAdmin(null); }],
      ['members', 'Shared · Members · Admin · Menu open', function () { return tplMembersAdmin('Menu open'); }],
      ['members', 'Shared · Members · Admin · Loading', function () { return tplMembersAdmin('Loading'); }],
      ['members', 'Shared · Members · Admin · Load error', function () { return tplMembersAdmin('Load error'); }],
      ['members', 'Shared · Members · Admin · View only', function () { return tplMembersAdmin('View only'); }],
      ['roles', 'Shared · Roles · Admin', function () { return tplRoles('Admin', false); }],
      ['roles', 'Shared · Roles · Admin · No custom roles', function () { return tplRoles('Admin', true); }],
      ['access', 'Shared · No access · Admin', function () { return tplNoAccess('Admin'); }],
      ['security', 'Shared · Account security · Admin', function () { return tplSecurity('Admin', 'admin', false); }],
      ['security', 'Shared · Account security · Admin · Errors', function () { return tplSecurity('Admin', 'admin', true); }],
      ['dialogs', 'Dialogs · Members · Admin', tplDialogsMembers],
      ['dialogs', 'Dialogs · Confirm · Admin', tplDialogsConfirm],
      ['phone', 'Shared · Members · Admin (phone)', function () { return tplMembersPhone('Admin'); }],
      ['phone', 'Shared · Not found · Admin (phone)', function () { return tplEmptyPhone('Shared · Not found · Admin (phone)', 'Admin', NOT_FOUND); }],
      ['phone', 'Dialog sheet · Change role (phone)', tplSheetChangeRole],
    ],
    'tpl-seller': [
      ['members', 'Shared · Members · Seller', function () { return tplMembersSeller(null); }],
      ['members', 'Shared · Members · Seller · Empty', function () { return tplMembersSeller('Empty'); }],
      ['members', 'Shared · Members · Seller · Loading', function () { return tplMembersSeller('Loading'); }],
      ['members', 'Shared · Members · Seller · Load error', function () { return tplMembersSeller('Load error'); }],
      ['roles', 'Shared · Roles · Seller', function () { return tplRoles('Seller', false); }],
      ['roles', 'Shared · Roles · Seller · No custom roles', function () { return tplRoles('Seller', true); }],
      ['access', 'Shared · No access · Seller', function () { return tplNoAccess('Seller'); }],
      ['access', 'Shared · Not found', tplNotFound],
      ['security', 'Shared · Account security · Seller · Off', function () { return tplSecurity('Seller', 'off', false); }],
      ['security', 'Shared · Account security · Seller · Link sent', function () { return tplSecurity('Seller', 'link', false); }],
      ['security', 'Shared · Account security · Seller · On', function () { return tplSecurity('Seller', 'on', false); }],
      ['security', 'Shared · Account security · Seller · Saved', function () { return tplSecurity('Seller', 'off', false, true); }],
      ['dialogs', 'Dialogs · Team · Seller', tplDialogsTeam],
      ['phone', 'Shared · Members · Seller (phone)', function () { return tplMembersPhone('Seller'); }],
      ['phone', 'Shared · Roles · Seller (phone)', function () { return tplRolesPhone('Seller'); }],
      ['phone', 'Shared · No access · Seller (phone)', function () { return tplEmptyPhone('Shared · No access · Seller (phone)', 'Seller', { icon: NO_ACCESS.icon, title: NO_ACCESS.title, body: NO_ACCESS.Seller, action: NO_ACCESS.action }); }],
      ['phone', 'Shared · Account security · Seller (phone)', tplSecurityPhone],
      ['phone', 'Dialog sheet · Remove from team (phone)', tplSheetRemove],
    ],
  };
}
// The desktop pages built by shellPage (they hug their content, 1.8.1 minimum height): every group except the dialog scenes and the phone frames.
function panelShellNames(key) { return panelDefs()[key].filter(function (d) { return ['members', 'roles', 'access', 'security'].indexOf(d[0]) >= 0; }).map(function (d) { return d[1]; }); }
function panelNames(key) { return panelDefs()[key].map(function (d) { return d[1]; }); }
// Build the frames in `names` (all when omitted), one canvas row per group below what the host already holds, then the template bodies
// that were made on the way. Returns how many of each were made.
// 1.8.3 passes its own list (panel183Defs, PANEL183_ROWS); its rows go below the 1.8.0 ones.
function addPanelTemplates(host, key, names, defsOf, groups) {
  const defs = (defsOf || panelDefs)()[key].filter(function (d) { return !names || names.indexOf(d[1]) >= 0; });
  const rows = (groups || PANEL_ROWS).map(function (g) { return defs.filter(function (d) { return d[0] === g; }).map(function (d) { return d[2](); }); });
  const y = placeRows(host, rows, bottomEdge(host) + 240);
  const bodies = PANEL_BODIES.length;
  let x = 0; PANEL_BODIES.forEach(function (c) { host.appendChild(c); c.x = x; c.y = y; x += c.width + 80; });
  PANEL_BODIES.length = 0;
  return { frames: defs.length, bodies: bodies };
}
// The sets 1.8.0 templates place (a template is built only when each one is the plugin's own).
const PANEL_TEMPLATE_NEEDS = ['Sidebar', 'Topbar', 'PhoneTopbar', 'BottomTabBar', 'Button', 'Input', 'Field', 'Select', 'Menu', 'MenuItem', 'Badge', 'InfoBanner', 'IdentityTile', 'IconButton', 'Tab', 'CardHeader', 'TableCell', 'Checkbox', 'EmptyState', 'Dialog', 'DialogBody', 'Toast'];
