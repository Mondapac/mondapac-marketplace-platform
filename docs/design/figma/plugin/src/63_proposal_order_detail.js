// ---- Panels · Order detail (owner's brief, 31 Oct 2026, after Medusa's order page): Medusa's sections, split by seller
// order because one MondaPac order is shared between sellers. Owner decisions (31 Oct): 1 an admin cancels and refunds the
// whole order only until any seller marks its part ready, then refunds each seller order; 2 a read-only activity history in
// both panels, each role seeing its own events; 3 notes for admins and notes for the seller, neither sees the other's;
// 4 no address or email change after payment at launch; 5 refunds only, returns after the returns module; 6 the seller can
// mark an item unavailable until it marks the order ready, and that item is refunded to the customer at once.
// Not taken from Medusa: transfer ownership, order edit, raw JSON, allocate items.
const POD = 'Proposal · Panels · Order detail';
function podTag(n) { n.setPluginData('proposal', 'order-detail'); return n; }
function podSp() { return frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }); }
function podScreen(ws, state, crumb, kids, overlay) {
  const scr = screen(POD + ' · ' + ws + ' · ' + state, ws, ws === 'Seller' ? 'nav-all-orders' : 'nav-orders', crumb, kids, { minH: PANEL_MIN_H, gap: 'space/4' });
  (overlay ? [].concat(overlay) : []).forEach(function (o) { add(scr, o); });
  return podTag(scr);
}
function podCard(title, kids, o) {
  o = o || {};
  const head = frame({ name: 'head', dir: 'H', gap: 'space/2', align: 'center', pad: [16, 20, 12, 20], sizeH: 'FILL' }, [text(title, 'Heading/H2')].concat(o.badge ? [o.badge] : [], [podSp()], o.right || []));
  return card(title, [head, frame({ name: 'body', dir: 'V', gap: o.gap || 'space/3', pad: [0, 20, 16, 20], sizeH: 'FILL' }, kids)]);
}
function podPair(label, value, o) {
  o = o || {};
  return frame({ name: 'pair · ' + label, dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [text(label, o.strong ? 'Body/Strong' : 'Body/Default', o.strong ? 'text/primary' : 'text/secondary', { sizeH: 'FILL' }), text(value, o.strong ? 'Body/Strong' : 'Body/Default', o.tone || 'text/primary')]);
}
function podRule() { return rect({ name: 'divider', w: 10, h: 1, fill: 'border/row', sizeH: 'FILL' }); }
function podColumns(main, side) {
  return frame({ name: 'Detail layout', dir: 'H', gap: 'space/5', align: 'start', sizeH: 'FILL' }, [frame({ name: 'main', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, main), frame({ name: 'side', dir: 'V', gap: 'space/4', w: 360 }, side)]);
}
function podBack(label) { return inst('Button', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Label: label, 'Leading icon': true, Icon: { icon: 'chevron-left' } }, { name: 'back' }); }
function podHeader(title, badges, sub, right, back) {
  const t = frame({ name: 'Title', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [frame({ name: 'title-row', dir: 'H', gap: 'space/3', align: 'center' }, [text(title, 'Heading/H1')].concat(badges)), text(sub, 'Body/Default', 'text/muted')]);
  return frame({ name: 'Page header', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [podBack(back), frame({ name: 'row', dir: 'H', align: 'end', gap: 'space/3', sizeH: 'FILL' }, [t, frame({ name: 'Actions', dir: 'H', gap: 'space/2', align: 'center' }, right)])]);
}
// One order line: picture, name, quantity × price, line total; an optional action or state on the end side.
function podLine(l, o) {
  o = o || {};
  const unavailable = o.unavailable;
  const name = frame({ name: 'line-text', dir: 'V', sizeH: 'FILL' }, [text(l[0], 'Body/Strong', unavailable ? 'text/muted' : 'text/primary', { sizeH: 'FILL', truncate: true }), text(l[1] + ' × ' + l[2], 'Caption/Default', 'text/muted')]);
  const end = [];
  if (unavailable) end.push(bdg('Neutral', 'Icon', unavailable, 'ban'));
  if (o.action) end.push(o.action);
  end.push(text(l[3], 'Body/Strong', unavailable ? 'text/muted' : 'text/primary', { name: 'line-total' }));
  return frame({ name: 'line · ' + l[0], dir: 'H', gap: 'space/3', align: 'center', py: 'space/2', sizeH: 'FILL' }, [inst('ProductThumb', { Category: l[4], Size: 'Sm' }, { name: 'image' }), name].concat(end));
}
// Delivery steps: done steps carry a check, the current one is bold, later ones are muted.
function podSteps(list, current) {
  const kids = [];
  list.forEach(function (s, i) {
    const done = i < current, on = i === current;
    if (i) kids.push(rect({ name: 'line', w: 10, h: 2, fill: done || on ? 'action/primary' : 'border/default', sizeH: 'FILL' }));
    const mark = done ? frame({ name: 'mark', dir: 'H', w: 18, h: 18, align: 'center', justify: 'center', radius: 'radius/pill', fill: 'action/primary' }, [icon('check', 'text/on-accent', 12)])
      : frame({ name: 'mark', dir: 'H', w: 18, h: 18, radius: 'radius/pill', fill: on ? 'bg/surface' : 'bg/subtle', stroke: on ? 'action/primary' : 'border/default', strokeW: on ? 2 : 1 });
    kids.push(frame({ name: 'step · ' + s[0], dir: 'V', gap: 'space/1', align: 'center' }, [mark, text(s[0], on ? 'Caption/Strong' : 'Caption/Default', done || on ? 'text/primary' : 'text/muted'), text(s[1] || ' ', 'Caption/Default', 'text/muted')]));
  });
  return frame({ name: 'steps', dir: 'H', gap: 'space/2', align: 'start', pad: ['space/2', 0, 'space/2', 0], sizeH: 'FILL' }, kids);
}
function podActivity(items, o) {
  o = o || {};
  return podCard('Activity', items.map(function (a) {
    return frame({ name: 'event', dir: 'H', gap: 'space/3', align: 'start', sizeH: 'FILL' }, [text(a[0], 'Caption/Default', 'text/muted', { w: 64 }), frame({ name: 'event-text', dir: 'V', sizeH: 'FILL' }, [text(a[1], 'Body/Default', 'text/primary', { sizeH: 'FILL' }), a[2] ? text(a[2], 'Caption/Default', 'text/muted', { sizeH: 'FILL' }) : null])]);
  }), { right: o.filter ? [inst('Select', { State: 'Filled', Value: 'All events' }, { name: 'event-filter', w: 150 })] : [] });
}
function podNotes(who, list, draft) {
  const kids = list.map(function (n) { return frame({ name: 'note', dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text(n[0], 'Body/Default', 'text/primary', { sizeH: 'FILL' }), text(n[1], 'Caption/Default', 'text/muted')]); });
  kids.push(psTextarea(draft || 'Add a note', draft ? 'Filled' : 'Default'), frame({ name: 'note-actions', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(who, 'Caption/Default', 'text/muted', { sizeH: 'FILL' }), btn('Add note', 'Secondary', 'Sm', draft ? {} : { State: 'Disabled' })]));
  return podCard('Notes', kids);
}

// ---- Admin
const POD_A = [['Lamb cutlets 500 g', '2', 'A$15.50', 'A$31.00', 'Meat'], ['Beef mince 1 kg', '1', 'A$14.50', 'A$14.50', 'Meat']];
const POD_B = [['Turkish bread loaf', '3', 'A$4.50', 'A$13.50', 'Bakery']];
const POD_COURIER = [['Ready', '9:40 am'], ['Picked up', '10:05 am'], ['On the way', 'Uber Direct'], ['Delivered', '']];
const POD_PICKUP = [['Paid', '9:12 am'], ['Ready', 'by 2:50 pm'], ['Collected', '']];
// One seller order: header with the store, delivery, steps, lines, totals with commission, and the Refund button.
function podSellerPart(o) {
  const head = frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', pad: [16, 20, 8, 20], sizeH: 'FILL' }, [
    inst('IdentityTile', { Tone: o.tone || 'Teal', Shape: 'Rounded', Initials: o.initials }, { name: 'store' }),
    frame({ name: 'store-text', dir: 'V', sizeH: 'FILL' }, [text(o.store, 'Heading/H2'), text(o.sub, 'Caption/Default', 'text/muted')]),
    o.badge, o.refund === false ? null : btn('Refund…', 'Secondary', 'Sm', { State: o.refundOff ? 'Disabled' : 'Default' }), ppIconButton('more-horizontal', 'part-menu')]);
  const lines = frame({ name: 'lines', dir: 'V', sizeH: 'FILL' }, o.lines.map(function (l, i) { return podLine(l, { unavailable: (o.unavailable || {})[i] }); }));
  const totals = frame({ name: 'totals', dir: 'V', gap: 'space/1-5', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, o.totals.map(function (t) { return podPair(t[0], t[1], { strong: t[2], tone: t[3] }); }));
  return card(o.store, [head, frame({ name: 'body', dir: 'V', gap: 'space/3', pad: [0, 20, 16, 20], sizeH: 'FILL' }, [o.steps, o.tracking ? text(o.tracking, 'Body/Small', 'text/secondary', { sizeH: 'FILL' }) : null, lines, totals])]);
}
function podPartA(o) {
  o = o || {};
  return podSellerPart({ store: 'Al-Noor Butcher', initials: 'AN', sub: 'Seller order 1 of 2 · Courier', badge: bdg(o.refunded ? 'Neutral' : 'Info', 'Dot', o.refunded ? 'Partly refunded' : 'On the way'), refundOff: o.refundOff,
    steps: podSteps(POD_COURIER, 2), tracking: 'Uber Direct · tracking UD-88213 · arriving 2:41 pm', lines: POD_A,
    totals: [['Subtotal', 'A$45.50'], ['Delivery', 'A$7.90'], ['GST included', 'A$4.85'], ['Seller order total', 'A$53.40', true]].concat(o.refunded ? [['Refunded', '− A$15.50', false, 'status/critical/fg']] : [], [['Commission (12%)', 'A$6.34'], ['Seller earns', o.refunded ? 'A$33.42' : 'A$47.06', true]]) });
}
function podPartB(o) {
  o = o || {};
  return podSellerPart({ store: 'Sunrise Bakery', initials: 'SB', tone: 'Amber', sub: 'Seller order 2 of 2 · Pickup', badge: bdg(o.ready ? 'Info' : 'Attention', 'Dot', o.ready ? 'Ready for pickup' : 'Waiting for the shop'), refundOff: o.refundOff,
    steps: podSteps(POD_PICKUP, o.ready ? 2 : 1), lines: POD_B, totals: [['Subtotal', 'A$13.50'], ['Pickup', 'Free'], ['GST included', 'A$0.00'], ['Seller order total', 'A$13.50', true], ['Commission (12%)', 'A$1.62'], ['Seller earns', 'A$11.88', true]] });
}
function podPayment(o) {
  o = o || {};
  const kids = [podPair('Card · Visa ending 4242', 'A$66.90 paid', { strong: true }), text('Stripe reference pi_3Q7…a81 · paid 31 Oct, 9:12 am', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })];
  if (o.refunds) o.refunds.forEach(function (r) { kids.push(frame({ name: 'refund', dir: 'H', gap: 'space/2', align: 'center', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [icon('undo', 'icon/default', 16), frame({ name: 'refund-text', dir: 'V', sizeH: 'FILL' }, [text(r[0], 'Body/Strong'), text(r[1], 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]), text(r[2], 'Body/Strong', 'status/critical/fg')])); });
  else kids.push(text('No refunds', 'Body/Small', 'text/muted'));
  kids.push(podRule(), frame({ name: 'documents', dir: 'H', gap: 'space/2', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, [ppLink('Tax invoice', 'download', 'tax-invoice'), ppLink('2 seller invoices', 'download', 'seller-invoices')].concat(o.refunds ? [ppLink('Adjustment note', 'download', 'adjustment-note')] : [])));
  return podCard('Payment and refunds', kids, { badge: bdg(o.refunds ? 'Neutral' : 'Success', 'Dot', o.refunds ? 'Partly refunded' : 'Paid') });
}
const POD_EVENTS = [['11:20 am', 'Dispute opened by the customer', 'Al-Noor Butcher · Item not as described'], ['10:05 am', 'Courier picked up Al-Noor Butcher’s part', 'Uber Direct'], ['9:40 am', 'Al-Noor Butcher marked their part ready', 'Rami S.'], ['9:13 am', 'Confirmation email sent to the customer'], ['9:12 am', 'Order placed and paid', 'Card · A$66.90']];
function podCustomer() {
  return podCard('Customer', [frame({ name: 'who', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [inst('IdentityTile', { Tone: 'Teal', Shape: 'Circle', Initials: 'SK' }), frame({ name: 'name', dir: 'V', sizeH: 'FILL' }, [text('Sara Karimi', 'Body/Strong'), text('3 orders · customer since Aug 2026', 'Caption/Default', 'text/muted')])]),
    podPair('Email', 'sara.k@example.com'), podPair('Phone', '0412 345 678'), ppLink('Open customer', 'user', 'open-customer')]);
}
function podAddress() {
  return podCard('Delivery address', [text('Sara Karimi', 'Body/Strong'), text('12 Sample Street, Toowong QLD 4066', 'Body/Default', 'text/primary', { sizeH: 'FILL' }), text('Courier window today, 2–4 pm · Pickup at Sunrise Bakery, Sunnybank', 'Caption/Default', 'text/muted', { sizeH: 'FILL' }), text('The address can’t be changed after payment.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]);
}
function podMoreButton(open) { const b = btn('More', 'Secondary', 'Md', { State: open ? 'Focus' : 'Default', 'Trailing icon': true }); b.name = 'more-button'; return b; }
function podAdminHeader(o) {
  o = o || {};
  const badges = [bdg(o.cancelled ? 'Neutral' : 'Success', 'Dot', o.cancelled ? 'Cancelled and refunded' : 'Paid')].concat(o.dispute ? [bdg('Critical', 'Icon', '1 open dispute', 'alert-triangle')] : []);
  return podHeader('Order #AU-10482', badges, 'Placed 31 Oct 2026, 9:12 am · 2 sellers · A$66.90 · Brisbane time (AEST)', [btn('Copy order ID', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'copy' } }), podMoreButton(o.open)], 'Orders');
}
function podDispute() { return inst('InfoBanner', { Tone: 'Critical', Title: 'Open dispute on Al-Noor Butcher’s part', Body: 'The customer says an item was not as described. The seller’s payout for this part is on hold until the dispute is decided.', 'Show action': true, Action: 'Open dispute' }, { name: 'dispute', sizeH: 'FILL' }); }
function podAdminSide(o) { o = o || {}; return [podCustomer(), podAddress(), podNotes('Only admins see these notes.', [['Customer called: the bread is for a party at 4 pm, please keep it ready.', 'Reza M. · 10:30 am']], o.draft)]; }
function podAdminDefault() {
  return podScreen('Admin', 'Default', 'Orders / #AU-10482', [podAdminHeader({ dispute: true }), podDispute(), podColumns([podPartA(), podPartB(), podPayment(), podActivity(POD_EVENTS, { filter: true })], podAdminSide())]);
}
// More menu before any seller has marked ready: Cancel and refund is open.
function podMoreMenu(canCancel) {
  const cancel = inst('MenuItem', { State: canCancel ? 'Destructive' : 'Disabled', Label: 'Cancel and refund order…', 'Leading icon': true, Icon: { icon: 'ban' }, 'Show description': true, Description: canCancel ? 'Nobody has packed anything yet' : 'A seller has marked their part ready. Refund each seller order instead.' }, { name: 'action · cancel', sizeH: 'FILL' });
  return ppPopover('More menu (open)', 320, [frame({ name: 'items', dir: 'V', sizeH: 'FILL' }, [ppActionItem('Default', 'Print order summary', 'printer'), ppActionItem('Default', 'Open in audit log', 'file-text'), cancel])]);
}
function podAdminNotReady(open) {
  const scr = podScreen('Admin', open ? 'Nothing packed yet, More open' : 'Nothing packed yet', 'Orders / #AU-10490', [
    podHeader('Order #AU-10490', [bdg('Success', 'Dot', 'Paid')], 'Placed 31 Oct 2026, 1:02 pm · 1 seller · A$27.00 · Brisbane time (AEST)', [btn('Copy order ID', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'copy' } }), podMoreButton(open)], 'Orders'),
    podColumns([podSellerPart({ store: 'Sunrise Bakery', initials: 'SB', tone: 'Amber', sub: 'Seller order 1 of 1 · Pickup', badge: bdg('Attention', 'Dot', 'Waiting for the shop'), steps: podSteps(POD_PICKUP, 1), lines: [['Turkish bread loaf', '6', 'A$4.50', 'A$27.00', 'Bakery']], totals: [['Seller order total', 'A$27.00', true], ['Commission (12%)', 'A$3.24'], ['Seller earns', 'A$23.76', true]] }), podPayment(), podActivity([['1:03 pm', 'Confirmation email sent to the customer'], ['1:02 pm', 'Order placed and paid', 'Card · A$27.00']])], podAdminSide())]);
  if (open) ppUnder(scr, 'more-button', podMoreMenu(true), true);
  return scr;
}
function podAdminMoreBlocked() {
  const scr = podScreen('Admin', 'A seller marked ready, More open', 'Orders / #AU-10482', [podAdminHeader({ open: true }), podColumns([podPartA(), podPartB()], podAdminSide())]);
  ppUnder(scr, 'more-button', podMoreMenu(false), true);
  return scr;
}
// Dialogs: cancel and refund the whole order; refund part of one seller order.
function podField(label, node, help) { return frame({ name: 'field · ' + label, dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [text(label, 'Body/Strong'), node].concat(help ? [text(help, 'Caption/Default', 'text/muted', { sizeH: 'FILL' })] : [])); }
function podDialog(name, title, kids, primary, tone) {
  return frame({ name: name, dir: 'V', w: 520, pad: 'space/6', gap: 'space/4', fill: 'bg/surface', radius: 'radius/card', effect: 'Elevation/Floating' }, [text(title, 'Heading/H2', 'text/primary', { sizeH: 'FILL' })].concat(kids, [frame({ name: 'footer', dir: 'H', gap: 'space/2', justify: 'end', sizeH: 'FILL' }, [btn('Cancel', 'Secondary', 'Md', { State: tone === 'Destructive' ? 'Focus' : 'Default' }), btn(primary, tone === 'Destructive' ? 'Destructive' : 'Primary', 'Md')])]));
}
function podCancelDialog() {
  return podDialog('Cancel and refund order', 'Cancel and refund order #AU-10490?', [
    text('Sunrise Bakery hasn’t packed anything yet. The customer gets A$27.00 back on the card they paid with, and an email. You can’t undo this.', 'Body/Default', 'text/secondary', { sizeH: 'FILL' }),
    podField('Reason', inst('Select', { State: 'Filled', Value: 'Customer asked to cancel' }, { name: 'reason', sizeH: 'FILL' }), 'The customer and the seller see the reason.'),
    podField('Note for the audit log (optional)', psTextarea('Called support at 1:20 pm, ordered by mistake.'))], 'Cancel and refund', 'Destructive');
}
function podRefundDialog() {
  const lineRow = function (l, on, qty) { return frame({ name: 'refund line · ' + l[0], dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [inst('Checkbox', { Value: on ? 'Checked' : 'Unchecked', State: 'Default' }, { name: 'pick' }), text(l[0], 'Body/Default', 'text/primary', { sizeH: 'FILL' }), inst('Select', { State: on ? 'Filled' : 'Disabled', Value: qty + ' of ' + l[1] }, { name: 'qty', w: 110 }), text(on ? 'A$15.50' : 'A$0.00', 'Body/Strong', 'text/primary', { w: 70 })]); };
  return podDialog('Refund seller order', 'Refund Al-Noor Butcher’s part', [
    frame({ name: 'lines', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [lineRow(POD_A[0], true, '1'), lineRow(POD_A[1], false, '0'), frame({ name: 'delivery', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [inst('Checkbox', { Value: 'Unchecked', State: 'Default' }, { name: 'pick' }), text('Delivery fee', 'Body/Default', 'text/primary', { sizeH: 'FILL' }), text('A$7.90', 'Body/Default', 'text/muted', { w: 70 })])]),
    podField('Reason', inst('Select', { State: 'Filled', Value: 'Item not as described' }, { name: 'reason', sizeH: 'FILL' })),
    frame({ name: 'summary', dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [podPair('Refund to the card', 'A$15.50', { strong: true }), text('GST A$1.41 is reversed with an adjustment note. The seller’s earnings go down by A$13.64 and the commission by A$1.86.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })])], 'Refund A$15.50');
}
function podAdminDialogs() { return podTag(dialogScene(POD + ' · Admin · Dialogs', [podCancelDialog(), podRefundDialog()])); }
function podAdminRefunded() {
  return podScreen('Admin', 'After a part refund', 'Orders / #AU-10482', [podAdminHeader({}), podColumns([podPartA({ refunded: true }), podPartB({ ready: true }), podPayment({ refunds: [['Lamb cutlets 500 g × 1', 'Al-Noor Butcher · Item not as described · Reza M., 12:05 pm', '− A$15.50']] }),
    podActivity([['12:05 pm', 'Refund of A$15.50 on Al-Noor Butcher’s part', 'Reza M. · Item not as described'], ['12:04 pm', 'Dispute closed', 'Refunded the customer']].concat(POD_EVENTS.slice(1)), { filter: true })], podAdminSide({ draft: 'Refunded one pack of lamb after the customer sent a photo.' }))]);
}

// ---- Seller
const POD_S = [['Lamb cutlets 500 g', '2', 'A$15.50', 'A$31.00', 'Meat'], ['Beef mince 1 kg', '1', 'A$14.50', 'A$14.50', 'Meat'], ['Chicken wings 1 kg', '1', 'A$9.90', 'A$9.90', 'Poultry']];
function podNext(title, body, action, tone) {
  return frame({ name: 'Next step', dir: 'H', gap: 'space/4', align: 'center', pad: 'space/5', fill: tone === 'done' ? 'status/success/bg' : 'bg/info-banner', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [frame({ name: 'next-text', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(title, 'Heading/H2'), text(body, 'Body/Default', 'text/secondary', { sizeH: 'FILL' })])].concat(action ? [action] : []));
}
function podSellerHeader(badge) {
  return podHeader('Order MP-10482', [badge], 'Paid 31 Oct 2026, 9:12 am · Brisbane time (AEST)', [btn('Print packing slip', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'printer' } })], 'Orders');
}
function podSellerItems(o) {
  o = o || {};
  const unav = o.unavailable || {};
  return podCard('Items', POD_S.map(function (l, i) {
    const act = o.canMark && !unav[i] ? btn('Mark unavailable', 'Ghost', 'Sm') : null; act && (act.name = 'mark-unavailable');
    return podLine(l, { unavailable: unav[i], action: act });
  }), { gap: 'space/1', badge: text(o.count || '4 items', 'Body/Small', 'text/muted') });
}
function podSellerTotals(o) {
  o = o || {};
  const rows = [['Subtotal', o.cut ? 'A$45.50' : 'A$55.40'], ['Delivery', 'A$7.90'], ['GST included', o.cut ? 'A$4.85' : 'A$5.75'], ['Order total', o.cut ? 'A$53.40' : 'A$63.30', true]].concat(o.cut ? [['Refunded to the customer', '− A$9.90', false, 'status/critical/fg']] : [], [['Commission (12%)', o.cut ? 'A$6.41' : 'A$7.60'], ['You earn', o.cut ? 'A$46.99' : 'A$55.70', true]]);
  return podCard('Totals', rows.map(function (t) { return podPair(t[0], t[1], { strong: t[2], tone: t[3] }); }), { gap: 'space/1-5' });
}
function podSellerSide(events, o) {
  o = o || {};
  return [podCard('Customer', [text('Sara', 'Body/Strong'), text('Toowong QLD 4066', 'Body/Default', 'text/secondary'), text('The courier gets the full address. You see it only when you deliver yourself.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]),
    podCard('Delivery', [podPair('Method', 'Courier'), podPair('Window', 'Today, 2–4 pm'), text('MondaPac books the courier when you mark the order ready.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]),
    podNotes('Only your team sees these notes.', o.notes || [], o.draft), podActivity(events)];
}
function podSellerToShip() {
  return podScreen('Seller', 'To ship', 'Orders / MP-10482', [podSellerHeader(bdg('Attention', 'Dot', 'To ship')), podColumns([podNext('Pack 4 items by 2:30 pm', 'When everything is packed, mark the order ready. The courier arrives about 10 minutes later.', btn('Mark ready', 'Primary', 'Md')), podSellerItems({ canMark: true }), podSellerTotals()],
    podSellerSide([['9:13 am', 'New order email sent to you'], ['9:12 am', 'Order paid']], { draft: 'Use the thicker bags for the lamb.' }))]);
}
function podUnavailableDialog() {
  return podDialog('Mark unavailable', 'Mark Chicken wings 1 kg unavailable?', [
    podField('How many can’t you send?', inst('Select', { State: 'Filled', Value: '1 of 1' }, { name: 'qty', sizeH: 'FILL' })),
    frame({ name: 'summary', dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [podPair('Refunded to the customer now', 'A$9.90', { strong: true }), text('The customer gets an email with the refund. You can’t undo this, and the rest of the order stays as it is.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]),
    text('If nothing in the order can be sent, contact support instead.', 'Body/Small', 'text/muted', { sizeH: 'FILL' })], 'Mark unavailable and refund', 'Destructive');
}
function podSellerUnavailableOpen() {
  const scr = podSellerToShip();
  scr.name = POD + ' · Seller · Mark unavailable';
  add(scr, frame({ name: 'scrim', w: 1440, h: PANEL_MIN_H, fill: 'bg/scrim', abs: [0, 0] }));
  const d = podUnavailableDialog(); setMeta(d, { abs: [460, 160] }); add(scr, d);
  return scr;
}
function podSellerAfterUnavailable() {
  return podScreen('Seller', 'After an item was unavailable', 'Orders / MP-10482', [podSellerHeader(bdg('Attention', 'Dot', 'To ship')), podColumns([podNext('Pack 3 items by 2:30 pm', 'Chicken wings 1 kg was refunded to the customer. Pack the rest, then mark the order ready.', btn('Mark ready', 'Primary', 'Md')), podSellerItems({ canMark: true, unavailable: { 2: 'Unavailable · refunded' }, count: '3 of 4 items' }), podSellerTotals({ cut: true })],
    podSellerSide([['9:52 am', 'Chicken wings 1 kg marked unavailable', 'Rami S. · A$9.90 refunded, customer told'], ['9:13 am', 'New order email sent to you'], ['9:12 am', 'Order paid']]))]);
}
function podSellerPickup() {
  const boxes = frame({ name: 'code', dir: 'H', gap: 'space/2', align: 'center' }, [0, 1, 2, 3].map(function () { return frame({ name: 'digit', dir: 'H', w: 48, h: 56, fill: 'bg/surface', stroke: 'border/input', radius: 'radius/control' }); }));
  return podScreen('Seller', 'Pickup: waiting for the customer', 'Orders / MP-10490', [podHeader('Order MP-10490', [bdg('Info', 'Dot', 'Ready for pickup')], 'Paid 31 Oct 2026, 1:02 pm · Brisbane time (AEST)', [btn('Print packing slip', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'printer' } })], 'Orders'),
    podColumns([podNext('Hand over when the customer arrives', 'Ask for their 4-digit pickup code and type it here. After 5 wrong tries the order locks until the customer gets a new code.', frame({ name: 'handover', dir: 'H', gap: 'space/3', align: 'center' }, [boxes, btn('Confirm pickup', 'Primary', 'Md', { State: 'Disabled' })])),
      podCard('Items', [podLine(['Turkish bread loaf', '6', 'A$4.50', 'A$27.00', 'Bakery'])], { gap: 'space/1' })],
    [podCard('Customer', [text('Hana', 'Body/Strong'), text('Collects at your shop, Sunnybank', 'Body/Default', 'text/secondary')]), podActivity([['1:40 pm', 'You marked the order ready', 'Customer told by email'], ['1:02 pm', 'Order paid']])])]);
}
function podSellerDone() {
  return podScreen('Seller', 'Delivered', 'Orders / MP-10476', [podHeader('Order MP-10476', [bdg('Success', 'Dot', 'Delivered')], 'Paid 30 Oct 2026, 6:31 pm · Brisbane time (AEST)', [btn('Print packing slip', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'printer' } })], 'Orders'),
    podColumns([podNext('Delivered at 7:42 pm', 'Your earnings are paid in the next payout, on 4 Nov.', null, 'done'), podCard('Items', [podLine(POD_S[0]), podLine(POD_S[1])], { gap: 'space/1' }), podSellerTotals()],
    [podActivity([['7:42 pm', 'Delivered', 'Uber Direct · photo at the door'], ['7:05 pm', 'Courier picked up'], ['6:50 pm', 'You marked the order ready'], ['6:31 pm', 'Order paid']])])]);
}

// ---- States
function podStates() {
  const lbl = function (s) { return text(s, 'Caption/Strong', 'text/muted'); };
  const b = function (name, tone, title, body, action) { return inst('InfoBanner', Object.assign({ Tone: tone, Title: title, Body: body, 'Show action': !!action }, action ? { Action: action } : {}), { name: name, sizeH: 'FILL' }); };
  const noAccess = inst('EmptyState', { Size: 'Card', Title: 'You don’t have access to this order', Body: 'Orders need the permission "View orders". An admin who manages roles can add it.', Icon: { icon: 'lock' } }, { name: 'no-access', sizeH: 'FILL' });
  const scr = frame({ name: POD + ' · States', dir: 'V', w: 1000, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Order detail: states and messages', 'Heading/H1'),
    para('Admins see every seller order and the customer’s contact details only with the permission to view customer accounts. A seller sees only its own part, the customer’s first name and suburb, and the full address only when it delivers itself. Each role’s activity shows only its own events; notes of admins and of sellers stay apart.', 920),
    lbl('Could not load'), b('load-error', 'Critical', 'This order could not be loaded', 'Try again. If it keeps happening, check the status page.', 'Try again'),
    lbl('No access'), noAccess,
    lbl('Refunds switched off in this market (Refund buttons disabled)'), b('refunds-off', 'Info', 'Refunds are off in this market', 'Turn them on in Settings › Money when the tax agent has signed off. Until then, contact the payments team.'),
    lbl('Cancel no longer possible'), b('cancel-blocked', 'Attention', 'A seller has started on this order', 'Sunrise Bakery marked their part ready at 1:40 pm, so the order can’t be cancelled as a whole. Refund each seller order instead.'),
    lbl('Seller: marking unavailable after Mark ready'), b('unavailable-closed', 'Info', 'The order is already marked ready', 'Items can be marked unavailable only before you mark the order ready. Contact support if something is missing.'),
    lbl('Toasts'), frame({ name: 'toasts', dir: 'H', gap: 'space/4', wrap: true, rowGap: 'space/3', sizeH: 'FILL' }, [psToast('Success', 'Order #AU-10490 cancelled. A$27.00 refunded.'), psToast('Success', 'Refunded A$15.50.'), psToast('Success', 'Chicken wings marked unavailable. A$9.90 refunded.'), psToast('Success', 'Order ID copied.')])]);
  tag(scr); return podTag(scr);
}

PROPOSALS['order-detail'] = { title: POD, rows: function () {
  return [[podAdminDefault(), podAdminNotReady(true), podAdminMoreBlocked()], [podAdminDialogs(), podAdminRefunded()],
    [podSellerToShip(), podSellerUnavailableOpen(), podSellerAfterUnavailable()], [podSellerPickup(), podSellerDone(), podStates()]];
} };
