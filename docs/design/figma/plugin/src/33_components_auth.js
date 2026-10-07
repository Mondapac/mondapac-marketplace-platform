// ---------------------------------------------------------------- release 1.7.0 "Auth" components (identity ux.md section 4, planned there as 1.1.0)
// BrandMark, Field, ReasonQuote, MenuItem + Menu and AuthShowcase. Built by "Build library" on their library pages and
// added to an existing file by "Update library" (see 50_main.js). Each block function returns the new set or component.

// ---- BrandMark (Navigation & shell): the mark plus the MondaPac wordmark and the panel name
function brandMarkBlock(root) {
  const bm = makeComponent('BrandMark', function (c) {
    const mark = brandMark(30); mark.name = 'mark';
    body(c, { dir: 'H', gap: 'space/2-5', align: 'center' }, [
      mark,
      frame({ name: 'wordmark', dir: 'V' }, [text('MondaPac', 'Heading/H2', 'text/primary', { name: 'brand-name' }), text('Admin', 'Caption/Overline', 'text/muted', { name: 'panel' })]),
    ]);
  }, { desc: 'The MondaPac mark (30 px, action/primary with the letter M), the wordmark and the panel name. Used by the Sidebar header and at the top of the form column on every Auth screen. Panel is the panel name (Admin or Seller Centre); Show wordmark off leaves the mark alone (collapsed sidebar); Show panel off leaves the wordmark without the panel line. Decorative next to a visible panel name; otherwise the link around it is named "MondaPac home".',
    text: [{ prop: 'Panel', node: 'panel', def: 'Admin' }], bool: [{ prop: 'Show wordmark', node: 'wordmark', def: true }, { prop: 'Show panel', node: 'panel', def: true }] });
  const wrap = frame({ name: 'BrandMark', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(wrap, bm);
  componentBlock(root, wrap, { title: 'BrandMark', summary: 'One brand mark for the Sidebar and the Auth template (1.7.0). A Sidebar in a file updated from an earlier release keeps its drawn mark; a new build uses this instance.',
    props: ['Panel (text): Admin or Seller Centre', 'Show wordmark (boolean)', 'Show panel (boolean)'],
    a11y: ['The mark is decorative when the panel name is visible next to it.', 'As a home link it is named "MondaPac home".'] });
  return bm;
}

// ---- Field (Forms & selection): label, optional mark, the control slot, helper, counter and error
function fieldBlock(root) {
  const control = S.sets.Input.set.children.filter(function (v) { const vp = v.variantProperties; return vp.State === 'Default' && (vp.Type === undefined || vp.Type === 'Text'); })[0];
  const f = makeComponent('Field', function (c) {
    body(c, { dir: 'V', w: 360, gap: 'space/1-5' }, [
      frame({ name: 'label-row', dir: 'H', gap: 'space/1', align: 'center' }, [text('Email', 'Body/Strong', 'text/primary', { name: 'label' }), text('(optional)', 'Body/Default', 'text/muted', { name: 'optional' })]),
      inst('Input', { Type: 'Text', State: 'Default' }, { name: 'control', sizeH: 'FILL' }),
      frame({ name: 'helper-row', dir: 'H', gap: 'space/2', align: 'start', sizeH: 'FILL' }, [text('You’ll sign in with this email.', 'Caption/Default', 'text/muted', { name: 'helper', sizeH: 'FILL' }), text('0 / 500', 'Caption/Default', 'text/muted', { name: 'counter' })]),
      frame({ name: 'error', dir: 'H', gap: 'space/1-5', align: 'start', sizeH: 'FILL' }, [icon('alert-circle', 'status/critical/fg', 16), text('Enter your email.', 'Body/Small', 'status/critical/fg', { name: 'error-text', sizeH: 'FILL' })]),
    ]);
    c.children[3].children[0].name = 'error-icon';
    safe('expose control', function () { c.children[1].isExposedInstance = true; });
  }, { desc: 'A form field: Label, an optional "(optional)" mark, the control, a helper line, a character counter and an error message with an icon. Control is an INSTANCE_SWAP slot (exposed): it takes Input today and Select or Textarea from 1.2.0; set the nested Input\'s Type, State and Value from the Field instance. Show error goes with the control\'s State=Error. Accessibility: the label is a <label> for the control; helper and error are tied to it with aria-describedby and the control gets aria-invalid; errors are text with an icon, never colour alone; optional fields say "(optional)", no asterisks.',
    text: [{ prop: 'Label', node: 'label', def: 'Email' }, { prop: 'Helper', node: 'helper', def: 'You’ll sign in with this email.' }, { prop: 'Counter', node: 'counter', def: '0 / 500' }, { prop: 'Error', node: 'error-text', def: 'Enter your email.' }],
    bool: [{ prop: 'Optional', node: 'optional', def: false }, { prop: 'Show helper', node: 'helper', def: true }, { prop: 'Show counter', node: 'counter', def: false }, { prop: 'Show error', node: 'error', def: false }],
    swap: [{ prop: 'Control', node: 'control', comp: control }] });
  const wrap = frame({ name: 'Field', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(wrap, f);
  componentBlock(root, wrap, { title: 'Field', summary: 'Every form control in a form sits in a Field (1.7.0): the label above, helper and counter below, the error under the control.',
    use: ['Every input of the Auth screens and of forms inside the shell.', 'Turn on Show error together with the control\'s State=Error; the error summary above the form repeats it.'],
    props: ['Label, Helper, Counter, Error (text)', 'Optional, Show helper, Show counter, Show error (boolean)', 'Control (instance swap; Input now, Select and Textarea from 1.2.0)'],
    a11y: ['<label for>; helper and error via aria-describedby; aria-invalid on error.', 'Errors are not announced on each keystroke.', '"(optional)" instead of asterisks.'],
    dont: ['A placeholder instead of a label.', 'Colour alone for the error.'] });
  return f;
}

// ---- ReasonQuote (Review & detail): a reason written by MondaPac, quoted exactly
function reasonQuoteBlock(root) {
  const rq = makeComponent('ReasonQuote', function (c) {
    body(c, { dir: 'V', w: 480, pad: 'space/4', gap: 'space/2', fill: 'bg/subtle', stroke: 'border/default', radius: 'radius/card' }, [
      text('Reason from MondaPac', 'Body/Small Strong', 'text/secondary', { name: 'label' }),
      frame({ name: 'quote', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [rect({ name: 'bar', w: 3, h: 40, fill: 'border/input', radius: 2, sizeV: 'FILL' }), text('Your Halal certificate is not readable. Upload a clear copy of all pages, then contact us to continue.', 'Body/Default', 'text/primary', { name: 'reason', sizeH: 'FILL' })]),
      text('Written on 6 Oct 2026', 'Caption/Default', 'text/muted', { name: 'date' }),
    ]);
  }, { desc: 'A reason MondaPac wrote to a seller, shown exactly as written with its date (A10, S1, and the read-only state of D4). Plain text with dir="auto" and its line breaks; never shown to staff who are not the Seller Owner; no reviewer name.',
    text: [{ prop: 'Label', node: 'label', def: 'Reason from MondaPac' }, { prop: 'Reason', node: 'reason', def: 'Your Halal certificate is not readable. Upload a clear copy of all pages, then contact us to continue.' }, { prop: 'Date', node: 'date', def: 'Written on 6 Oct 2026' }] });
  const wrap = frame({ name: 'ReasonQuote', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(wrap, rq);
  componentBlock(root, wrap, { title: 'ReasonQuote', summary: 'The reason for a decision about a seller (1.7.0). Label, the text exactly as written, and the date.',
    props: ['Label, Reason, Date (text)'], a11y: ['The reason is a <blockquote> with dir="auto"; line breaks are kept.'], dont: ['Internal notes or the reviewer\'s name.', 'Reason text in a URL, a page title or telemetry.'] });
  return rq;
}

// ---- MenuItem + Menu (Navigation & shell): the account menu and row action menus
const MI = { Default: [null, 'text/primary', 'icon/default'], Hover: ['bg/subtle', 'text/primary', 'icon/default'], Focus: [null, 'text/primary', 'icon/default'], Disabled: [null, 'text/muted', 'icon/muted'], Destructive: [null, 'status/critical/fg', 'status/critical/fg'], Selected: ['bg/selected', 'text/link', 'text/link'] };
function menuItemVariant(c, p) {
  const t = MI[p.State];
  body(c, { dir: 'H', w: 264, pad: [8, 10, 8, 10], gap: 'space/2-5', align: 'start', fill: t[0], radius: 'radius/control' }, [
    icon('user', t[2], 18),
    frame({ name: 'text', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Account security', p.State === 'Selected' ? 'Body/Strong' : 'Body/Medium', t[1], { name: 'label', sizeH: 'FILL' }), text('Only the shop owner can do this.', 'Caption/Default', 'text/muted', { name: 'description', sizeH: 'FILL' })]),
    p.State === 'Selected' ? icon('check', 'text/link', 16) : null,
  ]);
  c.children[0].name = 'icon';
  if (p.State === 'Selected') c.children[2].name = 'check';
  if (p.State === 'Focus') focusRing(c);
}
function menuBlock(root, have) {
  let item = have.MenuItem;
  if (!item) {
    item = makeSet('MenuItem', { State: ['Default', 'Hover', 'Focus', 'Disabled', 'Destructive', 'Selected'] }, menuItemVariant, { width: 920, desc: 'One item of a Menu or of a Select list. Label, a leading icon and an optional description line. Disabled items stay focusable and give their reason on the description line, so it can be read on touch. Destructive is for actions such as Suspend…; Selected marks the chosen option of a Select (check icon, bg/selected). Focus uses the Focus/Ring effect.',
      text: [{ prop: 'Label', node: 'label', def: 'Account security' }, { prop: 'Description', node: 'description', def: 'Only the shop owner can do this.' }],
      bool: [{ prop: 'Leading icon', node: 'icon', def: true }, { prop: 'Show description', node: 'description', def: false }], swap: [{ prop: 'Icon', node: 'icon', def: 'user' }] });
  }
  const menu = makeComponent('Menu', function (c) {
    body(c, { dir: 'V', w: 280, pad: 'space/1-5', gap: 'space/0-5', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', effect: 'Elevation/Floating' }, [
      frame({ name: 'header', dir: 'V', pad: [8, 10, 8, 10], sizeH: 'FILL' }, [text('Yusuf Karimi', 'Body/Strong', 'text/primary', { name: 'title', sizeH: 'FILL', truncate: true }), text('Shop owner', 'Caption/Default', 'text/muted', { name: 'subtitle', sizeH: 'FILL', truncate: true })]),
      inst('MenuItem', { State: 'Default', Label: 'Account security', Icon: { icon: 'lock' } }, { name: 'item-1', sizeH: 'FILL' }),
      inst('MenuItem', { State: 'Default', Label: 'Help & resources', Icon: { icon: 'help-circle' } }, { name: 'item-2', sizeH: 'FILL' }),
      rect({ name: 'divider', w: 200, h: 1, fill: 'border/default', sizeH: 'FILL' }),
      inst('MenuItem', { State: 'Default', Label: 'Sign out', Icon: { icon: 'log-out' } }, { name: 'item-3', sizeH: 'FILL' }),
    ]);
    ['item-1', 'item-2', 'item-3'].forEach(function (n) { safe('expose ' + n, function () { c.findOne(function (x) { return x.name === n; }).isExposedInstance = true; }); });
  }, { desc: 'A floating menu: an optional header (the person and their role) and up to three MenuItem slots with a divider before the last. Items are exposed, so each one\'s State, Label, Icon and description are set from the Menu instance. Used as the account menu of the Topbar (Account security, Help & resources, Sign out) and for row actions. Accessibility: role="menu" on a button with aria-haspopup and aria-expanded; arrow keys move, Esc closes and focus returns to the trigger; a row menu button is named "Actions for {name}".',
    text: [{ prop: 'Title', node: 'title', def: 'Yusuf Karimi' }, { prop: 'Subtitle', node: 'subtitle', def: 'Shop owner' }],
    bool: [{ prop: 'Show header', node: 'header', def: true }, { prop: 'Show item 2', node: 'item-2', def: true }, { prop: 'Show divider', node: 'divider', def: true }] });
  const wrap = frame({ name: 'Menu · MenuItem', dir: 'H', gap: 'space/6', align: 'start' }, [have.MenuItem ? null : item, frame({ name: 'Menu', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }, [menu])]);
  componentBlock(root, wrap, { title: 'Menu · MenuItem', summary: 'The account menu (sign out) and row action menus (1.7.0). A disabled item says why on its description line.',
    props: ['MenuItem: Label, Description (text); Leading icon, Show description (boolean); Icon (instance swap); State', 'Menu: Title, Subtitle (text); Show header, Show item 2, Show divider (boolean); item-1 to item-3 exposed'],
    a11y: ['role="menu" and role="menuitem"; disabled items stay focusable and show their reason.', 'Esc closes the menu and focus returns to its button.'],
    dont: ['A disabled item without a reason.', 'More than one destructive item without a divider.'] });
  return menu;
}

// ---- AuthShowcase (Navigation & shell): the static brand panel beside the Auth form column (ux.md 3.0 rule 1, design 1A)
const SHOWCASE = {
  Admin: { fill: 'bg/auth-showcase-admin', pill: 'MondaPac Admin', title: 'The whole marketplace, at a glance.', lede: 'Review sellers and certificates before deadlines, follow sales and keep every decision on the record.' },
  Seller: { fill: 'bg/auth-showcase-seller', pill: 'MondaPac Seller Centre', title: 'Your shop, ready before the first order.', lede: 'See every order the moment it lands, prepare on time and show customers your verified Halal certificate.' },
};
function scCard(name, w, kids) { return frame({ name: name, dir: 'V', w: w, pad: 'space/4', gap: 'space/3', fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card', effect: 'Elevation/Floating' }, kids); }
function scLines(a, b) { return frame({ name: 'lines', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(a, 'Body/Strong', 'text/primary', { sizeH: 'FILL', truncate: true }), text(b, 'Caption/Default', 'text/muted', { sizeH: 'FILL', truncate: true })]); }
function scVerified(note, tile, tileIcon, tileToken, title, sub) {
  return [
    frame({ name: 'head', dir: 'H', gap: 'space/3', align: 'center', sizeH: 'FILL' }, [frame({ name: 'tile', dir: 'H', w: 36, h: 36, align: 'center', justify: 'center', fill: tile, radius: 'radius/pill' }, [icon(tileIcon, tileToken, 18)]), scLines(title, sub)]),
    frame({ name: 'proof', dir: 'H', gap: 'space/2', align: 'center' }, [inst('Badge', { Tone: 'Success', Leading: 'Icon', Label: 'Verified', Icon: { icon: 'check' } }), text(note, 'Caption/Default', 'text/muted')]),
  ];
}
// Two series on one scale: today (solid, chart/series-1) and the same day last week (dashed, chart/compare).
function scSparkline(w, h) {
  const today = [8, 10, 9, 12, 14, 13, 16, 18, 17, 21], before = [7, 8, 9, 9, 10, 11, 11, 12, 13, 13];
  const mn = 6, mx = 22; const pt = function (v, i) { return (2 + i * (w - 4) / (today.length - 1)).toFixed(1) + ' ' + (h - 2 - (v - mn) / (mx - mn) * (h - 4)).toFixed(1); };
  const f = frame({ name: 'sparkline', w: w, h: h }); f.fills = [];
  add(f, vector({ name: 'last week', d: 'M ' + before.map(pt).join(' L '), stroke: 'chart/compare', strokeW: 1.5, dash: [4, 3], xy: [0, 0] }));
  add(f, vector({ name: 'today', d: 'M ' + today.map(pt).join(' L '), stroke: 'chart/series-1', strokeW: 2, xy: [0, 0] }));
  return f;
}
function showcaseCards(ws) {
  if (ws === 'Admin') {
    const rows = [['CL', 'Teal', 'Cedar Lane Halal Meats', 'Halal certificate renewal', 'Critical', 'Due 2h'], ['OG', 'Amber', 'Olive Grove Bakehouse', 'New seller · ABN check', 'Attention', 'Today'], ['RP', 'Neutral', 'Riverbend Poultry Co.', 'Manufacturer certificate', 'Neutral', 'Tomorrow']];
    return [
      scCard('Review queue', 360, [frame({ name: 'head', dir: 'H', justify: 'between', align: 'center', sizeH: 'FILL' }, [text('Review queue', 'Body/Strong'), inst('Badge', { Tone: 'Attention', Leading: 'Dot', Label: '3 due today' })])].concat(rows.map(function (r) {
        return frame({ name: r[2], dir: 'H', gap: 'space/2-5', align: 'center', pad: [8, 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, [inst('IdentityTile', { Tone: r[1], Shape: 'Rounded', Initials: r[0] }), scLines(r[2], r[3]), inst('Badge', { Tone: r[4], Leading: 'None', Label: r[5] })]);
      }))),
      scCard('Sales today', 232, [text('Sales today', 'Body/Small Strong', 'text/secondary'), frame({ name: 'value', dir: 'H', gap: 'space/2', align: 'end' }, [text('18,420', 'Heading/Stat'), text('+12%', 'Body/Small Strong', 'status/success/fg')]), scSparkline(200, 48)]),
      scCard('Certificate approved', 300, scVerified('Logged to audit trail', 'status/success/bg', 'check', 'status/success/fg', 'Certificate approved', 'Halal · seller level')),
    ];
  }
  const items = [['Meat', 'Lamb shoulder', '1.5 kg'], ['Poultry', 'Chicken thigh fillet', '2 kg'], ['Bakery', 'Lebanese bread', '×2']];
  const chip = frame({ name: 'chip-new', dir: 'H', h: 'size/badge', px: 'space/2', gap: 'space/1-5', align: 'center', fill: 'status/attention/bg', radius: 'radius/pill' }, [dot('status/attention/solid', 8), text('New', 'Caption/Strong', 'status/attention/fg')]);
  const seg = [['new', 44, 'status/attention/solid', '3 new'], ['packing', 58, 'chart/series-1', '4 packing'], ['ready', 102, 'status/success/fg', '7 ready']];
  return [
    scCard('Order ticket', 340, [
      frame({ name: 'head', dir: 'H', justify: 'between', align: 'start', sizeH: 'FILL' }, [frame({ name: 'ids', dir: 'V', gap: 'space/0-5' }, [text('#MP-1042', 'Mono/Default'), text('Prepare by 11:30', 'Body/Small', 'text/muted')]), chip]),
      frame({ name: 'items', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, items.map(function (it) { return frame({ name: it[1], dir: 'H', gap: 'space/2-5', align: 'center', sizeH: 'FILL' }, [inst('ProductThumb', { Category: it[0], Size: 'Sm' }), text(it[1], 'Body/Default', 'text/secondary', { sizeH: 'FILL', truncate: true }), text(it[2], 'Body/Strong')]); })),
      inst('Button', { Variant: 'Primary', Size: 'Md', State: 'Default', Label: 'Mark as ready' }, { name: 'mark-ready', sizeH: 'FILL' }),
    ]),
    scCard('Today', 240, [
      text('Today', 'Body/Small Strong', 'text/secondary'), text('14 orders', 'Heading/Stat'),
      frame({ name: 'bar', dir: 'H', gap: 2 }, seg.map(function (s) { return rect({ name: s[0], w: s[1], h: 8, fill: s[2], radius: 2 }); })),
      frame({ name: 'legend', dir: 'H', gap: 'space/3', align: 'center' }, seg.map(function (s) { return frame({ name: s[0], dir: 'H', gap: 'space/1', align: 'center' }, [dot(s[2], 6), text(s[3], 'Caption/Default', 'text/secondary')]); })),
    ]),
    scCard('Halal certified seller', 300, scVerified('Checked by MondaPac', 'cert/seller/tile', 'badge-check', 'cert/seller/fg', 'Halal certified seller', 'Shown on all your products')),
  ];
}
const SHOWCASE_POS = { Admin: [[0, 36, -2], [352, 0, 0], [236, 262, 2.5]], Seller: [[0, 36, -2], [344, 0, 0], [260, 262, 2.5]] };
function showcaseVariant(c, p) {
  const d = SHOWCASE[p.Workspace];
  const pill = frame({ name: 'pill', dir: 'H', h: 28, px: 'space/3', gap: 'space/2', align: 'center', fill: 'bg/surface', radius: 'radius/pill' }, [dot('status/success/fg', 8), text(d.pill, 'Caption/Strong', 'text/primary', { name: 'panel' })]);
  const stage = frame({ name: 'cards', w: 592, h: 420 }); stage.fills = [];
  showcaseCards(p.Workspace).forEach(function (card, i) { const at = SHOWCASE_POS[p.Workspace][i]; add(stage, card); card.x = at[0]; card.y = at[1]; if (at[2]) card.rotation = at[2]; });
  const example = frame({ name: 'example', dir: 'H', h: 24, px: 'space/2-5', align: 'center', fill: 'text/on-showcase', fillOpacity: 0.14, radius: 'radius/pill' }, [text('Example', 'Caption/Strong', 'text/on-showcase')]);
  add(stage, example); example.x = 0; example.y = 0;
  body(c, { dir: 'V', w: 704, h: 900, pad: [56, 56, 40, 56], gap: 'auto', fill: d.fill, clip: true }, [
    frame({ name: 'brand-line', dir: 'V', gap: 'space/4' }, [pill, text(d.title, 'Display/Hero', 'text/on-showcase', { name: 'headline', w: 520 }), text(d.lede, 'Body/Default', 'text/on-showcase-muted', { name: 'lede', w: 480 })]),
    stage,
    frame({ name: 'footer', dir: 'H', sizeH: 'FILL' }, [text('Illustrative examples, not real stores', 'Caption/Default', 'text/on-showcase-muted', { name: 'place' })]),
  ]);
}
function showcaseBlock(root) {
  const sc = makeSet('AuthShowcase', { Workspace: ['Admin', 'Seller'] }, showcaseVariant, { width: 1600, gapX: 40, desc: 'The brand panel of the Auth template from 1024 px (identity ux.md 3.0 rule 1, design 1A): 55% of the width beside the form column. Workspace picks the panel colour (bg/auth-showcase-admin or bg/auth-showcase-seller, dark in both themes), the pill and the brand line in text/on-showcase and text/on-showcase-muted. Three overlapping example cards of the panel (bg/surface with the usual text tokens, two rotated by about 2°) carry a visible "Example" caption. Static and decorative: aria-hidden, no focusable element, no motion, the same for every state and account, no request of its own. Names are fictional, no real certifying body, no currency symbol; its words are copy keys identity.auth-showcase.*. Below 1024 px it is not in the page.' });
  componentBlock(root, sc, { title: 'AuthShowcase', summary: 'The static brand panel beside the sign-in form (1.7.0). The same on every Auth screen and state of one panel.',
    use: ['Only in the Auth template, at 1024 px and wider, filling the width beside the 45% form column.'],
    props: ['Workspace: Admin or Seller'],
    a11y: ['aria-hidden="true", no focusable element, live text rather than an image, no motion.', 'Brand line 4.5:1 or more on both panel colours (text/on-showcase-muted reaches 8.1:1).'],
    dont: ['Real store or certifier names, real admin routes or permissions.', 'Anything that varies by Market, account, state or URL.', 'A currency symbol in the figures.'] });
  return sc;
}
