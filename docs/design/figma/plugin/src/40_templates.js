// ---------------------------------------------------------------- templates (full screens from instances)
function prop(setName, propName, value) { const o = {}; o[S.sets[setName].keys[propName]] = value; return o; }
function setNested(root, name, props) { const n = root.findOne(function (x) { return x.name === name; }); if (n) n.setProperties(props); return n; }
function sidebarFor(ws, active, collapsed) {
  const sb = inst('Sidebar', { Workspace: ws, Collapsed: collapsed ? 'True' : 'False' }, { name: 'Sidebar', sizeV: 'FILL' });
  if (active === 'none') setNested(sb, 'nav-home', { State: 'Default' }); // 1.8.0: a page with no Sidebar item of its own (Team & roles until the nav-config release): nothing is active
  else if (active && active !== 'nav-home') { setNested(sb, 'nav-home', { State: 'Default' }); setNested(sb, active, { State: 'Active' }); }
  return sb;
}
function screen(name, ws, active, crumb, contentKids, o) {
  o = o || {};
  const col = frame({ name: 'Column', dir: 'V', sizeH: 'FILL', sizeV: o.fixedH ? 'FILL' : null }, [
    inst('Topbar', { Workspace: ws, Crumb: crumb }, { name: 'Topbar', sizeH: 'FILL' }),
    frame({ name: 'Main', dir: 'V', gap: o.gap || 'space/6', pad: o.pad || [28, 32, 40, 32], sizeH: 'FILL', sizeV: o.fixedH ? 'FILL' : null }, contentKids),
  ]);
  const scr = frame({ name: name, dir: 'H', w: o.w || 1440, h: o.fixedH, fill: 'bg/page', clip: true }, [sidebarFor(ws, active, o.collapsed), col]);
  if (o.minH && !o.fixedH) scr.minHeight = o.minH; // 1.8.1: a page that hugs its content is never shorter than this, so the FILL Sidebar holds its own items
  tag(scr);
  return scr;
}
function card(name, kids, o) {
  o = o || {};
  return frame({ name: name, dir: 'V', gap: o.gap, pad: o.pad, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', clip: true, sizeH: o.sizeH === undefined ? 'FILL' : o.sizeH, w: o.w }, kids);
}
function header(title, action, extra) {
  const props = { Title: title, 'Show action': !!action }; if (action) props.Action = action;
  const h = inst('CardHeader', props, { sizeH: 'FILL' });
  return h;
}
function pageTitle(title, subtitle, right, badge) {
  return frame({ name: 'Page header', dir: 'H', align: 'end', justify: 'between', sizeH: 'FILL' }, [
    frame({ name: 'Title', dir: 'V', gap: 'space/1' }, [frame({ name: 'title-row', dir: 'H', gap: 'space/3', align: 'center' }, [text(title, 'Heading/H1'), badge || null]), subtitle ? text(subtitle, 'Body/Default', 'text/muted') : null]),
    frame({ name: 'Actions', dir: 'H', gap: 'space/2', align: 'center' }, right || []),
  ]);
}
function btn(label, variant, size, extra) { const p = { Variant: variant || 'Secondary', Size: size || 'Md', State: 'Default', Label: label }; Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; }); return inst('Button', p); }
function stat(label, value, delta, trend, positive, o) { return inst('StatTile', { Trend: trend || 'Sparkline', Tone: positive ? 'Positive' : 'Neutral', Label: label, Value: value, Delta: delta }, Object.assign({ sizeH: 'FILL' }, o || {})); }
function kpiStrip(tiles) {
  const kids = []; tiles.forEach(function (t, i) { if (i) kids.push(rect({ name: 'divider', w: 1, h: 10, fill: 'border/default', sizeV: 'FILL' })); kids.push(t); });
  return card('KPI strip', [frame({ name: 'tiles', dir: 'H', sizeH: 'FILL' }, kids)]);
}
function cellBox(node, w, o) {
  o = o || {};
  return frame({ name: 'cell', dir: o.dir || 'H', w: w === 'fill' ? undefined : w, h: o.h || 56, px: 'space/3', gap: o.gap || 'space/2-5', align: o.align || 'center', justify: o.justify, fill: o.fill || 'bg/surface', stroke: 'border/row', sides: ['bottom'], sizeH: w === 'fill' ? 'FILL' : null }, Array.isArray(node) ? node : [node]);
}
function kindTitle(kind, title) { return frame({ name: 'kind-title', dir: 'V', sizeH: 'FILL' }, [text(kind, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true }), text(title, 'Body/Strong', 'text/primary', { sizeH: 'FILL', truncate: true })]); }
function twoLine(a, b, styleA) { return frame({ name: 'two-line', dir: 'V', sizeH: 'FILL' }, [text(a, styleA || 'Body/Strong', 'text/primary', { sizeH: 'FILL', truncate: true }), text(b, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true })]); }
function headerRow(cols) {
  return frame({ name: 'Header row', dir: 'H', sizeH: 'FILL' }, cols.map(function (c) {
    const i = inst('TableCell', { Type: 'Header', State: 'Default', Text: c[0], Sorted: !!c[2] }, { name: 'th ' + c[0], sizeH: c[1] === 'fill' ? 'FILL' : null });
    if (c[1] !== 'fill') i.resize(c[1], i.height);
    return i;
  }));
}
function row(cells, sel, attention, h) {
  const fill = sel ? 'bg/row-selected' : (attention ? 'bg/row-attention' : 'bg/surface');
  return frame({ name: 'Row', dir: 'H', sizeH: 'FILL' }, cells.map(function (c) { return cellBox(c[0], c[1], Object.assign({ fill: fill, h: h }, c[2] || {})); }));
}
function checkbox(sel) { return inst('Checkbox', { Value: sel ? 'Checked' : 'Unchecked', State: 'Default' }); }
function thumbs(kinds) {
  return frame({ name: 'thumbs', dir: 'H', gap: -8 }, kinds.map(function (k) { return inst('ProductThumb', { Category: k, Size: 'Sm' }); }));
}

// ---- Admin · Home
function tplAdminHome() {
  const hero = card('Gross sales', [frame({ name: 'hero', dir: 'H', sizeH: 'FILL' }, [
    frame({ name: 'chart', dir: 'V', gap: 'space/1-5', pad: [18, 20, 14, 20], sizeH: 'FILL' }, [
      text('Gross sales today, incl. GST', 'Body/Strong', 'text/secondary'),
      frame({ name: 'value', dir: 'H', gap: 'space/2-5', align: 'center' }, [text('AUD 12,904.60', 'Display/Hero'), inst('Badge', { Tone: 'Success', Leading: 'Icon', Label: '8.2%', Icon: { icon: 'arrow-up' } }), text('vs AUD 11,926.58 at 2:30 pm yesterday', 'Body/Default', 'text/muted')]),
      inst('TrendChart', {}, { name: 'TrendChart' }),
    ]),
    frame({ name: 'kpis', dir: 'V', w: 280, fill: 'bg/subtle', stroke: 'border/default', sides: ['left'], sizeV: 'FILL' }, [
      stat('Orders', '184', '↑ 12 vs yesterday', 'Sparkline', true), stat('Average order', 'AUD 70.13', 'Incl. GST', 'Sparkline', false), stat('Sellers taking orders', '41 of 109', '38% of active sellers', 'Meter', false), stat('Dispatched on time', '97.6%', 'Target 95%', 'Sparkline', false),
    ]),
  ])]);
  const queues = frame({ name: 'Review queues', dir: 'H', gap: 'space/4', sizeH: 'FILL' }, [
    inst('QueueCard', { Tone: 'On track', Title: 'Seller applications', Count: '6', Oldest: 'Oldest 2 days of 3' }, { sizeH: 'FILL' }),
    inst('QueueCard', { Tone: 'Overdue', Title: 'Certifications', Count: '4' }, { sizeH: 'FILL' }),
    inst('QueueCard', { Tone: 'On track', Title: 'Product revisions', Count: '23', Oldest: 'Oldest 5 h of 1 day' }, { sizeH: 'FILL' }),
    inst('QueueCard', { Tone: 'Due today', Title: 'Refunds for admin', Count: '2', Unit: 'AUD 184.50 incl. GST' }, { sizeH: 'FILL' }),
  ]);
  const RQ = [['CE', 'Teal', 'Certification', 'Halal certificate, renewal', 'Kuraby Fresh Halal Meats', 'Waiting 2 days 4 h', 'Overdue'], ['RF', 'Amber', 'Refund · order MP-10311', 'Item damaged, AUD 64.50', 'Darra Asian & Halal Mart', 'Waiting 4 h', 'Due soon'],
    ['PR', 'Blue', 'Product revision · price +38%', 'Date & walnut loaf, 800 g', 'Holland Park Bakehouse', 'Waiting 5 h', 'Due soon'], ['MC', 'Teal', 'Manufacturer certificate', 'Covers 14 sealed products', 'Logan Family Grocer', 'Waiting 21 h', 'Upcoming'],
    ['SA', 'Purple', 'Seller application', 'New seller, ABN supplied', 'Sunnybank Spice Market', 'Waiting 1 day', 'Upcoming']];
  const DLL = { 'Overdue': 'Overdue 4 h', 'Due soon': 'Due 5:00 pm', 'Upcoming': 'Due 2 Oct' };
  const rq = card('Review queue', [header('Review queue', 'Open full queue'),
    frame({ name: 'tabs', dir: 'H', px: 'space/3-5', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [inst('Tab', { Selected: 'True', Label: 'All', Count: '35' }), inst('Tab', { Selected: 'False', Label: 'Sellers', Count: '6' }), inst('Tab', { Selected: 'False', Label: 'Certifications', Count: '4' }), inst('Tab', { Selected: 'False', Label: 'Products', Count: '23' }), inst('Tab', { Selected: 'False', Label: 'Refunds', Count: '2' })]),
    headerRow([['Item', 'fill'], ['Seller', 220], ['Deadline', 170], ['', 100]]),
  ].concat(RQ.map(function (r) {
    const d = inst('DeadlineBadge', { Tone: r[6] }); setNested(d, 'badge', prop('Badge', 'Label', DLL[r[6]]));
    return row([[[inst('IdentityTile', { Tone: r[1], Shape: 'Rounded', Initials: r[0] }), kindTitle(r[2], r[3])], 'fill'], [twoLine(r[4], r[5], 'Body/Default'), 220], [d, 170], [btn('Review', 'Secondary', 'Sm'), 100, { justify: 'end' }]], false, false, 64);
  })));
  const map = inst('DeliveryMap', {}, { name: 'DeliveryMap' }); map.resize(380, 224);
  const legend = frame({ name: 'legend', dir: 'H', gap: 'space/3-5', px: 'space/4-5', py: 'space/2-5', stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [
    frame({ name: 'k1', dir: 'H', gap: 'space/1-5', align: 'center' }, [ellipse({ w: 10, fill: 'map/seller-pin' }), text('Seller with open orders', 'Caption/Default', 'text/secondary')]),
    frame({ name: 'k2', dir: 'H', gap: 'space/1-5', align: 'center' }, [ellipse({ w: 8, fill: 'map/courier' }), text('Courier', 'Caption/Default', 'text/secondary')]),
    frame({ name: 'k3', dir: 'H', gap: 'space/1-5', align: 'center' }, [vector({ d: 'M 0 0 L 14 0', stroke: 'action/primary', strokeW: 1.5, dash: [3, 3] }), text('Service area', 'Caption/Default', 'text/secondary')]),
  ]);
  const stats = frame({ name: 'stats', dir: 'H', sizeH: 'FILL' }, [['In transit', '23'], ['Avg delivery', '34 min'], ['Late now', '2']].map(function (s2, i) {
    return frame({ name: s2[0], dir: 'V', gap: 'space/0-5', px: 'space/4-5', py: 'space/3', sizeH: 'FILL', stroke: i < 2 ? 'border/row' : null, sides: ['right'] }, [text(s2[0], 'Caption/Default', 'text/muted'), text(s2[1], 'Heading/H2', i === 2 ? 'status/attention/fg' : 'text/primary')]);
  }));
  const live = card('Live deliveries', [frame({ name: 'head', dir: 'H', pad: [16, 18, 12, 18], justify: 'between', align: 'center', sizeH: 'FILL' }, [text('Live deliveries', 'Heading/H2'), inst('Badge', { Tone: 'Success', Leading: 'Dot', Label: 'Live · 2:30 pm' })]), map, legend, stats], { sizeH: null, w: 380 });
  const split = frame({ name: 'Queue + map', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [rq, live]);

  const TOP = [['KF', 'Teal', 'Kuraby Fresh Halal Meats', '34 orders · Kuraby', 'AUD 2,146.90'], ['HP', 'Amber', 'Holland Park Bakehouse', '29 orders · Holland Park', 'AUD 1,388.20'], ['DA', 'Blue', 'Darra Asian & Halal Mart', '22 orders · Darra', 'AUD 1,204.75'], ['LF', 'Purple', 'Logan Family Grocer', '18 orders · Logan Central', 'AUD 986.40']];
  const top = card('Top sellers', [header('Top sellers today', 'All sellers'), headerRow([['Seller', 'fill'], ['Today', 100], ['Sales', 120]])].concat(TOP.map(function (t) {
    return row([[[inst('IdentityTile', { Tone: t[1], Shape: 'Rounded', Initials: t[0] }), twoLine(t[2], t[3])], 'fill'], [inst('Sparkline', { Tone: 'Accent' }), 100], [text(t[4], 'Body/Strong'), 120, { justify: 'end' }]]);
  })));
  const certs = card('Certificates', [header('Certificates', null), frame({ name: 'donut-row', dir: 'H', gap: 'space/3-5', pad: [0, 18, 12, 18], align: 'center' }, [inst('DonutProgress', {}), frame({ name: 't', dir: 'V' }, [text('92 of 109 hold a valid certificate', 'Body/Strong'), text('78 seller · 14 manufacturer only', 'Body/Small', 'text/muted')])]),
    frame({ name: 'list', dir: 'V', pad: [0, 18, 8, 18], sizeH: 'FILL' }, [text('Expiring in 30 days', 'Caption/Overline', 'text/muted')].concat([['Kuraby Fresh Halal Meats', 'Seller', '14 days', 'status/attention/fg'], ['Darra Asian & Halal Mart', 'Seller', '22 days', 'text/secondary'], ['Logan Family Grocer', 'Manufacturer', '29 days', 'text/secondary']].map(function (e) {
      return frame({ name: e[0], dir: 'H', justify: 'between', align: 'center', py: 'space/2-5', stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [frame({ name: 'l', dir: 'V', gap: 'space/1' }, [text(e[0], 'Body/Strong'), inst('CertChip', { Kind: e[1] })]), text(e[2], 'Body/Small Strong', e[3])]);
    })))], { sizeH: null, w: 340 });
  const payout = card('Payout', [header('Next payout batch', null), frame({ name: 'body', dir: 'V', gap: 'space/3', pad: [0, 18, 18, 18], sizeH: 'FILL' }, [
    frame({ name: 'amount', dir: 'V' }, [text('AUD 18,420.35', 'Heading/Amount'), text('12 sellers · Mon 6 Oct 2026', 'Body/Small', 'text/muted')]),
    inst('SplitBar', {}, { sizeH: 'FILL' }),
    frame({ name: 'dl', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [['To sellers', '18,420.35'], ['Commission', '3,251.65'], ['Invoiced sales', '21,672.00']].map(function (d) { return frame({ name: d[0], dir: 'H', justify: 'between', sizeH: 'FILL' }, [text(d[0], 'Body/Small', 'text/secondary'), text(d[1], 'Body/Small Strong')]); })),
    btn('Review batch', 'Secondary', 'Md'),
  ])], { sizeH: null, w: 320 });
  payout.children[1].children[3].layoutSizingHorizontal = 'FILL';
  const row3 = frame({ name: 'Row 3', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [top, certs, payout]);
  return screen('Admin · Home', 'Admin', 'nav-home', 'Home', [
    pageTitle('Good afternoon, Layla', 'Thursday 1 Oct 2026 · 2:30 pm Brisbane time (AEST, UTC+10) · 35 items waiting for review', [inst('SegmentedControl', {}), btn('View audit log'), btn('Start reviewing', 'Primary')]),
    hero, queues, split, row3,
  ]);
}

// ---- Admin · Sellers
function tplAdminSellers() {
  const S1 = [
    [true, 'KF', 'Teal', 'Kuraby Fresh Halal Meats', 'kuraby-fresh-halal · Kuraby QLD 4112', ['Success', 'Dot', 'Active'], [['Seller', '· exp 15 Oct']], 'Healthy', '412', '0.8%', '12 Mar 2026'],
    [true, 'SS', 'Purple', 'Sunnybank Spice Market', 'sunnybank-spice · Sunnybank QLD 4109', ['Info', 'Icon', 'Awaiting approval'], [], 'No data', '0', '—', '29 Sep 2026'],
    [false, 'DA', 'Blue', 'Darra Asian & Halal Mart', 'darra-asian-halal · Darra QLD 4076', ['Success', 'Dot', 'Active'], [['Seller', '· exp 23 Oct']], 'At risk', '268', '3.1%', '4 Apr 2026'],
    [false, 'LF', 'Neutral', 'Logan Family Grocer', 'logan-family-grocer · Logan Central QLD 4114', ['Success', 'Dot', 'Active'], [['Manufacturer']], 'Healthy', '190', '1.2%', '18 May 2026'],
    [false, 'HP', 'Amber', 'Holland Park Bakehouse', 'holland-park-bakehouse · Holland Park QLD 4121', ['Success', 'Dot', 'Active'], [['Seller'], ['Vegan']], 'Healthy', '356', '0.4%', '2 Feb 2026'],
    [false, 'SC', 'Neutral', 'Slacks Creek Butchers', 'slacks-creek-butchers · Slacks Creek QLD 4127', ['Critical', 'Icon', 'Suspended'], [['Revoked']], 'Unhealthy', '12', '9.8%', '20 Jan 2026'],
    [false, 'WO', 'Teal', 'Woolloongabba Organics', 'gabba-organics · Woolloongabba QLD 4102', ['Success', 'Dot', 'Active'], [['Self-declared']], 'Healthy', '97', '0.0%', '7 Jul 2026'],
  ];
  const tableCard = card('Seller list', [
    frame({ name: 'tabs', dir: 'H', px: 'space/3-5', align: 'center', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [inst('Tab', { Selected: 'True', Label: 'All', Count: '128' }), inst('Tab', { Selected: 'False', Label: 'Awaiting approval', Count: '6' }), inst('Tab', { Selected: 'False', Label: 'Active', Count: '109' }), inst('Tab', { Selected: 'False', Label: 'Certificate expiring', Count: '5' }), inst('Tab', { Selected: 'False', Label: 'Suspended', Count: '3' })]),
    frame({ name: 'filters', dir: 'H', gap: 'space/2', align: 'center', px: 'space/3-5', py: 'space/3', sizeH: 'FILL' }, [inst('Input', { State: 'Default', Value: 'Name, email or ABN' }), inst('FilterChip', { Type: 'Applied', Label: 'Service area: Greater Brisbane' }), inst('FilterChip', { Type: 'Add' }), frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Sort: Newest'), btn('Columns', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'columns' } })]),
    headerRow([['', 46], ['Seller', 'fill'], ['Status', 170], ['Certifications', 220], ['Health', 120], ['Orders, 30 days', 130], ['Cancelled', 96], ['Joined', 120, true], ['', 56]]),
  ].concat(S1.map(function (r) {
    const status = inst('Badge', { Tone: r[5][0], Leading: r[5][1], Label: r[5][2] }); if (r[5][1] === 'Icon') status.setProperties(prop('Badge', 'Icon', S.icons[r[5][0] === 'Critical' ? 'ban' : 'clock'].id));
    const certs = r[6].length ? r[6].map(function (c) { const i = inst('CertChip', { Kind: c[0] }); if (c[1]) i.setProperties(Object.assign(prop('CertChip', 'Note', c[1]), prop('CertChip', 'Show note', true))); return i; }) : [text('None yet', 'Body/Default', 'text/muted')];
    return row([[checkbox(r[0]), 46, { justify: 'center' }], [[inst('IdentityTile', { Tone: r[2], Shape: 'Rounded', Initials: r[1] }), twoLine(r[3], r[4])], 'fill'], [status, 170], [certs, 220, { gap: 'space/1-5' }], [inst('HealthIndicator', { State: r[7] }), 120],
      [[r[8] !== '0' ? inst('Sparkline', { Tone: r[7] === 'Unhealthy' ? 'Attention' : 'Accent' }) : null, text(r[8], 'Body/Default')], 130, { justify: 'end' }], [text(r[9], r[9] === '9.8%' || r[9] === '3.1%' ? 'Body/Strong' : 'Body/Default', r[9] === '9.8%' ? 'status/critical/fg' : (r[9] === '3.1%' ? 'status/attention/fg' : 'text/primary')), 96, { justify: 'end' }],
      [text(r[10], 'Body/Default'), 120], [inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default' }), 56, { justify: 'center' }]], r[0]);
  })).concat([inst('Pagination', { Range: '1–25 of 128' }, { sizeH: 'FILL' })]));
  const bulk = inst('BulkActionBar', {}, { name: 'BulkActionBar' });
  return screen('Admin · Sellers', 'Admin', 'nav-sellers', 'Sellers', [
    pageTitle('Sellers', '128 sellers in the Australia market', [btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), btn('Add seller', 'Primary', 'Md', { 'Leading icon': true, Icon: { icon: 'plus' } })]),
    kpiStrip([stat('Active sellers', '109', '↑ 4 this month', 'Sparkline', true), stat('Sales, 30 days', 'AUD 412,860', '↑ 9.4% vs previous 30 days', 'Sparkline', true), stat('Dispatched on time', '96.1%', 'Target 95%', 'Sparkline', false), stat('Need attention', '12', '5 expiring · 4 at risk · 3 suspended', 'Sparkline', false)]),
    tableCard, frame({ name: 'bulk-wrap', dir: 'H', justify: 'center', sizeH: 'FILL' }, [bulk]),
  ], { gap: 'space/5' });
}

// ---- Admin · Certificate review
function tplAdminReview() {
  const facts = card('Facts', [frame({ name: 'facts', dir: 'H', py: 'space/3-5', sizeH: 'FILL' }, [['Type', 'Halal · third-party certificate'], ['Issuer', '[Issuer name]'], ['Valid', '10 Sep 2026 to 9 Sep 2027'], ['Offers covered', '38'], ['Assigned to', 'Layla Haddad'], ['Decision due', '1 Oct, 10:24 am']].map(function (f, i) {
    return frame({ name: f[0], dir: 'V', gap: 'space/1', px: 'space/5', stroke: i ? 'border/default' : null, sides: ['left'] }, [text(f[0], 'Body/Small', 'text/muted'), text(f[1], 'Body/Strong', i === 5 ? 'status/critical/fg' : 'text/primary')]);
  }))]);
  const paper = frame({ name: 'Document page', w: 360, h: 456, fill: 'bg/surface', radius: 4, effect: 'Elevation/Document' });
  add(paper, ellipse({ name: 'seal', w: 52, fill: 'cert/seller/bg', stroke: 'cert/seller/fg', strokeW: 1.6, xy: [154, 36] }));
  add(paper, text('[ ISSUER NAME ]', 'Mono/Small', 'text/muted', { xy: [136, 102] }));
  add(paper, text('HALAL CERTIFICATE', 'Heading/H2', 'cert/seller/fg', { xy: [104, 120] }));
  [['Certificate no.', '[Certificate number]', 'action/primary'], ['Holder', 'Kuraby Fresh Halal Meats Pty Ltd', 'cert/seller/fg'], ['Premises', 'Kuraby QLD 4112'], ['Scope', 'Fresh meat and poultry'], ['Valid', '10 Sep 2026 to 9 Sep 2027']].forEach(function (r2, i) {
    const y = 190 + i * 26;
    if (r2[2]) add(paper, rect({ name: 'highlight', w: 196, h: 22, fill: r2[2] === 'action/primary' ? 'bg/selected' : 'cert/seller/bg', stroke: r2[2], strokeW: 1.2, radius: 3, xy: [120, y - 3] }));
    add(paper, text(r2[0], 'Caption/Default', 'text/muted', { xy: [40, y] })); add(paper, text(r2[1], 'Caption/Strong', 'text/primary', { xy: [126, y] }));
    add(paper, rect({ name: 'rule', w: 280, h: 1, fill: 'border/row', xy: [40, y + 20] }));
  });
  add(paper, text('Page 1 of 2 · sample preview', 'Mono/Small', 'text/muted', { xy: [116, 424] }));
  const viewer = frame({ name: 'viewer', dir: 'H', justify: 'center', pad: [24, 16, 24, 16], fill: 'bg/muted', sizeH: 'FILL', sizeV: 'FILL' }, [paper]);
  const fields = frame({ name: 'Read from document', dir: 'V', w: 260, stroke: 'border/default', sides: ['left'], sizeV: 'FILL' }, [
    frame({ name: 'h', dir: 'H', pad: [12, 14, 8, 14] }, [text('Read from document', 'Caption/Overline', 'text/muted')]),
    inst('ExtractedField', { Status: 'Check now', Label: 'Certificate no.', Value: '[Certificate number]' }, { sizeH: 'FILL' }),
    inst('ExtractedField', { Status: 'Matches', Label: 'Holder', Value: 'Kuraby Fresh Halal Meats Pty Ltd' }, { sizeH: 'FILL' }),
    inst('ExtractedField', { Status: 'Matches', Label: 'Issuer', Value: '[Issuer name]' }, { sizeH: 'FILL' }),
    inst('ExtractedField', { Status: 'To check', Label: 'Scope', Value: 'Fresh meat and poultry, one premises in Kuraby QLD 4112' }, { sizeH: 'FILL' }),
    inst('ExtractedField', { Status: 'Matches', Label: 'Valid', Value: '10 Sep 2026 to 9 Sep 2027' }, { sizeH: 'FILL' }),
  ]);
  const doc = card('Submitted document', [
    frame({ name: 'toolbar', dir: 'H', gap: 'space/2-5', align: 'center', pad: [10, 14, 10, 14], stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [icon('file', 'icon/default', 18), text('halal-certificate-2026.pdf', 'Body/Strong'), text('2 pages · 412 KB · stored locked', 'Body/Small', 'text/muted'), frame({ name: 'sp', dir: 'H', h: 1, sizeH: 'FILL' }), inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: 'Default', Icon: { icon: 'zoom-out' } }), text('100%', 'Body/Small'), inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: 'Default', Icon: { icon: 'zoom-in' } }), text('Open original', 'Body/Strong', 'text/link')]),
    frame({ name: 'doc-body', dir: 'H', sizeH: 'FILL' }, [viewer, fields]),
  ]);
  const activity = card('Activity', [header('Activity', null), frame({ name: 'events', dir: 'V', pad: [0, 18, 6, 18], sizeH: 'FILL' }, [
    inst('TimelineItem', { Tone: 'Blue', Who: 'Layla Haddad', What: 'confirmed the name and ABN', When: 'Today, 2:12 pm' }, { sizeH: 'FILL' }),
    inst('TimelineItem', { Tone: 'Info', Who: 'MondaPac Support', What: 'messaged the seller', When: 'Today, 11:05 am', 'Show quote': true }, { sizeH: 'FILL' }),
    inst('TimelineItem', { Tone: 'Blue', Who: 'Layla Haddad', What: 'was assigned this review', When: 'Today, 9:02 am' }, { sizeH: 'FILL' }),
    inst('TimelineItem', { Tone: 'Neutral', Who: 'Automatic checks', What: 'passed: issuer registry, dates', When: '29 Sep, 10:25 am' }, { sizeH: 'FILL' }),
    inst('TimelineItem', { Tone: 'Teal', Who: 'Yusuf Karimi', What: 'submitted the renewal', When: '29 Sep, 10:24 am' }, { sizeH: 'FILL' }),
  ])]);
  const checks = card('Checks', [frame({ name: 'h', dir: 'V', gap: 'space/2-5', pad: [16, 18, 12, 18], sizeH: 'FILL' }, [frame({ name: 't', dir: 'H', justify: 'between', sizeH: 'FILL' }, [text('Checks', 'Heading/H2'), text('3 of 5 done', 'Body/Small', 'text/muted')]), frame({ name: 'pips', dir: 'H', gap: 3, sizeH: 'FILL' }, [0, 1, 2, 3, 4].map(function (i) { return rect({ name: 'pip', w: 40, h: 6, radius: 3, fill: i < 3 ? 'status/success/fg' : 'border/default', sizeH: 'FILL' }); }))]),
    inst('ChecklistItem', { State: 'Done', Title: 'Issuer is in the approved registry for Australia', By: 'Checked automatically · 29 Sep, 10:25 am' }, { sizeH: 'FILL' }),
    inst('ChecklistItem', { State: 'Done', Title: 'Dates are valid and expiry is after today', By: 'Checked automatically · 29 Sep, 10:25 am' }, { sizeH: 'FILL' }),
    inst('ChecklistItem', { State: 'Done', Title: 'Name matches the registered business name and ABN', By: 'Confirmed by Layla Haddad · today, 2:12 pm' }, { sizeH: 'FILL' }),
    inst('ChecklistItem', { State: 'To do', Title: 'Certificate number confirmed with the issuer' }, { sizeH: 'FILL' }),
    inst('ChecklistItem', { State: 'To do', Title: 'Scope covers what this seller sells (fresh meat, poultry)' }, { sizeH: 'FILL' }),
  ]);
  const decision = card('Decision', [frame({ name: 'b', dir: 'V', gap: 'space/3', pad: [16, 18, 16, 18], sizeH: 'FILL' }, [
    text('Decision', 'Heading/H2'),
    frame({ name: 'impact', dir: 'V', gap: 'space/2', pad: 12, fill: 'status/attention/surface', stroke: 'status/attention/border', radius: 'radius/control', sizeH: 'FILL' }, [text('If approved, the Halal label stays on this seller’s 38 offers after 15 Oct 2026. If no decision is made, the label is removed when the current certificate ends.', 'Body/Small', 'text/secondary', { sizeH: 'FILL' }), frame({ name: 'm', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [inst('Meter', { Tone: 'Attention', Value: '50' }, { sizeH: 'FILL' }), text('14 days left', 'Caption/Strong', 'status/attention/fg')])]),
    frame({ name: 'buttons', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [btn('Approve', 'Primary', 'Md', { State: 'Disabled' }), btn('Reject…', 'Destructive', 'Md')]),
    text('Ask seller for more information', 'Body/Strong', 'text/link'),
    text('Complete the 2 remaining checks to approve. Rejecting needs a reason the seller will see.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
  ])]);
  decision.children[0].children[2].children.forEach(function (b) { b.layoutSizingHorizontal = 'FILL'; });
  const left = frame({ name: 'Left', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [doc, activity]);
  const right = frame({ name: 'Right', dir: 'V', gap: 'space/4', w: 380 }, [checks, decision]);
  return screen('Admin · Certificate review', 'Admin', 'nav-review', 'Review queue', [
    frame({ name: 'Header', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [text('‹ Review queue', 'Body/Strong', 'text/link'), pageTitle('Halal certificate renewal', 'Kuraby Fresh Halal Meats · submitted 29 Sep 2026, 10:24 am AEST by Yusuf Karimi (Shop owner)', [text('2 of 4 certifications', 'Body/Small', 'text/muted'), inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: 'Default', Icon: { icon: 'chevron-left' } }), inst('IconButton', { Variant: 'Secondary', Size: 'Md', State: 'Default', Icon: { icon: 'chevron-right' } })],
      frame({ name: 'badges', dir: 'H', gap: 'space/2' }, [inst('StatusBadge', { Status: 'In review' }), inst('Badge', { Tone: 'Critical', Leading: 'Icon', Label: 'Deadline passed 4 h ago', Icon: { icon: 'alert-circle' } })]))]),
    facts, frame({ name: 'Body', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [left, right]),
  ], { gap: 'space/5', pad: [24, 32, 40, 32] });
}
