// ---- Seller health (owner decisions, 31 Oct 2026 18:53–18:54Z; brief /mnt/project-files/handoffs/seller-health-to-build.md)
// Five metrics, each scored 0–100 inside its band (67–100 Healthy, 34–66 At risk, 0–33 Unhealthy); the overall score is the
// lowest metric that has data, shown with that metric's name. 1 all five metrics from the start (Reports shows No data until
// seller reports exist); 2 Unhealthy = alert to the seller and a place in the admin "Needs a look" queue, never an automatic
// action: an admin decides and records a reason; 3 a seller gets a score only after 10 orders in the window, "New" before.
// Faults that are not the seller's are not counted. Certificates are not part of the score (only an expiry note).
const SH = 'Proposal · Seller health';
function shTag(n) { n.setPluginData('proposal', 'seller-health'); return n; }
function shAdmin(state, active, crumb, kids) { return shTag(screen(SH + ' · ' + state, 'Admin', active, crumb, kids, { minH: PANEL_MIN_H, gap: 'space/4' })); }
function shSeller(state, crumb, kids) { return shTag(screen(SH + ' · ' + state, 'Seller', 'none', crumb, kids, { minH: PANEL_MIN_H, gap: 'space/4' })); }
function shSp() { return frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }); }
const SH_FILL = { Healthy: 'status/success/fg', 'At risk': 'status/attention/solid', Unhealthy: 'status/critical/meter', 'No data': 'border/default' };

// [metric, window, value, target, state, score, seller wording]
const SH_AT_RISK = [
  ['Seller cancellations', '30 days', '1.2%', 'under 2.5%', 'Healthy', '86', 'Orders you cancelled or marked unavailable'],
  ['Late ready', '30 days', '7.4%', 'under 4%', 'At risk', '58', 'Orders ready after the time we promised the customer'],
  ['Customer rating', '90 days', '4.6 · 23 reviews', '4.0 or more', 'Healthy', '91', 'Average of approved reviews'],
  ['Lost disputes', '90 days', '0%', 'under 0.5%', 'Healthy', '100', 'Card disputes decided against you'],
  ['Reports', '90 days', 'No data', '0', 'No data', '—', 'Confirmed reports from customers (coming soon)'],
];
const SH_UNHEALTHY = [
  ['Seller cancellations', '30 days', '9.8%', 'under 2.5%', 'Unhealthy', '12', ''], ['Late ready', '30 days', '12.5%', 'under 4%', 'Unhealthy', '24', ''],
  ['Customer rating', '90 days', '3.9 · 8 reviews', '4.0 or more', 'At risk', '63', ''], ['Lost disputes', '90 days', '0%', 'under 0.5%', 'Healthy', '100', ''], ['Reports', '90 days', 'No data', '0', 'No data', '—', ''],
];
function shScore(state, score) { return frame({ name: 'score', dir: 'H', gap: 'space/2', align: 'center' }, [inst('HealthIndicator', { State: state }), score && score !== '—' ? text(score, 'Body/Strong', 'text/primary') : null]); }
function shNew(done) { return bdg('Neutral', 'None', 'New · ' + done + ' of 10 orders'); }
// One metric row: name and window, value, target, status; the metric that sets the overall score is marked "Lowest".
function shMetricRow(m, lowest, seller) {
  const name = frame({ name: 'metric', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(m[0], 'Body/Strong'), text(seller ? m[6] + ' · last ' + m[1] : 'Last ' + m[1], 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]);
  return frame({ name: 'row · ' + m[0], dir: 'H', gap: 'space/4', align: 'center', pad: [12, 0, 12, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [name,
    text(m[2], 'Body/Default', m[4] === 'No data' ? 'text/muted' : 'text/primary', { w: 140 }), text(m[3], 'Body/Small', 'text/muted', { w: 110 }),
    frame({ name: 'status', dir: 'H', gap: 'space/2', align: 'center', w: 190 }, [inst('HealthIndicator', { State: m[4] }), lowest ? bdg('Neutral', 'None', 'Lowest') : null])]);
}
// 13 weekly bars for the 90-day trend, coloured by band.
function shTrend(list) {
  const bars = list.map(function (b, i) { return rect({ name: 'week ' + (i + 1), w: 14, h: Math.max(4, Math.round(b[0] * 0.48)), fill: SH_FILL[b[1]], radius: 2 }); });
  return frame({ name: 'trend', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [frame({ name: 'bars', dir: 'H', gap: 'space/1-5', align: 'end', h: 52 }, bars), text('Score each week, last 90 days', 'Caption/Default', 'text/muted')]);
}
const SH_TREND_RISK = [[88, 'Healthy'], [86, 'Healthy'], [90, 'Healthy'], [84, 'Healthy'], [80, 'Healthy'], [77, 'Healthy'], [72, 'Healthy'], [69, 'Healthy'], [64, 'At risk'], [61, 'At risk'], [60, 'At risk'], [57, 'At risk'], [58, 'At risk']];
const SH_TREND_BAD = [[70, 'Healthy'], [66, 'At risk'], [55, 'At risk'], [50, 'At risk'], [41, 'At risk'], [36, 'At risk'], [30, 'Unhealthy'], [26, 'Unhealthy'], [22, 'Unhealthy'], [18, 'Unhealthy'], [14, 'Unhealthy'], [12, 'Unhealthy'], [12, 'Unhealthy']];
function shCard(title, overall, score, lowestName, metrics, trend, o) {
  o = o || {};
  const head = frame({ name: 'overall', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [shScore(overall, score), text('Set by ' + lowestName, 'Body/Small', 'text/muted', { sizeH: 'FILL' })]);
  const rows = metrics.map(function (m) { return shMetricRow(m, m[0] === lowestName, o.seller); });
  const foot = text(o.foot || 'Calculated 31 Oct, 2:00 am (Brisbane) · formula v1 · not counted: customer cancellations, failed payments, courier delays, disputes you won', 'Caption/Default', 'text/muted', { sizeH: 'FILL' });
  return podCard(title, [head].concat(rows, trend ? [shTrend(trend)] : [], [foot]), { right: o.right || [] });
}
function shHeader(name, status, sub, right) { return podHeader(name, [saBadge(status), inst('CertChip', { Kind: 'Seller' })], sub, right, 'Sellers'); }

// ---- Admin
const SH_ROWS = [
  ['SC', 'Neutral', 'Slacks Creek Butchers', 'slacks-creek-butchers', 'Approved', 'Unhealthy', '12', 'Seller cancellations', '9.8%', '186'],
  ['DA', 'Blue', 'Darra Asian Mart', 'darra-asian-mart', 'Approved', 'At risk', '58', 'Late ready', '7.4%', '268'],
  ['HP', 'Amber', 'Holland Park Bakehouse', 'holland-park-bakehouse', 'Approved', 'At risk', '64', 'Customer rating', '3.6', '356'],
  ['LF', 'Neutral', 'Logan Family Grocer', 'logan-family-grocer', 'Approved', 'Healthy', '79', 'Late ready', '3.0%', '190'],
  ['KF', 'Teal', 'Kuraby Fresh Halal', 'kuraby-fresh-halal', 'Approved', 'Healthy', '86', 'Seller cancellations', '0.8%', '412'],
  ['MK', 'Amber', 'Mariam’s Kitchen', 'mariams-kitchen', 'Approved', 'New', '4', '', '', '4'],
];
function shHealthCell(r) { return r[5] === 'New' ? shNew(r[6]) : shScore(r[5], r[6]); }
function shList() {
  const cols = [['Seller', 'fill'], ['Status', 150], ['Health', 170, false, false], ['Lowest metric', 220], ['Orders, 30 days', 130, false, true]];
  const rows = SH_ROWS.map(function (r) { return [smSeller(r), saBadge(r[4]), shHealthCell(r), r[7] ? twoLine(r[7], r[8]) : poText('—', 'Body/Default', 'text/muted'), poText(r[9])]; });
  const scr = shAdmin('Admin · Sellers list · Sorted by health', 'nav-sellers', 'Sellers', [smHeader(), poViews(SM_VIEWS, 'Approved'), poToolbar(SM_SEARCH, 'Sorted by Health, lowest first', { filters: 0 }),
    poTable('Seller list', cols, rows, { attention: [0], range: '1–25 of 109 sellers', pager: { pages: ['1', '2', '3', '4', '5'] } }),
    text('Health shows the band and the score. "Lowest metric" names the metric that sets it. New sellers show "New" with their order count until 10 orders. Filter: Health is any of Healthy, At risk, Unhealthy, New.', 'Body/Small', 'text/muted', { sizeH: 'FILL' })]);
  return scr;
}
function shOverview() {
  const card = shCard('Health', 'At risk', '58', 'Late ready', SH_AT_RISK, SH_TREND_RISK, { right: [btn('Recalculate now', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'refresh-cw' } })] });
  const alerts = podCard('Alerts sent', [podPair('29 Oct', 'At risk: Late ready, email and panel notice'), text('The seller sees the same card on their Performance page.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]);
  return shAdmin('Admin · Seller · Overview · At risk', 'nav-sellers', 'Sellers / Darra Asian Mart', [shHeader('Darra Asian Mart', 'Approved', 'Grocery (main) · darra-asian-mart · Greater Brisbane · joined 4 Apr 2026', [btn('Suspend…', 'Secondary', 'Md'), smMore()]), smTabs('Overview'),
    podColumns([card], [alerts, podActivity([['29 Oct', 'Health changed to At risk (58)', 'System · Late ready 7.4%'], ['4 Apr', 'Seller approved', 'Layla Haddad']])])]);
}
function shUnhealthy() {
  const banner = psBanner('needs-a-look', 'Critical', 'Unhealthy since 27 Oct · in the Needs a look queue', 'Nothing happens automatically. Decide what to do and record a reason; the seller was alerted by email and in their panel.', 'Record a decision');
  const card = shCard('Health', 'Unhealthy', '12', 'Seller cancellations', SH_UNHEALTHY, SH_TREND_BAD, { right: [btn('Recalculate now', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'refresh-cw' } })] });
  return shAdmin('Admin · Seller · Overview · Unhealthy', 'nav-sellers', 'Sellers / Slacks Creek Butchers', [shHeader('Slacks Creek Butchers', 'Approved', 'Butcher (main) · slacks-creek-butchers · Greater Brisbane · joined 20 Jan 2026', [btn('Suspend…', 'Secondary', 'Md'), smMore()]), banner, smTabs('Overview'),
    podColumns([card], [podActivity([['27 Oct', 'Health changed to Unhealthy (12)', 'System · Seller cancellations 9.8%'], ['27 Oct', 'Added to Needs a look', 'System'], ['20 Oct', 'Health changed to At risk (41)', 'System']])])]);
}
function shDecision() {
  const radio = function (label, help, on) { return frame({ name: 'option · ' + label, dir: 'H', gap: 'space/3', align: 'start', pad: 'space/3', stroke: on ? 'focus/ring' : 'border/default', strokeW: on ? 2 : 1, radius: 'radius/control', sizeH: 'FILL' }, [frame({ name: 'radio', dir: 'H', w: 18, h: 18, align: 'center', justify: 'center', radius: 'radius/pill', stroke: on ? 'action/primary' : 'border/input', fill: 'bg/surface' }, on ? [frame({ name: 'dot', w: 8, h: 8, radius: 'radius/pill', fill: 'action/primary' })] : []), frame({ name: 'text', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(label, 'Body/Strong'), text(help, 'Body/Small', 'text/muted', { sizeH: 'FILL' })])]); };
  const dlg = podDialog('Record a decision', 'What happens with Slacks Creek Butchers?', [
    radio('Send a warning', 'The owner gets your message by email and in their panel. The seller stays in the queue until health improves or you close it.', true),
    radio('No action', 'Close the item. It comes back if health gets worse.', false),
    radio('Suspend…', 'Opens the Suspend dialog with this reason filled in.', false),
    podField('Reason', psSelect('Too many cancellations')), podField('Message to the owner', psTextarea('9.8% of your units were cancelled in the last 30 days. Please update stock before each day starts.', 'Filled'), 'Only for Send a warning.')], 'Record decision');
  const scr = frame({ name: SH + ' · Admin · Record a decision', dir: 'V', w: 760, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Seller health: record a decision', 'Heading/H1'),
    para('Opened from the Needs a look queue or the seller banner. The system never suspends or limits a seller on its own; the admin chooses and the reason goes to Activity.', 680), dlg]);
  tag(scr); return shTag(scr);
}
function shQueue() {
  const cols = [['Seller', 'fill'], ['Health', 170], ['Lowest metric', 220], ['Since', 120, true], ['Last decision', 200]];
  const rows = [[smSeller(SH_ROWS[0]), shScore('Unhealthy', '12'), twoLine('Seller cancellations', '9.8%'), poText('27 Oct'), poText('—', 'Body/Default', 'text/muted')],
    [smSeller(['BT', 'Purple', 'Browns Plains Tandoor', 'browns-plains-tandoor']), shScore('Unhealthy', '29'), twoLine('Late ready', '11.2%'), poText('22 Oct'), twoLine('Warning sent', '23 Oct · Omar Siddiq')]];
  return shAdmin('Admin · Review queue · Needs a look', 'nav-review', 'Review queue / Needs a look', [pageTitle('Needs a look', 'Unhealthy sellers wait here for an admin decision. Oldest first.', []), poTable('Needs a look', cols, rows, { range: '1–2 of 2 sellers', pager: { pages: ['1'], last: true } })]);
}
function shSettings() {
  const groups = PS_ADMIN_GROUPS.concat([['Sellers', 'store', [['Seller health']]]]);
  const th = function (a, b) { return frame({ name: 'thresholds', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text('At risk from', 'Body/Small', 'text/muted'), psInput(a), text('Unhealthy from', 'Body/Small', 'text/muted'), psInput(b)]); };
  const rows = [psRow('Seller cancellations', 'Window 30 days. Customer cancellations and failed payments are not counted.', th('2.5%', '5%')), psRow('Late ready', 'Window 30 days. Courier delays are not counted.', th('4%', '10%')),
    psRow('Customer rating', 'Window 90 days. Below the minimum number of reviews it shows No data.', th('4.0', '3.5')), psRow('Lost disputes', 'Window 90 days. Disputes the seller won are not counted.', th('0.5%', '1%')),
    psRow('Reports', 'Window 90 days. Shows No data until customer reports exist.', th('1', '3')), psRow('Orders before a score', 'Until then the seller shows New.', psInput('10')), psRow('Reviews before a rating counts', null, psInput('5'))];
  const content = frame({ name: 'content', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, [pageTitle('Seller health', 'Australia market. Changes apply from the next nightly calculation and start formula v2.', [btn('Save', 'Primary', 'Md')]), psSection('Thresholds', 'Scores run 0–100: 67–100 Healthy, 34–66 At risk, 0–33 Unhealthy. The overall score is the lowest metric with data.', rows)]);
  return shAdmin('Admin · Settings · Seller health', 'nav-settings', 'Settings / Sellers / Seller health', [frame({ name: 'Settings layout', dir: 'H', gap: 'space/6', align: 'start', sizeH: 'FILL' }, [psSubNav(groups, 'Seller health'), content])]);
}
// ---- Seller panel › Performance
function shTip(title, body) { return podCard(title, [text(body, 'Body/Default', 'text/secondary', { sizeH: 'FILL' })]); }
function shSellerPerf() {
  const card = shCard('Your health', 'At risk', '58', 'Late ready', SH_AT_RISK, SH_TREND_RISK, { seller: true, foot: 'Updated today, 2:00 am · things that weren’t your fault are not counted', right: [btn('Refresh now', 'Secondary', 'Sm', { 'Leading icon': true, Icon: { icon: 'refresh-cw' } })] });
  return shSeller('Seller · Performance · At risk', 'Performance', [pageTitle('Performance', 'How customers experience your shop. Healthy shops can be featured on the home page.', [ppLink('How is it calculated?', 'info', 'how')]),
    psBanner('at-risk', 'Attention', 'Late ready is above the target', '7.4% of your orders were ready after the time we promised. Check your preparation time in Settings › Store profile.', 'Open preparation time'),
    podColumns([card], [shTip('What helps', 'Keep stock up to date before each day starts. Mark an item unavailable only before you accept the order. Set a preparation time you can keep at busy hours.'), shTip('What happens next', 'Nothing changes automatically. If your health stays low, our team may contact you.')])]);
}
function shSellerNew() {
  const prog = frame({ name: 'progress', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [text('4 of 10 orders', 'Body/Strong'), inst('Meter', { Tone: 'Accent', Value: '25' }, { name: 'meter', sizeH: 'FILL' }), text('Your score starts after 10 orders in the last 30 days, so one bad day doesn’t count too much.', 'Body/Small', 'text/muted', { sizeH: 'FILL' })]);
  return shSeller('Seller · Performance · New', 'Performance', [pageTitle('Performance', 'How customers experience your shop.', [ppLink('How is it calculated?', 'info', 'how')]), podCard('Your health', [frame({ name: 'overall', dir: 'H', gap: 'space/3', align: 'center' }, [shNew('4')]), prog], {})]);
}
function shHow() {
  const lines = ['We check five things: orders you cancelled, orders ready late, your rating, card disputes you lost, and confirmed reports.', 'Each one gets a score from 0 to 100. Your health is your lowest score, so one problem is never hidden by good results elsewhere.',
    '67–100 is Healthy, 34–66 At risk, 0–33 Unhealthy.', 'We don’t count customer cancellations, failed payments, courier delays or disputes you won.', 'Your halal and other certificates are checked separately and are not part of this score.', 'Scores update every night at 2:00 am your time. You can refresh once an hour.'];
  const dlg = podDialog('How is it calculated?', 'How your health is calculated', lines.map(function (s) { return text('• ' + s, 'Body/Default', 'text/secondary', { sizeH: 'FILL' }); }), 'Got it');
  const scr = frame({ name: SH + ' · Seller · How is it calculated', dir: 'V', w: 760, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Seller health: how it is calculated (HLT-04)', 'Heading/H1'), dlg]);
  tag(scr); return shTag(scr);
}
function shStates() {
  const lbl = function (s) { return text(s, 'Caption/Strong', 'text/muted'); };
  const scr = frame({ name: SH + ' · States', dir: 'V', w: 1240, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Seller health: states', 'Heading/H1'),
    para('Both panels. Times are in the seller’s own time zone. Scores and thresholds belong to the current Market.', 1100),
    lbl('Refresh cooldown (seller)'), frame({ name: 'cooldown', dir: 'H', gap: 'space/3', align: 'center' }, [btn('Refresh now', 'Secondary', 'Sm', { State: 'Disabled', 'Leading icon': true, Icon: { icon: 'refresh-cw' } }), text('Available again in 42 min', 'Body/Small', 'text/muted')]),
    lbl('Calculating'), psBanner('calculating', 'Info', 'Recalculating health', 'This takes a few seconds. The last score stays until the new one is ready.'),
    lbl('Could not load'), psBanner('load-error', 'Critical', 'Health could not be loaded', 'Try again. The rest of the page still works.', 'Try again'),
    lbl('Metric without data'), shMetricRow(SH_AT_RISK[4], false, false),
    lbl('Certificate note (not part of the score)'), psBanner('cert-note', 'Attention', 'Halal certificate expires in 14 days', 'Certificates are checked on their own. An expired certificate takes its tag off your offers.', 'Open certificate'),
    lbl('Seller notice when At risk or Unhealthy (email and panel)'), psBanner('notice', 'Attention', 'Your shop health is At risk', 'Late ready is 7.4% (target under 4%). See what helps on your Performance page.', 'Open Performance')]);
  tag(scr); return shTag(scr);
}

PROPOSALS['seller-health'] = { title: SH, rows: function () {
  return [[shList(), shOverview(), shUnhealthy()], [shQueue(), shDecision(), shSettings()], [shSellerPerf(), shSellerNew(), shHow(), shStates()]];
} };
