// ---------------------------------------------------------------- navigation & shell
const NAV = {
  Admin: [['nav-home', 'Home', 'home'], ['nav-review', 'Review queue', 'inbox', ['Attention', '35']], ['g', 'Commerce'], ['nav-orders', 'Orders', 'clipboard', null, true], ['nav-catalogue', 'Catalogue', 'package', null, true],
    ['nav-sellers', 'Sellers', 'store', ['Neutral', '6']], ['nav-customers', 'Customers', 'users'], ['g', 'Money'], ['nav-finance', 'Finance', 'wallet', null, true], ['g', 'Platform'],
    ['nav-content', 'Content', 'file-text'], ['nav-settings', 'Settings', 'sliders'], ['nav-audit', 'Audit log', 'shield-check']],
  Seller: [['nav-home', 'Home', 'home'], ['nav-orders', 'Orders', 'clipboard', ['Attention', '3']], ['sub', 'Order board', 'nav-board'], ['sub', 'All orders', 'nav-all-orders'], ['nav-returns', 'Returns', 'undo'], ['g', 'Shop'],
    ['nav-catalogue', 'Catalogue', 'package', null, true], ['nav-certs', 'Certifications', 'badge-check', ['Attention', '1']], ['nav-messages', 'Messages', 'message', ['Neutral', '2']], ['g', 'Money'],
    ['nav-payouts', 'Payouts', 'wallet'], ['nav-settings', 'Settings', 'sliders']],
};
async function buildNavigation(page) {
  const root = pageShell(page, 'Navigation & shell', 'One shell for both panels. The Sidebar variant decides the workspace; the menu items come from configuration and permissions.');
  const NI = { Default: [null, 'text/secondary', 'icon/default', 'Body/Medium'], Hover: ['bg/subtle', 'text/primary', 'icon/default', 'Body/Medium'], Active: ['bg/selected', 'text/link', 'text/link', 'Body/Strong'], Parent: [null, 'text/primary', 'icon/default', 'Body/Strong'] };
  const navItem = makeSet('NavItem', { State: Object.keys(NI), Collapsed: ['False', 'True'] }, function (c, p) {
    const t = NI[p.State];
    if (p.Collapsed === 'True') {
      body(c, { dir: 'H', w: 44, h: 36, align: 'center', justify: 'center', fill: t[0], radius: 'radius/control' }, [icon('home', t[2], 18)]);
      c.children[0].name = 'icon';
    } else {
      body(c, { dir: 'H', w: 224, h: 36, px: 'space/2-5', gap: 'space/2-5', align: 'center', fill: t[0], radius: 'radius/control' }, [
        icon('home', t[2], 18), text('Home', t[3], t[1], { name: 'label', sizeH: 'FILL' }), inst('CountBadge', { Tone: 'Attention', Count: '3' }, { name: 'count' }), icon('chevron-down', 'icon/muted', 16),
      ]);
      c.children[0].name = 'icon'; c.children[3].name = 'chevron';
      safe('expose count', function () { c.children[2].isExposedInstance = true; });
    }
  }, { width: 760, desc: 'Sidebar item. Collapsed shows the icon only (tablet).', text: [{ prop: 'Label', node: 'label', def: 'Home' }], bool: [{ prop: 'Show count', node: 'count', def: false }, { prop: 'Show chevron', node: 'chevron', def: false }], swap: [{ prop: 'Icon', node: 'icon', def: 'home' }] });
  componentBlock(root, navItem, { title: 'NavItem', summary: 'Active item uses bg/selected and text/link; a parent of the active child is bold.', a11y: ['aria-current="page" on the active item.', 'Collapsed items show the label as a tooltip.'] });

  const sub = makeSet('NavSubItem', { State: ['Default', 'Active'] }, function (c, p) {
    const on = p.State === 'Active';
    body(c, { dir: 'H', w: 224, h: 32, pad: [0, 10, 0, 38], align: 'center', fill: on ? 'bg/selected' : null, radius: 'radius/control' }, [text('All orders', on ? 'Body/Strong' : 'Body/Default', on ? 'text/link' : 'text/secondary', { name: 'label' })]);
  }, { width: 520, desc: 'Child link under an expanded NavItem. Indented 38 px; Active uses bg/selected and text/link.', text: [{ prop: 'Label', node: 'label', def: 'All orders' }] });
  const grp = makeComponent('NavGroupLabel', function (c) {
    body(c, { dir: 'H', w: 224, pad: [16, 10, 6, 10] }, [text('Commerce', 'Caption/Overline', 'text/muted', { name: 'label' })]);
  }, { desc: 'Uppercase overline that groups navigation items (Commerce, Trust, Money). Hidden when the sidebar is collapsed.', text: [{ prop: 'Label', node: 'label', def: 'Commerce' }] });
  const subWrap = frame({ name: 'Sub items', dir: 'H', gap: 'space/6', align: 'start' }, [sub, frame({ name: 'Group label', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }, [grp])]);
  componentBlock(root, subWrap, { title: 'NavSubItem · NavGroupLabel', summary: 'Children appear under the active parent only. Group labels are uppercase overlines.' });

  const sidebar = makeSet('Sidebar', { Workspace: ['Admin', 'Seller'], Collapsed: ['False', 'True'] }, function (c, p) {
    const col = p.Collapsed === 'True';
    body(c, { dir: 'V', w: col ? 'size/sidebar-collapsed' : 'size/sidebar', h: 900, fill: 'bg/surface', stroke: 'border/default', sides: ['right'] }, []);
    add(c, frame({ name: 'brand', dir: 'H', h: 64, px: 'space/4', gap: 'space/2-5', align: 'center', justify: col ? 'center' : 'start', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [
      brandMark(30), col ? null : frame({ name: 'name', dir: 'V' }, [text('MondaPac', 'Heading/H2'), text(p.Workspace === 'Admin' ? 'Admin' : 'Seller Centre', 'Caption/Overline', 'text/muted')]),
    ]));
    if (p.Workspace === 'Seller' && !col) {
      add(c, frame({ name: 'shop-switcher', dir: 'H', pad: [12, 12, 4, 12], sizeH: 'FILL' }, [frame({ name: 'button', dir: 'H', h: 40, px: 'space/2-5', gap: 'space/2', align: 'center', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [
        inst('IdentityTile', { Tone: 'Teal', Shape: 'Rounded', Initials: 'KF' }), text('Kuraby Fresh Halal Meats', 'Body/Strong', 'text/primary', { sizeH: 'FILL', truncate: true }), icon('chevron-down', 'icon/muted', 16),
      ])]));
      const sw = c.children[1].children[0].children[0]; sw.resize(22, 22);
    }
    const list = frame({ name: 'items', dir: 'V', gap: 'space/0-5', pad: 'space/3', sizeH: 'FILL', sizeV: 'FILL', align: col ? 'center' : 'start' });
    NAV[p.Workspace].forEach(function (it, i) {
      if (it[0] === 'g') { if (!col) add(list, inst('NavGroupLabel', { Label: it[1] }, { name: 'group-' + it[1].toLowerCase() })); return; }
      if (it[0] === 'sub') { if (!col) add(list, inst('NavSubItem', { State: 'Default', Label: it[1] }, { name: it[2] })); return; }
      const props = { State: i === 0 ? 'Active' : 'Default', Collapsed: col ? 'True' : 'False', Icon: { icon: it[2] } };
      if (!col) { props.Label = it[1]; props['Show count'] = !!it[3]; props['Show chevron'] = !!it[4]; }
      const n = inst('NavItem', props, { name: it[0] });
      if (!col && it[3]) { const b = n.findOne(function (x) { return x.name === 'count'; }); b.setProperties({ Tone: it[3][0] }); const cp = {}; cp[S.sets.CountBadge.keys.Count] = it[3][1]; b.setProperties(cp); }
      add(list, n);
    });
    add(c, list);
    const foot = frame({ name: 'footer', dir: 'V', gap: 'space/0-5', pad: 'space/3', stroke: 'border/default', sides: ['top'], sizeH: 'FILL', align: col ? 'center' : 'start' }, [
      inst('NavItem', col ? { State: 'Default', Collapsed: 'True', Icon: { icon: 'help-circle' } } : { State: 'Default', Collapsed: 'False', Icon: { icon: 'help-circle' }, Label: 'Help & resources' }, { name: 'nav-help' }),
      inst('NavItem', col ? { State: 'Default', Collapsed: 'True', Icon: { icon: 'panel-left' } } : { State: 'Default', Collapsed: 'False', Icon: { icon: 'panel-left' }, Label: 'Collapse' }, { name: 'nav-collapse' }),
    ]);
    add(c, foot);
  }, { width: 1200, gapX: 40, desc: 'The shared sidebar. Swap the active item with the nested NavItem State. Menu items follow permissions in code.' });
  componentBlock(root, sidebar, { title: 'Sidebar', summary: 'Admin and Seller differ only in items. Collapsed (72 px) is used on the tablet order board.' });

  const topbar = makeSet('Topbar', { Workspace: ['Admin', 'Seller'] }, function (c, p) {
    const admin = p.Workspace === 'Admin';
    body(c, { dir: 'H', w: 1192, h: 'size/topbar', px: 'space/6', gap: 'space/4', align: 'center', fill: 'bg/surface', stroke: 'border/default', sides: ['bottom'] }, [
      frame({ name: 'breadcrumb', dir: 'H', gap: 'space/2', align: 'center' }, [text(admin ? 'Admin' : 'Seller Centre', 'Body/Default', 'text/muted'), icon('chevron-right', 'icon/muted', 14), text('Home', 'Body/Strong', 'text/primary', { name: 'crumb' })]),
      frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }),
      frame({ name: 'search', dir: 'H', w: 340, h: 38, px: 'space/2-5', gap: 'space/2-5', align: 'center', fill: 'bg/page', stroke: 'border/default', radius: 'radius/control' }, [
        icon('search', 'icon/muted', 16), text(admin ? 'Search sellers, orders, products…' : 'Search orders, offers, customers…', 'Body/Default', 'text/muted', { sizeH: 'FILL', truncate: true }),
        frame({ name: 'kbd', dir: 'H', px: 'space/1-5', py: 1, fill: 'bg/surface', stroke: 'border/control', radius: 5 }, [text('Ctrl K', 'Mono/Small', 'text/secondary')]),
      ]),
      frame({ name: 'market', dir: 'H', h: 32, pad: [0, 10, 0, 4], gap: 'space/2', align: 'center', stroke: 'border/default', radius: 'radius/pill' }, [
        frame({ name: 'AU', dir: 'H', h: 24, px: 'space/2', align: 'center', fill: 'text/primary', radius: 'radius/pill' }, [text('AU', 'Caption/Strong', 'bg/surface')]), text('AUD · Brisbane AEST', 'Body/Small', 'text/secondary'),
      ]),
      frame({ name: 'notifications', w: 38, h: 38 }, [icon('bell', 'icon/default', 20)]),
      rect({ name: 'divider', w: 1, h: 28, fill: 'border/default' }),
      frame({ name: 'user', dir: 'H', gap: 'space/2-5', align: 'center' }, [
        inst('IdentityTile', { Tone: 'Blue', Shape: 'Circle', Initials: admin ? 'LH' : 'YK' }), frame({ name: 'who', dir: 'V' }, [text(admin ? 'Layla Haddad' : 'Yusuf Karimi', 'Body/Strong'), text(admin ? 'Compliance lead' : 'Shop owner', 'Caption/Default', 'text/muted')]),
      ]),
    ]);
    const bell = c.findOne(function (n) { return n.name === 'notifications'; }); const bi = bell.children[0]; bi.x = 9; bi.y = 9;
    const badge = inst('CountBadge', { Tone: 'Critical', Count: '4' }, { name: 'unread' }); bell.appendChild(badge); badge.x = 20; badge.y = 2;
  }, { width: 1260, desc: 'Breadcrumb, command search (Ctrl K), market context, notifications and the user.', text: [{ prop: 'Crumb', node: 'crumb', def: 'Home' }] });
  componentBlock(root, topbar, { title: 'Topbar', summary: 'Market context (AU · AUD · AEST) is always visible because times and money depend on it.' });
  buildMobileNav(root, {});
  tag(root);
}

// ---------------------------------------------------------------- mobile navigation (release 1.5.0, D16)
// Below 760 px: both panels open the nav config as a drawer; the seller panel also gets a bottom tab bar.
// Built by "Build library" and added to an existing file by "Update library" (see 50_main.js).
function drawerRow(it, active) {
  const kids = [icon(it[2], active ? 'text/link' : 'icon/default', 20), text(it[1], active ? 'Touch/Strong' : 'Touch/Body', active ? 'text/link' : 'text/secondary', { name: 'label', sizeH: 'FILL', truncate: true })];
  if (it[3]) kids.push(inst('CountBadge', { Tone: it[3][0], Count: it[3][1] }, { name: 'count' }));
  if (it[4]) kids.push(icon('chevron-down', 'icon/muted', 16));
  const row = frame({ name: it[0], dir: 'H', h: 'size/control', px: 'space/3', gap: 'space/3', align: 'center', fill: active ? 'bg/selected' : null, radius: 'radius/control', sizeH: 'FILL' }, kids);
  return row;
}
const BAR_TABS = [['home', 'Home', 'home'], ['orders', 'Orders', 'clipboard'], ['catalogue', 'Catalogue', 'package'], ['more', 'More', 'more-horizontal']];
function buildMobileNav(root, have) {
  // have: names of sets that already exist in the file ("Update library" adds only what is missing).
  if (!have.NavDrawer) {
  const drawer = makeSet('NavDrawer', { Workspace: ['Admin', 'Seller'] }, function (c, p) {
    const seller = p.Workspace === 'Seller';
    withTouch(true, function () {
      body(c, { dir: 'V', w: 304, h: 780, fill: 'bg/surface', stroke: 'border/default', sides: ['right'], effect: 'Elevation/Floating' }, []);
      add(c, frame({ name: 'header', dir: 'H', h: 56, px: 'space/4', gap: 'space/2-5', align: 'center', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [
        brandMark(30),
        frame({ name: 'name', dir: 'V', sizeH: 'FILL' }, [text('MondaPac', 'Heading/H2'), text(seller ? 'Seller Centre' : 'Admin', 'Caption/Overline', 'text/muted')]),
        inst('IconButton', { Variant: 'Ghost', Size: 'Touch', State: 'Default', Icon: { icon: 'x' } }, { name: 'close' }),
      ]));
      if (seller) {
        add(c, frame({ name: 'shop-switcher', dir: 'H', pad: [12, 12, 4, 12], sizeH: 'FILL' }, [frame({ name: 'button', dir: 'H', h: 'size/control', px: 'space/2-5', gap: 'space/2', align: 'center', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [
          inst('IdentityTile', { Tone: 'Teal', Shape: 'Rounded', Initials: 'KF' }), text('Kuraby Fresh Halal Meats', 'Touch/Strong', 'text/primary', { sizeH: 'FILL', truncate: true }), icon('chevron-down', 'icon/muted', 16),
        ])]));
        const sw = c.children[1].children[0].children[0]; sw.resize(22, 22);
      }
      const list = frame({ name: 'items', dir: 'V', gap: 0, pad: 'space/3', sizeH: 'FILL', sizeV: 'FILL' });
      NAV[p.Workspace].forEach(function (it, i) {
        if (it[0] === 'g') { add(list, inst('NavGroupLabel', { Label: it[1] }, { name: 'group-' + it[1].toLowerCase(), sizeH: 'FILL' })); return; }
        if (it[0] === 'sub') {
          add(list, frame({ name: it[2], dir: 'H', h: 'size/control', pad: [0, 12, 0, 44], align: 'center', radius: 'radius/control', sizeH: 'FILL' }, [text(it[1], 'Touch/Body', 'text/secondary', { name: 'label', sizeH: 'FILL', truncate: true })]));
          return;
        }
        add(list, drawerRow(it, i === 0));
      });
      add(c, list);
      add(c, frame({ name: 'footer', dir: 'V', pad: 'space/3', stroke: 'border/default', sides: ['top'], sizeH: 'FILL' }, [drawerRow(['nav-help', 'Help & resources', 'help-circle'], false)]));
      touchMode(c);
    });
  }, { width: 760, desc: 'Phone navigation drawer (below 760 px, D16). Same nav groups and order as the Sidebar, so nothing is phone-only; Workspace picks Admin or Seller items. Opens from the inline-start edge (left in LTR, right in RTL), 304 wide, full height. Rows are 48 px (size/control under touch density). The header has the panel mark and a close icon button: aria-label "Close menu". Show it over a scrim (text/primary at 50%; the scrim belongs to the screen, not to this component): tapping the scrim, Esc or any link closes the drawer and focus returns to the menu button. While open the page behind is inert and the drawer is aria-modal with a focus trap. It renders only the already-filtered nav config. Seller opens it from the menu button or from More on the bottom tab bar.' });
  componentBlock(root, drawer, { title: 'NavDrawer', summary: 'Both panels open the same navigation as a drawer on phones. It is the Sidebar for widths below 760 px, in touch density.',
    use: ['Below 760 px, from the menu button in the 56 px topbar (Admin and Seller) or from More on the BottomTabBar (Seller).', 'Phone landscape wider than 760 px uses the 72 px rail instead; there is no rail below 760 px.'],
    props: ['Workspace: Admin or Seller', 'Close is an IconButton instance (Touch size)'],
    a11y: ['role="dialog" with aria-modal="true" and a label; the page behind is inert.', 'Focus moves into the drawer, is trapped, and returns to the menu button on close.', 'Esc, the scrim and any navigation close it.', 'Targets are 48 px; the active item uses aria-current="page".'],
    dont: ['Phone-only items: the drawer never has items the Sidebar lacks.', 'A disabled item for a missing permission: hidden items are removed from the config.'] });

  }

  if (!have.BottomTabBar) {
  const bar = makeSet('BottomTabBar', { Active: ['Home', 'Orders', 'Catalogue', 'More'], Tabs: ['4', '3'] }, function (c, p) {
    const tabs = BAR_TABS.filter(function (t) { return p.Tabs === '4' || t[0] !== 'orders'; });
    withTouch(true, function () {
      body(c, { dir: 'H', w: 360, h: 'size/bottom-bar', px: 'space/2', gap: 'space/1', align: 'center', fill: 'bg/surface', stroke: 'border/default', sides: ['top'] }, tabs.map(function (t) {
        const on = p.Active.toLowerCase() === t[0];
        const wrap = frame({ name: 'icon-wrap', w: 28, h: 24 });
        const ic = icon(t[2], on ? 'action/primary' : 'icon/default', 22); add(wrap, ic); ic.x = 3; ic.y = 1;
        if (t[0] === 'orders') { const b = inst('CountBadge', { Tone: 'Attention', Count: '9+' }, { name: 'orders-badge' }); add(wrap, b); b.x = 14; b.y = -6; }
        return frame({ name: 'tab-' + t[0], dir: 'V', h: 56, gap: 'space/0-5', align: 'center', justify: 'center', fill: on ? 'bg/selected' : null, radius: 'radius/control', sizeH: 'FILL' }, [wrap, text(t[1], on ? 'Caption/Strong' : 'Caption/Default', on ? 'text/link' : 'text/secondary', { name: 'label-' + t[0] })]);
      }));
      touchMode(c);
    });
  }, { width: 760, gapX: 40, skip: function (p) { return p.Tabs === '3' && p.Active === 'Orders'; }, desc: 'Seller phone bottom tab bar (below 760 px, D16): Home, Orders, Catalogue, More. 64 px high (size/bottom-bar), each tab an icon plus a visible label and a target of at least 48 px (56 here). Active picks the highlighted tab; Tabs=3 drops Orders (Home, Catalogue, More) for before Orders ships in phase 5. Orders shows the real count from the server-filtered badge source and caps at "9+" (the variants show the cap). Edge cases: (1) tabs come from the already-filtered nav config, so a missing permission means fewer tabs, never a disabled tab; the bar shows only when the user may see at least two of Home, Orders and Catalogue (before phase 5: Home and Catalogue), otherwise only the drawer is used. (2) The bar hides while the on-screen keyboard is open. (3) It respects the bottom safe area: the inset is added below the 64 px. (4) More opens the NavDrawer and shows as active while the drawer is open, and on any route that is not one of the tabs. (5) The limited seller shell has no bar and no drawer. (6) A future acting-as banner sits above the bar. Admin has no bottom bar. Each tab gets the Focus/Ring effect on keyboard focus.',
    bool: [{ prop: 'Show orders badge', node: 'orders-badge', def: true }] });
  componentBlock(root, bar, { title: 'BottomTabBar', summary: 'Seller only. One thumb tap between orders and stock beats opening the drawer each time. Admin keeps the drawer only.',
    use: ['Below 760 px in the seller panel, when the user may see at least two of Home, Orders and Catalogue.', 'Tabs=3 until the Orders module ships (phase 5): Home, Catalogue, More.'],
    props: ['Active: Home, Orders, Catalogue or More', 'Tabs: 4 or 3', 'Show orders badge (boolean)'],
    a11y: ['<nav> with aria-label; the active tab has aria-current="page"; More is a button that opens the drawer (aria-expanded).', 'Every tab has a visible label and a target of at least 48 px.', 'The badge is read as part of the label ("Orders, 9 or more waiting").', 'Hidden while the on-screen keyboard is open; respects the bottom safe area.'],
    dont: ['A disabled tab for a missing permission.', 'The bar on the limited seller shell, on Admin, or at 760 px and wider (the rail takes over).'] });
  }
}

// ---------------------------------------------------------------- review & detail
async function buildReview(page) {
  const root = pageShell(page, 'Review & detail', 'Building blocks of the review workspace: queue summary cards, extracted document fields, checks and the activity timeline.');
  const QC = { 'On track': ['Success', 'On track', 'Accent', '75', 'Oldest 2 days of 3'], Overdue: ['Critical', '1 overdue', 'Critical', '100', 'Oldest 2 days 4 h of 2 days'], 'Due today': ['Attention', 'Due today', 'Accent', '50', 'Oldest 4 h · due 5:00 pm'] };
  const qc = makeSet('QueueCard', { Tone: Object.keys(QC) }, function (c, p) {
    const q = QC[p.Tone];
    body(c, { dir: 'V', w: 264, pad: 18, gap: 'space/3', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [
      frame({ name: 'head', dir: 'H', gap: 'space/2', align: 'center', justify: 'between', sizeH: 'FILL' }, [text('Certifications', 'Body/Strong', 'text/secondary', { name: 'title' }), inst('Badge', { Tone: q[0], Leading: 'Dot', Label: q[1] })]),
      frame({ name: 'count-row', dir: 'H', gap: 'space/2', align: 'baseline' }, [text('4', 'Display/Hero', 'text/primary', { name: 'count' }), text('waiting', 'Body/Default', 'text/muted', { name: 'unit' })]),
      inst('Meter', { Tone: q[2], Value: q[3] }, { name: 'meter', sizeH: 'FILL' }),
      frame({ name: 'foot', dir: 'H', justify: 'between', sizeH: 'FILL' }, [text(q[4], 'Body/Small', 'text/muted', { name: 'oldest' }), text('Review', 'Body/Small Strong', 'text/link')]),
    ]);
  }, { width: 1000, desc: 'Summary of one review queue with its deadline meter.', text: [{ prop: 'Title', node: 'title', def: 'Certifications' }, { prop: 'Count', node: 'count', def: '4' }, { prop: 'Unit', node: 'unit', def: 'waiting' }, { prop: 'Oldest', node: 'oldest', def: 'Oldest 2 days of 3' }] });
  componentBlock(root, qc, { title: 'QueueCard', summary: 'The meter shows how much of the deadline the oldest item has used.' });

  const EF = { Matches: ['Matches ABN', 'Success', null], 'Check now': ['Check now', 'Info', 'action/primary'], 'To check': ['To check', 'Neutral', null] };
  const ef = makeSet('ExtractedField', { Status: Object.keys(EF) }, function (c, p) {
    const e = EF[p.Status];
    body(c, { dir: 'V', w: 260, pad: [10, 14, 10, 14], gap: 'space/1', fill: e[2] ? 'bg/row-selected' : 'bg/surface', stroke: e[2] ? 'action/primary' : 'border/row', sides: e[2] ? ['left'] : ['bottom'], strokeW: e[2] ? 3 : 1 }, [
      frame({ name: 'head', dir: 'H', justify: 'between', align: 'center', sizeH: 'FILL' }, [text('Holder', 'Caption/Default', 'text/muted', { name: 'label' }), inst('Badge', { Tone: e[1], Leading: 'None', Label: e[0] })]),
      text('Kuraby Fresh Halal Meats Pty Ltd', 'Body/Strong', 'text/primary', { name: 'value', sizeH: 'FILL' }),
    ]);
  }, { width: 1000, desc: 'A value read from an uploaded document and whether it matches our records.', text: [{ prop: 'Label', node: 'label', def: 'Holder' }, { prop: 'Value', node: 'value', def: 'Kuraby Fresh Halal Meats Pty Ltd' }] });
  componentBlock(root, ef, { title: 'ExtractedField', summary: '"Check now" marks the field the reviewer is working on; it matches the highlight on the document.' });

  const ck = makeSet('ChecklistItem', { State: ['Done', 'To do'] }, function (c, p) {
    const done = p.State === 'Done';
    const mark = frame({ name: 'mark', dir: 'H', w: 22, h: 22, align: 'center', justify: 'center', fill: done ? 'status/success/fg' : 'bg/surface', stroke: done ? null : 'border/input', strokeW: 1.5, radius: 'radius/pill' }, [done ? icon('check', 'text/on-accent', 13) : null]);
    body(c, { dir: 'H', w: 380, pad: [12, 18, 12, 18], gap: 'space/2-5', align: 'start', stroke: 'border/row', sides: ['top'] }, [
      mark,
      frame({ name: 'content', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [
        text('Certificate number confirmed with the issuer', 'Body/Default', 'text/primary', { name: 'title', sizeH: 'FILL' }),
        text(done ? 'Checked automatically · 29 Sep, 10:25 am' : 'Needs a person', 'Caption/Default', 'text/muted', { name: 'by' }),
        done ? null : frame({ name: 'actions', dir: 'H', gap: 'space/1-5' }, [inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Confirm' }), inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Flag a problem' })]),
      ]),
    ]);
  }, { width: 1000, desc: 'One verification check. Automatic checks show when they ran; manual checks offer Confirm or Flag a problem.', text: [{ prop: 'Title', node: 'title', def: 'Certificate number confirmed with the issuer' }, { prop: 'By', node: 'by', def: 'Needs a person' }] });
  componentBlock(root, ck, { title: 'ChecklistItem', summary: 'Approve stays disabled until every check is done.' });

  const TL = { Blue: ['action/primary', 'bg/selected'], Info: ['status/info/fg', 'status/info/bg'], Neutral: ['status/neutral/fg', 'status/neutral/bg'], Teal: ['cert/seller/fg', 'cert/seller/tile'] };
  const tl = makeSet('TimelineItem', { Tone: Object.keys(TL) }, function (c, p) {
    const t = TL[p.Tone];
    const d = frame({ name: 'dot', w: 32, h: 32 }); d.fills = [];
    add(d, ellipse({ name: 'halo', w: 18, fill: t[1], xy: [7, 7] })); add(d, ellipse({ name: 'core', w: 10, fill: t[0], xy: [11, 11] }));
    body(c, { dir: 'H', w: 640, gap: 'space/2-5', align: 'start', pad: [0, 0, 14, 0] }, [
      d,
      frame({ name: 'content', dir: 'V', gap: 'space/1', pad: [6, 0, 0, 0], sizeH: 'FILL' }, [
        frame({ name: 'line', dir: 'H', gap: 'space/1', wrap: true, sizeH: 'FILL' }, [text('Layla Haddad', 'Body/Strong', 'text/primary', { name: 'who' }), text('confirmed the name and ABN', 'Body/Default', 'text/secondary', { name: 'what' })]),
        frame({ name: 'quote', dir: 'H', pad: [8, 10, 8, 10], fill: 'bg/page', stroke: 'border/row', radius: 'radius/control', sizeH: 'FILL' }, [text('We received your renewal. The review is taking longer than usual this week.', 'Body/Small', 'text/secondary', { name: 'quote-text', sizeH: 'FILL' })]),
      ]),
      frame({ name: 'when-wrap', dir: 'H', pad: [7, 0, 0, 0] }, [text('Today, 2:12 pm', 'Caption/Default', 'text/muted', { name: 'when' })]),
    ]);
  }, { width: 1400, desc: 'One event in the activity timeline. Internal notes are never shown to sellers.', text: [{ prop: 'Who', node: 'who', def: 'Layla Haddad' }, { prop: 'What', node: 'what', def: 'confirmed the name and ABN' }, { prop: 'When', node: 'when', def: 'Today, 2:12 pm' }, { prop: 'Quote', node: 'quote-text', def: 'We received your renewal. The review is taking longer than usual this week.' }], bool: [{ prop: 'Show quote', node: 'quote', def: false }] });
  componentBlock(root, tl, { title: 'TimelineItem', summary: 'Tone shows who acted: Blue = staff, Info = MondaPac messages, Neutral = automatic, Teal = seller.' });
  tag(root);
}

// ---------------------------------------------------------------- board & delivery
async function buildBoard(page) {
  const root = pageShell(page, 'Board & delivery', 'Touch-density components for the seller order board, and the live delivery map.');
  const OC = { Urgent: ['MP-10482', 'Instant', 'ready by 2:50 pm', 'Waiting 9 min · accept now', 'status/critical/fg', 'Critical', '20', [['meat', 'Lamb cutlets', '500 g'], ['poultry', 'Chicken wings', '1 kg']], ['Accept', 'Item unavailable']],
    Normal: ['MP-10483', 'Instant', 'ready by 2:55 pm', 'Waiting 4 min', 'status/attention/fg', 'Attention', '25', [['poultry', 'Chicken thigh fillets', '1 kg']], ['Accept', 'Item unavailable']],
    Preparing: ['MP-10481', 'Instant', 'ready by 2:48 pm', 'Accepted 2:15 pm', 'text/muted', 'Attention', '18', [['meat', 'Lamb mince, 500 g', '× 2'], ['bakery', 'Turkish bread', '× 1']], ['Mark ready']],
    Ready: ['MP-10476', 'Courier', 'arriving 2:41 pm', 'Packed · 2 items · 1 bag', 'text/muted', 'Success', '11', [], ['Handed over', 'Print bag label']] };
  const card = makeSet('OrderCard', { Variant: Object.keys(OC) }, function (c, p) {
    const o = OC[p.Variant];
    withTouch(true, function () {
      body(c, { dir: 'V', w: 320, pad: 'space/3-5', gap: 'space/2-5', fill: 'bg/surface', stroke: p.Variant === 'Urgent' ? 'status/critical/solid' : 'border/default', radius: 'radius/card', effect: p.Variant === 'Urgent' ? 'Ring/Urgent' : null }, [
        frame({ name: 'head', dir: 'H', gap: 'space/2', align: 'start', justify: 'between', sizeH: 'FILL' }, [
          frame({ name: 'ids', dir: 'V', gap: 'space/1' }, [text(o[0], 'Mono/Touch', 'text/primary', { name: 'order' }), frame({ name: 'mode', dir: 'H', gap: 'space/1' }, [text(o[1], 'Touch/Strong', 'text/primary'), text('· ' + o[2], 'Touch/Body', 'text/secondary', { name: 'window' })]), text(o[3], 'Body/Small Strong', o[4], { name: 'status' })]),
          inst('CountdownRing', { Tone: o[5], Minutes: o[6] }, { name: 'countdown' }),
        ]),
        o[7].length ? frame({ name: 'lines', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, o[7].map(function (l) {
          return frame({ name: 'line', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [inst('ProductThumb', { Category: l[0].charAt(0).toUpperCase() + l[0].slice(1), Size: 'Sm' }), text(l[1], 'Touch/Body', 'text/secondary', { sizeH: 'FILL', truncate: true }), text(l[2], 'Touch/Strong', 'text/primary')]);
        })) : null,
        frame({ name: 'actions', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, o[8].map(function (a, i) { return inst('Button', { Variant: i === 0 ? 'Primary' : 'Secondary', Size: 'Touch', State: 'Default', Label: a }, { sizeH: 'FILL' }); })),
      ]);
      touchMode(c);
    });
  }, { width: 1440, desc: 'Order card on the tablet board. Touch density: 48 px actions, 14–15 px text.', text: [{ prop: 'Order', node: 'order', def: 'MP-10482' }] });
  // Window and status wording belongs to each variant (a text property would force one wording on all four).
  componentBlock(root, card, { title: 'OrderCard', summary: 'One decision per card. Urgent cards get a red border and ring; the countdown shows minutes left.', a11y: ['New orders are announced politely with an optional sound.', 'Actions are 48 px high.'] });

  const map = makeComponent('DeliveryMap', function (c) {
    c.layoutMode = 'NONE'; c.resize(400, 236); c.fills = [paint('map/land')]; c.clipsContent = true;
    const parts = [];
    parts.push(vector({ name: 'water', d: 'M 330 0 C 318 40 352 70 340 110 C 330 150 360 180 350 236 L 400 236 L 400 0 Z', fill: 'map/water', closed: true }));
    parts.push(vector({ name: 'river', d: 'M 0 64 C 40 60 70 92 110 84 C 150 76 160 50 196 62 C 226 72 206 102 232 108 C 262 114 268 86 296 92 C 318 97 326 84 338 80', stroke: 'map/water', strokeW: 7 }));
    ['M 0 140 L 400 120', 'M 150 0 L 210 236', 'M 60 236 L 300 20'].forEach(function (d) { parts.push(vector({ name: 'road', d: d, stroke: 'map/road', strokeW: 1.2 })); });
    parts.push(vector({ name: 'service-area', d: 'M 24 30 Q 200 -10 316 34 Q 336 140 300 222 Q 160 246 60 214 Q 12 130 24 30 Z', fill: 'action/primary', fillOpacity: 0.04, stroke: 'action/primary', strokeW: 1.2, dash: [4, 4], closed: true }));
    ['M 268 182 Q 250 150 262 128', 'M 226 168 Q 200 150 214 118', 'M 112 150 Q 150 130 196 112', 'M 252 206 Q 290 196 300 160', 'M 230 110 Q 250 104 272 118'].forEach(function (d) { parts.push(vector({ name: 'route', d: d, stroke: 'action/primary', strokeW: 1.4, dash: [3, 3] })); });
    [['Brisbane CBD', 178, 42], ['Woolloongabba', 170, 90], ['Holland Park', 272, 112], ['Moorooka', 140, 136], ['Darra', 88, 160], ['Sunnybank', 176, 174], ['Kuraby', 278, 194], ['Logan Central', 190, 214], ['Moreton Bay', 330, 12]].forEach(function (l) { parts.push(text(l[0], 'Mono/Small', 'text/muted', { xy: [l[1], l[2]] })); });
    [[268, 182], [226, 168], [112, 150], [252, 206], [230, 110], [196, 128], [262, 128]].forEach(function (pt) { parts.push(ellipse({ name: 'seller', w: 12, fill: 'map/seller-pin', stroke: 'bg/surface', strokeW: 2, strokeAlign: 'OUTSIDE', xy: [pt[0] - 6, pt[1] - 6] })); });
    [[258, 150], [206, 140], [156, 128], [290, 186], [251, 106]].forEach(function (pt) { parts.push(ellipse({ name: 'courier-halo', w: 18, fill: 'map/courier', fillOpacity: 0.16, xy: [pt[0] - 9, pt[1] - 9] })); parts.push(ellipse({ name: 'courier', w: 8, fill: 'map/courier', stroke: 'bg/surface', strokeW: 2, strokeAlign: 'OUTSIDE', xy: [pt[0] - 4, pt[1] - 4] })); });
    parts.forEach(function (n) { add(c, n); n.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; });
  }, { desc: 'Stylised Greater Brisbane map: service area, sellers with open orders, couriers. Production uses a map provider (D13) with these tokens; customer addresses are never shown.' });
  const mapWrap = frame({ name: 'DeliveryMap', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(mapWrap, map);
  componentBlock(root, mapWrap, { title: 'DeliveryMap', summary: 'Always shown with its legend and the three live numbers (in transit, average delivery, late now).', a11y: ['role="img" with a summary; pins have tooltips with the seller name.'] });
  tag(root);
}
