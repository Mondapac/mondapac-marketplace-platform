// ---- Phone templates (360 × 780, release 1.5.0, D16): PhoneTopbar (56 px), bottom tab bar (seller), drawer over a bg/scrim scrim (1.6.0)
function phoneTopbar(ws) { return inst('PhoneTopbar', { Workspace: ws }, { name: 'PhoneTopbar', sizeH: 'FILL' }); } // release 1.6.0: an instance, no longer a loose frame
// 1.8.4: Main scrolls vertically, as the page does on a phone. A list longer than the screen is cut at the bottom on purpose
// (it continues below the fold), and the Audit does not count that as a layer sticking out.
function phoneScreen(name, ws, kids, barActive) {
  const main = frame({ name: 'Main', dir: 'V', gap: 'space/3', pad: 'space/4', sizeH: 'FILL', sizeV: 'FILL', clip: true }, kids);
  main.overflowDirection = 'VERTICAL';
  const parts = [phoneTopbar(ws), main];
  if (barActive) parts.push(inst('BottomTabBar', { Active: barActive, Tabs: '4' }, { name: 'BottomTabBar', sizeH: 'FILL' }));
  const scr = frame({ name: name, dir: 'V', w: 360, h: 780, fill: 'bg/page', clip: true }, parts);
  tag(scr);
  return scr;
}
function withDrawer(scr, ws) {
  add(scr, frame({ name: 'scrim', w: 360, h: 780, fill: 'bg/scrim', abs: [0, 0] }));
  add(scr, inst('NavDrawer', { Workspace: ws }, { name: 'NavDrawer', abs: [0, 0] }));
  return scr;
}
function phoneSellerBody() {
  return [
    frame({ name: 'Page header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text('Good afternoon, Yusuf', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), text('Thursday 1 Oct 2026 · 2:30 pm AEST', 'Body/Default', 'text/muted', { sizeH: 'FILL' })]),
    stageCard('Needs action', '3', 'Oldest waiting 9 min', 3, 'status/attention/solid', true),
    stageCard('Preparing', '5', 'Next ready by 2:48 pm', 5, 'action/primary'),
    frame({ name: 'Order MP-10482', dir: 'V', gap: 'space/2', pad: 'space/4', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [
      frame({ name: 'head', dir: 'H', gap: 'space/2', justify: 'between', align: 'center', sizeH: 'FILL' }, [text('MP-10482', 'Mono/Default'), text('Waiting 9 min', 'Caption/Strong', 'status/critical/fg')]),
      text('Lamb cutlets, beef mince, chicken wings', 'Body/Small', 'text/secondary', { sizeH: 'FILL' }),
    ]),
  ];
}
function tplSellerPhoneHome() { return phoneScreen('Seller · Home (phone)', 'Seller', phoneSellerBody(), 'Home'); }
function tplSellerPhoneMenu() { return withDrawer(phoneScreen('Seller · Menu open (phone)', 'Seller', phoneSellerBody(), 'More'), 'Seller'); }
function tplAdminPhoneMenu() {
  const kids = [
    frame({ name: 'Page header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text('Good afternoon, Layla', 'Heading/H1', 'text/primary', { sizeH: 'FILL' }), text('35 items waiting for review', 'Body/Default', 'text/muted', { sizeH: 'FILL' })]),
    inst('QueueCard', { Tone: 'Overdue', Title: 'Certifications', Count: '4' }, { sizeH: 'FILL' }),
    inst('QueueCard', { Tone: 'On track', Title: 'Seller applications', Count: '6', Oldest: 'Oldest 2 days of 3' }, { sizeH: 'FILL' }),
  ];
  return withDrawer(phoneScreen('Admin · Menu open (phone)', 'Admin', kids, null), 'Admin');
}
