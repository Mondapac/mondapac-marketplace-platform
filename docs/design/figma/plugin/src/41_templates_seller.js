// ---- Seller · Home
function stageCard(title, count, note, n, token, urgent) {
  return frame({ name: title, dir: 'V', gap: 'space/2-5', pad: 18, fill: 'bg/surface', stroke: urgent ? 'status/attention/border' : 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
    frame({ name: 'h', dir: 'H', justify: 'between', align: 'center', sizeH: 'FILL' }, [text(title, 'Body/Strong', 'text/secondary'), urgent ? inst('Badge', { Tone: 'Attention', Leading: 'None', Label: 'Accept now' }) : null]),
    text(count, 'Display/Hero'),
    frame({ name: 'pips', dir: 'H', gap: 3, wrap: true, rowGap: 3, sizeH: 'FILL' }, Array.apply(null, Array(Math.min(n, 12))).map(function () { return rect({ name: 'pip', w: 20, h: 6, radius: 3, fill: token }); })),
    text(note, 'Body/Small', 'text/muted'),
  ]);
}
function tplSellerHome() {
  const stages = frame({ name: 'Order stages', dir: 'H', gap: 'space/4', sizeH: 'FILL' }, [
    stageCard('Needs action', '3', 'Oldest waiting 9 min', 3, 'status/attention/solid', true), stageCard('Preparing', '5', 'Next ready by 2:48 pm', 5, 'action/primary'),
    stageCard('Ready for pickup', '2', 'Courier arriving 2:41 pm', 2, 'cert/seller/fg'), stageCard('Scheduled for tomorrow', '11', 'Next-day delivery, 9 am to 1 pm', 11, 'border/input'),
  ]);
  const ACC = [['MP-10482', 'Waiting 9 min', 'status/critical/fg', ['Meat', 'Meat', 'Poultry'], '3 items', 'Lamb cutlets, beef mince, chicken wings', 'Instant', 'By 2:50 pm · 20 min left', 'AUD 86.40'],
    ['MP-10483', 'Waiting 4 min', 'status/attention/fg', ['Poultry'], '1 item', 'Chicken thigh fillets, 1 kg', 'Instant', 'By 2:55 pm · 25 min left', 'AUD 32.90'],
    ['MP-10479', 'Accept by 6 pm', 'text/muted', ['Meat', 'Poultry', 'Pantry'], '5 items', 'Lamb leg, chicken breast, sausages, basmati rice, BBQ charcoal', 'Next day', 'Fri 2 Oct, 9 to 11 am', 'AUD 142.75']];
  const accept = card('Orders needing action', [header('Orders needing action', 'Open order board'), headerRow([['Order', 136], ['Items', 'fill'], ['Delivery', 180], ['Total', 100], ['', 100]])].concat(ACC.map(function (r) {
    return row([[frame({ name: 'o', dir: 'V' }, [text(r[0], 'Mono/Default'), text(r[1], 'Caption/Strong', r[2])]), 136], [[thumbs(r[3]), twoLine(r[4], r[5])], 'fill'],
      [frame({ name: 'd', dir: 'V', gap: 'space/1' }, [inst('Badge', { Tone: r[6] === 'Instant' ? 'Attention' : 'Neutral', Leading: 'None', Label: r[6] }), text(r[7], 'Caption/Default', 'text/muted')]), 180],
      [text(r[8], 'Body/Default'), 100, { justify: 'end' }], [btn('Accept', 'Primary', 'Sm'), 100, { justify: 'end' }]], false, false, 64);
  })));
  const PREP = [['MP-10481', 'Lamb mince ×2, beef rump steak, Turkish bread', '2:48 pm', '18 min left', 'Attention', '75'], ['MP-10480', 'Chicken drumsticks 1 kg, pita bread', '2:52 pm', '22 min left', 'Accent', '50'], ['MP-10478', 'Beef brisket 1.5 kg', '3:05 pm', '35 min left', 'Accent', '25'], ['MP-10477', 'Mixed grill pack, garlic sauce', '3:10 pm', '40 min left', 'Accent', '25'], ['MP-10475', 'Goat curry cuts 1 kg, basmati rice 5 kg', '3:20 pm', '50 min left', 'Accent', '0']];
  const prep = card('Preparing now', [frame({ name: 'h', dir: 'H', pad: [16, 18, 12, 18], justify: 'between', align: 'center', sizeH: 'FILL' }, [text('Preparing now', 'Heading/H2'), text('5 orders · courier pickups every 10 min', 'Body/Small', 'text/muted')])].concat(PREP.map(function (p) {
    return frame({ name: p[0], dir: 'H', gap: 'space/3-5', align: 'center', pad: [11, 18, 11, 18], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [text(p[0], 'Mono/Default', 'text/primary'), text(p[1], 'Body/Default', 'text/secondary', { sizeH: 'FILL', truncate: true }),
      frame({ name: 'time', dir: 'V', gap: 'space/1', w: 190 }, [frame({ name: 't', dir: 'H', justify: 'between', sizeH: 'FILL' }, [text('Ready by ' + p[2], 'Body/Small', 'text/muted'), text(p[3], 'Body/Small Strong', p[4] === 'Attention' ? 'status/attention/fg' : 'status/info/fg')]), inst('Meter', { Tone: p[4], Value: p[5] }, { sizeH: 'FILL' })])]);
  })));
  const msgs = card('Messages', [header('Messages', 'All messages')].concat([['AR', 'Amber', 'Amina R.', 'MP-10479', 'Could you cut the lamb leg into 4 pieces please? Thank you!', '2:21 pm', true], ['MP', 'Blue', 'MondaPac Support', 'Certificate', 'We received your renewal. The review is taking longer than usual this week.', '11:05 am', true], ['CL', 'Teal', 'Chris L.', 'MP-10470', 'Arrived cold and well packed. Will order again next week.', 'Yesterday', false]].map(function (m) {
    return frame({ name: m[2], dir: 'H', gap: 'space/3', align: 'center', pad: [11, 18, 11, 18], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [inst('IdentityTile', { Tone: m[1], Shape: 'Circle', Initials: m[0] }), frame({ name: 'c', dir: 'V', sizeH: 'FILL' }, [frame({ name: 'w', dir: 'H', gap: 'space/2' }, [text(m[2], 'Body/Strong'), text(m[3], 'Caption/Default', 'text/muted')]), text(m[4], 'Body/Default', 'text/secondary', { sizeH: 'FILL', truncate: true })]), text(m[5], 'Caption/Default', 'text/muted'), m[6] ? ellipse({ name: 'unread', w: 8, fill: 'action/primary' }) : null]);
  })));
  const payout = card('Next payout', [header('Next payout', null), frame({ name: 'b', dir: 'V', gap: 'space/3', pad: [0, 18, 16, 18], sizeH: 'FILL' }, [
    frame({ name: 'a', dir: 'V' }, [text('AUD 2,318.40', 'Heading/Amount'), text('Mon 6 Oct · to account ending 4821', 'Body/Small', 'text/muted')]), inst('WeeklyBars', {}),
    frame({ name: 'dl', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [['Invoiced sales', '2,634.55'], ['Commission', '−316.15']].map(function (d) { return frame({ name: d[0], dir: 'H', justify: 'between', sizeH: 'FILL' }, [text(d[0], 'Body/Small', 'text/secondary'), text(d[1], 'Body/Small Strong')]); })),
    text('See transactions', 'Body/Strong', 'text/link'),
  ])], { sizeH: 'FILL' });
  const low = card('Low stock', [header('Low stock', 'Update inventory')].concat([['Meat', 'Lamb shoulder, bone-in (kg)', '4 left · sells about 6 a day', 'status/critical/fg'], ['Poultry', 'Chicken thigh fillets, 1 kg', '6 left', 'status/attention/fg'], ['Meat', 'Beef mince, 500 g', '8 left', 'status/attention/fg']].map(function (l) {
    return frame({ name: l[1], dir: 'H', gap: 'space/2-5', align: 'center', pad: [10, 18, 10, 18], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [inst('ProductThumb', { Category: l[0], Size: 'Md' }), frame({ name: 'c', dir: 'V', sizeH: 'FILL' }, [text(l[1], 'Body/Default', 'text/primary', { sizeH: 'FILL', truncate: true }), text(l[2], 'Body/Small Strong', l[3])]), btn('Restock', 'Secondary', 'Sm')]);
  })));
  const certs = card('Certifications', [header('Certifications', null), frame({ name: 'b', dir: 'V', gap: 'space/3', pad: [0, 18, 16, 18], sizeH: 'FILL' }, [
    frame({ name: 'current', dir: 'H', gap: 'space/3', align: 'center', pad: 12, fill: 'cert/seller/bg', stroke: 'cert/seller/border', radius: 'radius/control', sizeH: 'FILL' }, [frame({ name: 'ok', dir: 'H', w: 36, h: 36, align: 'center', justify: 'center', fill: 'cert/seller/fg', radius: 'radius/pill' }, [icon('check', 'text/on-accent', 18)]), frame({ name: 't', dir: 'V' }, [text('Halal · seller certificate', 'Body/Strong', 'cert/seller/fg'), text('Valid until 15 Oct 2026 · 38 offers', 'Body/Small', 'text/secondary')])]),
    text('Renewal progress', 'Body/Small Strong', 'text/secondary'),
    frame({ name: 'steps', dir: 'H', gap: 'space/1', sizeH: 'FILL' }, [['Submitted', 'cert/seller/fg', 'cert/seller/fg'], ['Auto checks', 'cert/seller/fg', 'cert/seller/fg'], ['In review', 'action/primary', 'text/link'], ['Decision', 'border/default', 'text/muted']].map(function (st) {
      return frame({ name: st[0], dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [rect({ name: 'bar', w: 60, h: 5, radius: 3, fill: st[1], sizeH: 'FILL' }), text(st[0], 'Caption/Strong', st[2])]);
    })),
  ])]);
  const left = frame({ name: 'Left', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [accept, prep, msgs]);
  const right = frame({ name: 'Right', dir: 'V', gap: 'space/4', w: 340 }, [payout, low, certs]);
  return screen('Seller · Home', 'Seller', 'nav-home', 'Home', [
    pageTitle('Good afternoon, Yusuf', 'Thursday 1 Oct 2026 · 2:30 pm AEST', [btn('View shop'), btn('Add offer', 'Primary')], inst('Badge', { Tone: 'Success', Leading: 'Dot', Label: 'Open · taking orders until 8:00 pm' })),
    inst('InfoBanner', { Tone: 'Info' }, { sizeH: 'FILL' }), stages,
    kpiStrip([stat('Sales today', 'AUD 2,146.90', '↑ 11% vs last Thu', 'Sparkline', true), stat('Orders today', '34', '↑ 4 vs last Thu', 'Sparkline', true), stat('Average prep time', '14 min', 'Target under 20 min', 'Sparkline', false), stat('Dispatched on time', '98%', 'Target 95% or more', 'Sparkline', false)]),
    frame({ name: 'Body', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [left, right]),
  ]);
}

// ---- Seller · Orders
function tplSellerOrders() {
  const O = [
    [true, 'MP-10483', '2:26 pm', 'Instant', 'Ready by 2:55 pm · 25 min', ['Poultry'], '1 item', 'AUD 32.90', 'Needs action', 'Waiting 4 min', '—'],
    [true, 'MP-10482', '2:21 pm', 'Instant', 'Ready by 2:50 pm · 20 min', ['Meat', 'Meat', 'Poultry'], '3 items', 'AUD 86.40', 'Needs action', 'Waiting 9 min', '—'],
    [false, 'MP-10481', '2:14 pm', 'Instant', 'Ready by 2:48 pm · 18 min', ['Meat', 'Meat', 'Bakery'], '4 items', 'AUD 58.20', 'Preparing', 'Accepted 2:15 pm', '—'],
    [false, 'MP-10479', '2:02 pm', 'Next day', 'Fri 2 Oct, 9 to 11 am', ['Meat', 'Poultry', 'Pantry'], '5 items', 'AUD 142.75', 'Needs action', 'Accept by 6:00 pm', '—'],
    [false, 'MP-10476', '1:47 pm', 'Instant', 'Ready by 2:15 pm', ['Poultry', 'Meat'], '2 items', 'AUD 41.00', 'Ready for pickup', 'Courier arriving 2:41 pm', '—'],
    [false, 'MP-10470', '1:05 pm', 'Instant', 'Delivered 1:52 pm', ['Meat', 'Bakery', 'Pantry'], '6 items', 'AUD 118.30', 'Delivered', 'Invoice MPI-2291', 'Pending'],
    [false, 'MP-10466', '12:40 pm', 'Instant', 'Not delivered', ['Poultry', 'Other'], '2 items', 'AUD 27.80', 'Cancelled', 'Reason: item unavailable', 'Not payable'],
    [false, 'MP-10461', '11:58 am', 'Next day', 'Fri 2 Oct, 11 am to 1 pm', ['Meat', 'Pantry'], '3 items', 'AUD 64.10', 'Scheduled', 'Pick list at 8:00 am', '—'],
  ];
  const tableCard = card('Order list', [
    frame({ name: 'tabs', dir: 'H', px: 'space/3-5', align: 'center', stroke: 'border/default', sides: ['bottom'], sizeH: 'FILL' }, [['All', '34', 'True'], ['Needs action', '3'], ['Preparing', '5'], ['Ready', '2'], ['Scheduled', '11'], ['Completed', '12']].map(function (t) { return inst('Tab', { Selected: t[2] || 'False', Label: t[0], Count: t[1] }); })),
    frame({ name: 'filters', dir: 'H', gap: 'space/2', align: 'center', px: 'space/3-5', py: 'space/3', sizeH: 'FILL' }, [inst('Input', { State: 'Default', Value: 'Order number or product' }), inst('FilterChip', { Type: 'Applied', Label: 'Placed: Today' }), inst('FilterChip', { Type: 'Add' }), frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), btn('Sort: Newest'), btn('Columns', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'columns' } })]),
    headerRow([['', 46], ['Order', 140, true], ['Delivery', 'fill'], ['Items', 150], ['Total', 110], ['Status', 220], ['Payout', 110], ['', 56]]),
  ].concat(O.map(function (r) {
    const mode = frame({ name: 'mode', dir: 'H', w: 28, h: 28, align: 'center', justify: 'center', fill: r[3] === 'Instant' ? 'status/attention/bg' : 'status/neutral/bg', radius: 'radius/control' }, [icon(r[3] === 'Instant' ? 'zap' : 'calendar', r[3] === 'Instant' ? 'status/attention/fg' : 'status/neutral/fg', 14)]);
    const win = r[4].indexOf('min') > 0;
    return row([[checkbox(r[0]), 46, { justify: 'center' }], [frame({ name: 'o', dir: 'V' }, [text(r[1], 'Mono/Default'), text('Placed ' + r[2], 'Caption/Default', 'text/muted')]), 140],
      [[mode, frame({ name: 'w', dir: 'V', sizeH: 'FILL' }, [text(r[3], 'Body/Strong'), text(r[4], win ? 'Caption/Strong' : 'Caption/Default', win ? 'status/attention/fg' : 'text/muted')])], 'fill'],
      [[thumbs(r[5]), text(r[6], 'Body/Small', 'text/secondary')], 150], [text(r[7], 'Body/Default'), 110, { justify: 'end' }],
      [frame({ name: 's', dir: 'V', gap: 'space/1' }, [inst('StatusBadge', { Status: r[8] }), text(r[9], 'Caption/Default', 'text/muted')]), 220], [text(r[10], 'Body/Default', 'text/secondary'), 110],
      [inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default' }), 56, { justify: 'center' }]], r[0], r[8] === 'Needs action', 64);
  })).concat([inst('Pagination', { Range: '1–8 of 34 today' }, { sizeH: 'FILL' })]));
  const bulk = inst('BulkActionBar', {}, { name: 'BulkActionBar' });
  setNested(bulk, 'action-1', prop('Button', 'Label', 'Print packing slips'));
  setNested(bulk, 'action-2', prop('Button', 'Label', 'Message customers'));
  const a3 = bulk.findOne(function (x) { return x.name === 'action-3'; }); a3.setProperties({ Variant: 'Primary' }); a3.setProperties(prop('Button', 'Label', 'Accept 2 orders'));
  const today = frame({ name: 'date', dir: 'H', pad: 14, align: 'center', stroke: 'border/default', sides: ['right'] }, [btn('Today', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'calendar' } })]);
  const strip = kpiStrip([stat('Orders', '34', '↑ 13% vs last Thu', 'Sparkline', true), stat('Items ordered', '97', '↑ 9% vs last Thu', 'Sparkline', true), stat('Cancelled', '1', 'Item unavailable', 'Sparkline', false), stat('Completed', '12', '↑ 2 vs last Thu', 'Sparkline', true), stat('Delivered on time', '98%', 'Target 95% or more', 'Sparkline', false)]);
  strip.children[0].insertChild(0, today);
  return screen('Seller · Orders', 'Seller', 'nav-all-orders', 'Orders', [
    pageTitle('Orders', 'Times shown in your shop’s time zone (Brisbane, AEST)', [btn('Export', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'download' } }), btn('Open order board', 'Primary')]),
    strip, tableCard, frame({ name: 'bulk-wrap', dir: 'H', justify: 'center', sizeH: 'FILL' }, [bulk]),
  ], { gap: 'space/5' });
}

// ---- Seller · Order board (tablet 1180 × 820)
function tplSellerBoard() {
  const col = function (title, count, bg, border, fg, cards, more) {
    return frame({ name: title, dir: 'V', gap: 'space/2-5', pad: 12, fill: bg, stroke: border, radius: 14, sizeH: 'FILL', sizeV: 'FILL', clip: true }, [
      frame({ name: 'h', dir: 'H', justify: 'between', px: 4, sizeH: 'FILL' }, [text(title, 'Touch/Title', fg), text(count, 'Touch/Title', fg)]),
    ].concat(cards.map(function (v) { return inst('OrderCard', { Variant: v }, { sizeH: 'FILL' }); })).concat(more ? [frame({ name: 'more', dir: 'H', h: 44, justify: 'center', align: 'center', stroke: 'border/input', dash: [3, 3], radius: 'radius/card', sizeH: 'FILL' }, [text(more, 'Touch/Strong', 'text/link')])] : []));
  };
  const board = frame({ name: 'Board', dir: 'H', gap: 14, sizeH: 'FILL', sizeV: 'FILL' }, [
    col('Needs action', '3', 'board/action-bg', 'board/action-border', 'status/attention/fg', ['Urgent', 'Normal']),
    col('Preparing', '5', 'board/prep-bg', 'board/prep-border', 'status/info/fg', ['Preparing'], 'Show 4 more'),
    col('Ready for pickup', '2', 'board/ready-bg', 'board/ready-border', 'status/success/fg', ['Ready']),
  ]);
  const head = frame({ name: 'Board header', dir: 'H', justify: 'between', align: 'center', sizeH: 'FILL' }, [
    frame({ name: 't', dir: 'H', gap: 'space/3', align: 'center' }, [text('Order board', 'Heading/H1'), inst('Badge', { Tone: 'Success', Leading: 'Dot', Label: 'Live · 2:30 pm' })]),
    frame({ name: 'controls', dir: 'H', gap: 'space/2', align: 'center' }, [
      frame({ name: 'instant', dir: 'H', gap: 'space/2-5', align: 'center', h: 48, px: 12, stroke: 'border/control', radius: 10 }, [inst('Switch', { On: 'True', Size: 'Touch' }), frame({ name: 't', dir: 'V' }, [text('Taking instant orders', 'Body/Strong'), text('until 8:00 pm', 'Caption/Default', 'text/muted')])]),
      btn('Pause 30 min', 'Secondary', 'Touch'), btn('Scheduled · 11', 'Secondary', 'Touch'), inst('IconButton', { Variant: 'Secondary', Size: 'Touch', State: 'Default', Icon: { icon: 'volume' } }),
    ]),
  ]);
  return screen('Seller · Order board (tablet)', 'Seller', 'nav-orders', 'Order board', [head, board], { w: 1180, fixedH: 820, collapsed: true, gap: 'space/4', pad: [18, 20, 0, 20] });
}

// ---------------------------------------------------------------- theme helpers
function colorMaps() {
  const toDark = {}, toLight = {};
  Object.keys(S.color).forEach(function (k) { if (S.colorDark[k]) { toDark[S.color[k].id] = S.colorDark[k]; toLight[S.colorDark[k].id] = S.color[k]; } });
  return { toDark: toDark, toLight: toLight };
}
// Rebind every variable binding in a subtree (paints and numeric fields) through map: variableId → Variable.
const SKIP_FIELDS = { fills: 1, strokes: 1, effects: 1, layoutGrids: 1, componentProperties: 1, textRangeFills: 1 };
function rebindNode(node, map) {
  let n = 0;
  ['fills', 'strokes'].forEach(function (k) {
    if (!(k in node)) return; const arr = node[k]; if (!Array.isArray(arr) || !arr.length) return;
    let changed = false;
    const next = arr.map(function (p) { const b = p.boundVariables && p.boundVariables.color; if (b && map[b.id]) { changed = true; const np = figma.variables.setBoundVariableForPaint(p, 'color', map[b.id]); if (p.opacity !== undefined) np.opacity = p.opacity; return np; } return p; });
    if (changed) { node[k] = next; n++; }
  });
  const bv = node.boundVariables || {};
  Object.keys(bv).forEach(function (field) {
    if (SKIP_FIELDS[field]) return; const b = bv[field];
    if (!b || Array.isArray(b) || !map[b.id]) return;
    try { node.setBoundVariable(field, map[b.id]); n++; } catch (e) { /* field not bindable on this node */ }
  });
  return n;
}
function rebindTree(root, map) {
  const nodes = [root].concat(root.findAll ? root.findAll(function () { return true; }) : []);
  let n = 0; nodes.forEach(function (node) { n += rebindNode(node, map); });
  return n;
}
function applyTheme(node, theme) {
  if (S.modes.color) { node.setExplicitVariableModeForCollection(S.colorModes.collection, theme === 'dark' ? S.colorModes.dark : S.colorModes.light); }
  else rebindTree(node, theme === 'dark' ? colorMaps().toDark : colorMaps().toLight);
  node.setPluginData('theme', theme);
}
