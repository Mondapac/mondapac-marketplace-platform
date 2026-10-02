// ---------------------------------------------------------------- data display
const IDT = { Teal: ['cert/seller/tile', 'cert/seller/fg'], Amber: ['status/attention/bg', 'status/attention/fg'], Blue: ['bg/selected', 'text/link'], Purple: ['tile/purple-bg', 'tile/purple-fg'], Red: ['status/critical/bg', 'status/critical/fg'], Neutral: ['status/neutral/bg', 'status/neutral/fg'] };
function ring(o) {
  // o: { size, inner, pct, track, fill }
  const f = frame({ name: o.name || 'ring', w: o.size, h: o.size }); f.fills = [];
  const t = ellipse({ name: 'track', w: o.size, fill: o.track, xy: [0, 0] }); t.arcData = { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: o.inner }; add(f, t);
  if (o.pct > 0) { const a = ellipse({ name: 'value', w: o.size, fill: o.fill, xy: [0, 0] }); a.arcData = { startingAngle: -Math.PI / 2, endingAngle: -Math.PI / 2 + Math.PI * 2 * Math.min(o.pct, 0.999), innerRadius: o.inner }; add(f, a); }
  return f;
}
function centered(node, size) {
  const c = frame({ name: 'center', dir: 'V', align: 'center', justify: 'center', w: size, h: size }); c.fills = [];
  add(c, node); return c;
}

async function buildDataDisplay(page) {
  const root = pageShell(page, 'Data display', 'Stat tiles, sparklines, charts, rings and identity. One axis per chart, legend for two or more series, values in text tokens, never in the series colour.');
  const tile = makeSet('IdentityTile', { Tone: Object.keys(IDT), Shape: ['Rounded', 'Circle'] }, function (c, p) {
    const t = IDT[p.Tone];
    body(c, { dir: 'H', w: 32, h: 32, align: 'center', justify: 'center', fill: t[0], radius: p.Shape === 'Circle' ? 'radius/pill' : 'radius/control' }, [text('KF', 'Caption/Strong', t[1], { name: 'initials' })]);
  }, { width: 760, desc: 'Seller logo placeholder, avatar, queue item type.', text: [{ prop: 'Initials', node: 'initials', def: 'KF' }] });
  componentBlock(root, tile, { title: 'IdentityTile', summary: 'Rounded for shops and item types, circle for people.' });

  const TH = { Meat: 'meat', Poultry: 'poultry', Bakery: 'bakery', Pantry: 'pantry', Other: 'other' };
  const thumb = makeSet('ProductThumb', { Category: Object.keys(TH), Size: ['Sm', 'Md'] }, function (c, p) {
    const s = p.Size === 'Sm' ? 28 : 34; const k = TH[p.Category];
    body(c, { dir: 'H', w: s, h: s, align: 'center', justify: 'center', fill: 'thumb/' + k + '-bg', radius: Math.round(s / 4) }, [icon('product-' + k, 'thumb/' + k + '-fg', p.Size === 'Sm' ? 18 : 20)]);
  }, { width: 760, desc: 'Product category glyph. Replace with the product photo when available (same size and radius).' });
  componentBlock(root, thumb, { title: 'ProductThumb', summary: 'Stack up to three with an 8 px overlap and a 2 px surface ring; show +n for more.' });

  const sparkVals = [150, 158, 149, 162, 170, 166, 172, 169, 175, 171, 178, 184];
  const spark = makeSet('Sparkline', { Tone: ['Accent', 'Attention'] }, function (c, p) {
    const sp = sparkline(sparkVals, 84, 30, p.Tone === 'Accent' ? 'chart/series-1' : 'status/attention/solid');
    c.layoutMode = 'NONE'; c.resize(84, 30); c.fills = [];
    sp.children.slice().forEach(function (n) { add(c, n); });
    sp.remove();
  }, { width: 520, desc: '12-point trend, no axis. End dot marks the current value.' });
  componentBlock(root, spark, { title: 'Sparkline', summary: 'Shape only; the stat tile carries the numbers.' });

  const stat = makeSet('StatTile', { Trend: ['Sparkline', 'Meter', 'None'], Tone: ['Positive', 'Neutral'] }, function (c, p) {
    body(c, { dir: 'V', w: 280, pad: [16, 18, 16, 18], gap: 'space/1-5' }, [
      text('Orders today', 'Body/Small Strong', 'text/secondary', { name: 'label' }),
      frame({ name: 'value-row', dir: 'H', align: 'end', justify: 'between', sizeH: 'FILL' }, [
        text('184', 'Heading/Stat', 'text/primary', { name: 'value' }),
        p.Trend === 'Sparkline' ? inst('Sparkline', { Tone: 'Accent' }, { name: 'trend' }) : null,
      ]),
      p.Trend === 'Meter' ? inst('Meter', { Tone: 'Accent', Value: '25' }, { name: 'meter', sizeH: 'FILL' }) : null,
      text(p.Tone === 'Positive' ? '↑ 12 vs yesterday' : 'Target 95%', p.Tone === 'Positive' ? 'Body/Small Strong' : 'Body/Small', p.Tone === 'Positive' ? 'status/success/fg' : 'text/muted', { name: 'delta' }),
    ]);
  }, { width: 1040, desc: 'Label, value, delta against a named period, optional trend or meter. Tone=Positive colours the delta green; use it only when up is good.', text: [{ prop: 'Label', node: 'label', def: 'Orders today' }, { prop: 'Value', node: 'value', def: '184' }, { prop: 'Delta', node: 'delta', def: '↑ 12 vs yesterday' }] });
  componentBlock(root, stat, { title: 'StatTile', summary: 'Always say what the delta compares against.', use: ['Line them up in a KPI strip with 1 px dividers.', 'Positive delta uses the success colour only when up is good.'] });

  // Trend chart (static reference drawing; code renders live data)
  const chart = makeComponent('TrendChart', function (c) {
    const W = 760, H = 200, padTop = 14, max = 32000;
    const yHourly = [12, 8, 5, 3, 4, 10, 60, 240, 520, 780, 950, 1180, 1420, 1260, 1050, 980, 1150, 1620, 1980, 1890, 1430, 900, 450, 180];
    const k = 11926.58 / 6977; const yest = yHourly.map(function (v) { return v * k; });
    const noise = [1.1, 0.9, 1.2, 1, 0.8, 1.1, 1.05, 1.12, 1.04, 1.09, 1.1, 1.06, 1.11, 1.07, 1.1];
    const X = function (h) { return h / 24 * W; }; const Y = function (v) { return H - v / max * (H - padTop); };
    const cum = function (arr, upto) { const pts = [[0, 0]]; let s = 0; for (let h = 0; h < 24; h++) { if (h + 1 > upto) { s += arr[h] * (upto - h); pts.push([upto, s]); break; } s += arr[h]; pts.push([h + 1, s]); } return pts; };
    const yPts = cum(yest, 24); const raw = cum(yest.map(function (v, i) { return v * (noise[i] || 1); }), 14.5);
    const sc = 12904.6 / raw[raw.length - 1][1]; const tPts = raw.map(function (p) { return [p[0], p[1] * sc]; });
    const path = function (pts) { return 'M ' + pts.map(function (p) { return X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' L '); };
    const last = tPts[tPts.length - 1]; const mx = X(last[0]), my = Y(last[1]);
    body(c, { dir: 'V', gap: 'space/2', w: W }, [
      frame({ name: 'legend', dir: 'H', gap: 'space/4', align: 'center' }, [
        frame({ name: 'today', dir: 'H', gap: 'space/1-5', align: 'center' }, [rect({ name: 'key', w: 14, h: 2, fill: 'chart/series-1' }), text('Today', 'Body/Small', 'text/secondary')]),
        frame({ name: 'yesterday', dir: 'H', gap: 'space/1-5', align: 'center' }, [vector({ name: 'key', d: 'M 0 0 L 14 0', stroke: 'chart/compare', strokeW: 2, dash: [3, 3] }), text('Yesterday', 'Body/Small', 'text/secondary')]),
      ]),
    ]);
    const plot = frame({ name: 'plot', w: W, h: 232 }); plot.fills = [];
    [10000, 20000, 30000].forEach(function (v) { add(plot, rect({ name: 'grid ' + v, w: W, h: 1, fill: 'chart/grid', xy: [0, Y(v)] })); add(plot, text({ 10000: '10,000', 20000: '20,000', 30000: '30,000' }[v], 'Caption/Default', 'text/muted', { xy: [0, Y(v) - 17] })); });
    add(plot, rect({ name: 'baseline', w: W, h: 1, fill: 'chart/axis', xy: [0, H] }));
    add(plot, vector({ name: 'yesterday', d: path(yPts), stroke: 'chart/compare', strokeW: 2, dash: [5, 5], xy: [0, 0] }));
    add(plot, vector({ name: 'area', d: path(tPts) + ' L ' + mx.toFixed(1) + ' ' + H + ' L 0 ' + H + ' Z', fill: 'chart/series-1', fillOpacity: 0.1, closed: true, xy: [0, 0] }));
    add(plot, vector({ name: 'today', d: path(tPts), stroke: 'chart/series-1', strokeW: 2, xy: [0, 0] }));
    add(plot, rect({ name: 'crosshair', w: 1, h: H - 14, fill: 'chart/series-1', fillOpacity: 0.35, xy: [mx, 14] }));
    add(plot, ellipse({ name: 'marker', w: 10, fill: 'chart/series-1', stroke: 'bg/surface', strokeW: 2, strokeAlign: 'OUTSIDE', xy: [mx - 5, my - 5] }));
    add(plot, inst('Tooltip', {}, { xy: [mx - 160, my - 66] }));
    ['12 am', '6 am', '12 pm', '6 pm', '12 am'].forEach(function (l, i) { add(plot, text(l, 'Caption/Default', 'text/muted', { xy: [i === 0 ? 0 : (i === 4 ? W - 34 : i * 190 - 16), 210] })); });
    add(c, plot);
  }, { desc: 'Cumulative trend with a dashed comparison period, crosshair and tooltip. Reference drawing: code renders live data with the same tokens.' });
  const chartWrap = frame({ name: 'TrendChart', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(chartWrap, chart);
  componentBlock(root, chartWrap, { title: 'TrendChart', summary: 'One y-axis. Legend always present for two series. Hover shows a crosshair and tooltip.', a11y: ['Provide a summary label and a "View as table" option.'], dont: ['Second y-axis.', 'Values written in the series colour.'] });

  const donut = makeComponent('DonutProgress', function (c) {
    c.layoutMode = 'NONE'; c.resize(72, 72); c.fills = [];
    add(c, ring({ size: 72, inner: 0.78, pct: 0.84, track: 'chart/donut-track', fill: 'cert/seller/fg' }));
    const lbl = centered(text('84%', 'Body/Strong', 'text/primary', { name: 'value' }), 72); lbl.x = 0; lbl.y = 0; add(c, lbl);
  }, { desc: 'Share of a whole, e.g. sellers with a valid certificate.', text: [{ prop: 'Value', node: 'value', def: '84%' }] });
  const split = makeComponent('SplitBar', function (c) {
    body(c, { dir: 'H', w: 300, h: 10, gap: 2 }, [rect({ name: 'part-1', w: 254, h: 10, fill: 'chart/series-1', radius: 0, sizeH: 'FILL' }), rect({ name: 'part-2', w: 44, h: 10, fill: 'chart/split-2' })]);
    c.children[0].topLeftRadius = 4; c.children[0].bottomLeftRadius = 4; c.children[1].topRightRadius = 4; c.children[1].bottomRightRadius = 4;
  }, { desc: 'Two-part split with a 2 px gap, legend below in code.' });
  const weekly = makeComponent('WeeklyBars', function (c) {
    c.layoutMode = 'NONE'; c.resize(304, 92); c.fills = [];
    add(c, rect({ name: 'baseline', w: 304, h: 1, fill: 'chart/axis', xy: [0, 70] }));
    const vals = [1890, 2104, 1975, 2260, 2410, 2318.4]; const lbls = ['1 Sep', '8 Sep', '15 Sep', '22 Sep', '29 Sep', '6 Oct'];
    vals.forEach(function (v, i) {
      const h = Math.round(v / 2500 * 52); const x = 14 + i * 50;
      const b = rect({ name: 'bar ' + lbls[i], w: 24, h: h, fill: i === 5 ? 'chart/series-1' : 'chart/series-1-soft', xy: [x, 70 - h] }); b.topLeftRadius = 4; b.topRightRadius = 4; add(c, b);
      add(c, text(lbls[i], 'Mono/Small', 'text/muted', { xy: [x - 4, 76] }));
    });
    add(c, text('2,318', 'Caption/Strong', 'text/primary', { xy: [264, 70 - Math.round(2318.4 / 2500 * 52) - 18] }));
  }, { desc: 'Columns ≤ 24 px, 4 px rounded top, square base; only the current value is labelled.' });
  const misc = frame({ name: 'Charts', dir: 'H', gap: 'space/8', pad: 32, fill: 'bg/surface', radius: 16, align: 'center' }, [donut, split, weekly]);
  componentBlock(root, misc, { title: 'DonutProgress · SplitBar · WeeklyBars', summary: 'Small charts for cards. Each has a text alternative in code.' });

  const CR = { Critical: ['status/critical/track', 'status/critical/solid', 'status/critical/fg', 0.69], Attention: ['status/attention/track', 'status/attention/solid', 'status/attention/fg', 0.55], Accent: ['chart/meter-track', 'action/primary', 'text/link', 0.48], Success: ['status/success/track', 'status/success/fg', 'status/success/fg', 0.42] };
  const cdr = makeSet('CountdownRing', { Tone: Object.keys(CR) }, function (c, p) {
    const t = CR[p.Tone];
    c.layoutMode = 'NONE'; c.resize(48, 48); c.fills = [];
    add(c, ring({ size: 48, inner: 0.82, pct: t[3], track: t[0], fill: t[1] }));
    const lbl = frame({ name: 'label', dir: 'V', align: 'center', justify: 'center', w: 48, h: 48 }); lbl.fills = [];
    add(lbl, text('18', 'Touch/Title', t[2], { name: 'minutes' })); add(lbl, text('min', 'Mono/Small', t[2], { name: 'unit' }));
    lbl.itemSpacing = -2; add(c, lbl); lbl.x = 0; lbl.y = 0;
  }, { width: 520, desc: 'Minutes left until ready-by or pickup. Updates every 60 s.', text: [{ prop: 'Minutes', node: 'minutes', def: '18' }] });
  componentBlock(root, cdr, { title: 'CountdownRing', summary: 'Rules (pending PO, D15): waiting ≥ 8 min → Critical; ≤ 20 min to ready → Attention; ready for courier → Success.', a11y: ['role="timer", not announced every minute.'] });
  tag(root);
}

// ---------------------------------------------------------------- tables & collections
async function buildTables(page) {
  const root = pageShell(page, 'Tables & collections', 'Index pages: header cells, cells by content type, pagination and the floating bulk action bar. Tables use real <table> markup in code.');
  const cell = makeSet('TableCell', { Type: ['Header', 'Text', 'Two-line', 'Number', 'Checkbox', 'Actions'], State: ['Default', 'Selected'] }, function (c, p) {
    const hdr = p.Type === 'Header';
    const fill = hdr ? 'bg/subtle' : (p.State === 'Selected' ? 'bg/row-selected' : 'bg/surface');
    const kids = [];
    if (p.Type === 'Header') kids.push(text('Column', 'Body/Small Strong', 'text/muted', { name: 'label' }), icon('arrow-down', 'icon/muted', 12));
    if (p.Type === 'Text') kids.push(text('Kuraby QLD 4112', 'Body/Default', 'text/primary', { name: 'label', truncate: true, sizeH: 'FILL' }));
    if (p.Type === 'Two-line') kids.push(frame({ name: 'lines', dir: 'V', sizeH: 'FILL' }, [text('Kuraby Fresh Halal Meats', 'Body/Strong', 'text/primary', { name: 'label', truncate: true, sizeH: 'FILL' }), text('kuraby-fresh-halal · Kuraby QLD 4112', 'Caption/Default', 'text/muted', { name: 'meta', truncate: true, sizeH: 'FILL' })]));
    if (p.Type === 'Number') kids.push(text('AUD 86.40', 'Body/Default', 'text/primary', { name: 'label' }));
    if (p.Type === 'Checkbox') kids.push(inst('Checkbox', { Value: p.State === 'Selected' ? 'Checked' : 'Unchecked', State: 'Default' }));
    if (p.Type === 'Actions') kids.push(inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default' }));
    body(c, { dir: 'H', w: p.Type === 'Checkbox' || p.Type === 'Actions' ? 56 : 200, h: hdr ? 42 : 56, px: 'space/3', gap: 'space/1', align: 'center', justify: p.Type === 'Number' ? 'end' : (p.Type === 'Checkbox' || p.Type === 'Actions' ? 'center' : 'start'), fill: fill, stroke: hdr ? 'border/default' : 'border/row', sides: ['bottom'] }, kids);
    if (hdr) c.children[1].name = 'sort';
  }, { width: 1040, skip: function (p) { return p.Type === 'Header' && p.State === 'Selected'; }, desc: 'Build rows from cells: fixed width for short columns, Fill for the main column.',
    text: [{ prop: 'Text', node: 'label', def: 'Kuraby Fresh Halal Meats' }, { prop: 'Meta', node: 'meta', def: 'kuraby-fresh-halal · Kuraby QLD 4112' }], bool: [{ prop: 'Sorted', node: 'sort', def: false }] });
  componentBlock(root, cell, { title: 'TableCell', summary: 'Header 42 px, rows 56 px. Numbers right-aligned with tabular figures in code.', a11y: ['aria-sort on the sorted header.', 'Row checkbox labelled "Select <name>".'] });

  const card = makeComponent('CardHeader', function (c) {
    body(c, { dir: 'H', w: 560, pad: [16, 18, 12, 18], gap: 'space/3', align: 'center', justify: 'between' }, [text('Review queue', 'Heading/H2', 'text/primary', { name: 'title' }), text('Open full queue', 'Body/Small Strong', 'text/link', { name: 'action' })]);
  }, { desc: 'Title and optional link at the top of a card.', text: [{ prop: 'Title', node: 'title', def: 'Review queue' }, { prop: 'Action', node: 'action', def: 'Open full queue' }], bool: [{ prop: 'Show action', node: 'action', def: true }] });
  const pag = makeComponent('Pagination', function (c) {
    body(c, { dir: 'H', w: 960, pad: [12, 14, 12, 14], gap: 'space/2', align: 'center', justify: 'between' }, [
      text('1–25 of 128', 'Body/Small', 'text/muted', { name: 'range' }),
      frame({ name: 'controls', dir: 'H', gap: 'space/2', align: 'center' }, [text('Rows per page', 'Body/Small', 'text/muted'), inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: '25' }), inst('IconButton', { Variant: 'Secondary', Size: 'Sm', State: 'Disabled', Icon: { icon: 'chevron-left' } }), inst('IconButton', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Icon: { icon: 'chevron-right' } })]),
    ]);
  }, { desc: 'Range on the left, page size and arrows on the right.', text: [{ prop: 'Range', node: 'range', def: '1–25 of 128' }] });
  const bulk = makeComponent('BulkActionBar', function (c) {
    body(c, { dir: 'H', pad: [8, 8, 8, 16], gap: 'space/2', align: 'center', fill: 'bg/surface', stroke: 'border/control', radius: 'radius/card', effect: 'Elevation/Floating' }, [
      frame({ name: 'count', dir: 'H', gap: 'space/2', align: 'center' }, [inst('CountBadge', { Tone: 'Critical', Count: '2' }, { name: 'count-badge' }), text('selected', 'Body/Strong', 'text/link')]),
      rect({ name: 'divider', w: 1, h: 22, fill: 'border/default' }),
      inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Approve' }, { name: 'action-1' }), inst('Button', { Variant: 'Secondary', Size: 'Sm', State: 'Default', Label: 'Message sellers' }, { name: 'action-2' }),
      inst('Button', { Variant: 'Destructive', Size: 'Sm', State: 'Default', Label: 'Suspend…' }, { name: 'action-3' }), inst('Button', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Label: 'Clear' }, { name: 'clear' }),
    ]);
    safe('expose count', function () { c.children[0].children[0].isExposedInstance = true; });
  }, { desc: 'Appears when one or more rows are selected; floats at the bottom of the content area.' });
  const tbl = frame({ name: 'Table parts', dir: 'V', gap: 'space/6', pad: 32, fill: 'bg/surface', radius: 16 }, [card, pag, bulk]);
  componentBlock(root, tbl, { title: 'CardHeader · Pagination · BulkActionBar', summary: 'The bulk bar is role="toolbar" and announces "2 selected" when it appears.' });
  tag(root);
}
