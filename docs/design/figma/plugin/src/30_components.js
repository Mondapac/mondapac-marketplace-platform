// ---------------------------------------------------------------- component library
function focusRing(node) { S.pending.push(node.setEffectStyleIdAsync(S.es['Focus/Ring'].id)); }
function withTouch(on, fn) { const prev = S.touch; S.touch = on; try { return fn(); } finally { S.touch = prev; } }
const TONE = {
  Success: ['status/success/bg', 'status/success/fg'], Info: ['status/info/bg', 'status/info/fg'], Attention: ['status/attention/bg', 'status/attention/fg'],
  Critical: ['status/critical/bg', 'status/critical/fg'], Neutral: ['status/neutral/bg', 'status/neutral/fg'],
};
function dot(token, size) { return ellipse({ name: 'dot', w: size || 6, fill: token }); }
// Progress ring used in status badges: 0 = dotted outline, 100 = filled
function progressRing(token, pct) {
  const f = frame({ name: 'progress', w: 10, h: 10 }); f.fills = [];
  const o = ellipse({ name: 'outline', w: 10, fill: null, stroke: token, strokeW: 1.5, xy: [0, 0] });
  if (pct === 0) o.dashPattern = [1.5, 1.5];
  add(f, o);
  if (pct > 0) {
    const a = ellipse({ name: 'fill', w: 10, fill: token, xy: [0, 0] });
    if (pct < 100) a.arcData = { startingAngle: -Math.PI / 2, endingAngle: -Math.PI / 2 + Math.PI * 2 * pct / 100, innerRadius: 0 };
    add(f, a);
  }
  return f;
}
function sparkPath(vals, w, h) {
  const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
  const pts = vals.map(function (v, i) { return [i * ((w - 2) / (vals.length - 1)) + 1, (h - 3) - ((v - mn) / ((mx - mn) || 1)) * (h - 8)]; });
  const line = 'M ' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L ');
  const e = pts[pts.length - 1];
  return { line: line, area: line + ' L ' + e[0].toFixed(1) + ' ' + h + ' L 1 ' + h + ' Z', end: e };
}
function sparkline(vals, w, h, token) {
  const f = frame({ name: 'sparkline', w: w, h: h }); f.fills = [];
  const sp = sparkPath(vals, w, h);
  add(f, vector({ name: 'area', d: sp.area, fill: token, fillOpacity: 0.1, closed: true, xy: [0, 0] }));
  add(f, vector({ name: 'line', d: sp.line, stroke: token, strokeW: 2, xy: [0, 0] }));
  const d = ellipse({ name: 'end', w: 6, fill: token, stroke: 'bg/surface', strokeW: 2, strokeAlign: 'OUTSIDE', xy: [sp.end[0] - 3, sp.end[1] - 3] }); add(f, d);
  f.children.forEach(function (n) { n.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; });
  return f;
}

// Button (release 1.7.0 adds Variant=Link and State=Loading). Top level, so "Update library" can add the new variants.
const BTN = {
  Primary: { Default: ['action/primary', null, 'text/on-accent'], Hover: ['action/primary-hover', null, 'text/on-accent'], Focus: ['action/primary', null, 'text/on-accent'], Disabled: ['action/primary-disabled', null, 'text/on-accent'] },
  Secondary: { Default: ['bg/surface', 'border/control', 'text/primary'], Hover: ['bg/subtle', 'border/control', 'text/primary'], Focus: ['bg/surface', 'border/control', 'text/primary'], Disabled: ['bg/surface', 'border/default', 'text/muted'] },
  Destructive: { Default: ['bg/surface', 'status/critical/border', 'status/critical/fg'], Hover: ['status/critical/bg', 'status/critical/border', 'status/critical/fg'], Focus: ['bg/surface', 'status/critical/border', 'status/critical/fg'], Disabled: ['bg/surface', 'border/default', 'text/muted'] },
  Ghost: { Default: [null, null, 'text/link'], Hover: ['bg/subtle', null, 'text/link'], Focus: [null, null, 'text/link'], Disabled: [null, null, 'text/muted'] },
  Link: { Default: [null, null, 'text/link'], Hover: [null, null, 'text/link-hover'], Focus: [null, null, 'text/link'], Disabled: [null, null, 'text/muted'] },
};
const BTN_SIZE = { Sm: ['size/control-sm', 'space/3', 'Label/Button Small', false], Md: ['size/control', 'space/3-5', 'Label/Button', false], Touch: ['size/control', 'space/4', 'Touch/Button', true] };
const BUTTON_AXES = { Variant: ['Primary', 'Secondary', 'Destructive', 'Ghost', 'Link'], Size: ['Sm', 'Md', 'Touch'], State: ['Default', 'Hover', 'Focus', 'Disabled', 'Loading'] };
const BUTTON_OPTS = { width: 1180, desc: 'Actions. Primary: one per area. Secondary: supporting actions. Destructive: irreversible actions, label ends with … and opens a confirmation. Ghost: low-emphasis actions like Clear. Link (1.7.0): a text action in a sentence or under a form, such as "Forgot password?"; no padding, underlined on hover. State=Loading (1.7.0): the Default colours with a spinner in place of the leading icon, at the same width; the form is read-only while it shows.',
  text: [{ prop: 'Label', node: 'label', def: 'Button' }], bool: [{ prop: 'Leading icon', node: 'icon-leading', def: false }, { prop: 'Trailing icon', node: 'icon-trailing', def: false }], swap: [{ prop: 'Icon', node: 'icon-leading', def: 'plus' }] };
// A 16 px spinner: a faint full ring and a 270° arc, both strokes in the label colour.
function spinner(token) {
  const f = frame({ name: 'spinner', w: 16, h: 16 }); f.fills = [];
  const ring = ellipse({ name: 'track', w: 12, fill: null, stroke: token, strokeW: 2, strokeAlign: 'CENTER', xy: [2, 2] }); ring.opacity = 0.3; add(f, ring);
  add(f, vector({ name: 'arc', d: 'M 8 2 C 11.314 2 14 4.686 14 8 C 14 11.314 11.314 14 8 14 C 4.686 14 2 11.314 2 8', stroke: token, strokeW: 2, xy: [0, 0] }));
  return f;
}
function buttonVariant(c, p) {
  const loading = p.State === 'Loading';
  const t = BTN[p.Variant][loading ? 'Default' : p.State]; const z = BTN_SIZE[p.Size]; const link = p.Variant === 'Link';
  // text/link-hover is a text colour only, so the icons of a hovered Link stay text/link.
  const ic = t[2] === 'text/link-hover' ? 'text/link' : t[2];
  withTouch(z[3], function () {
    const kids = loading ? [spinner(t[2]), text('Button', z[2], t[2], { name: 'label' })]
      : [icon('plus', ic, 16), text('Button', z[2], t[2], { name: 'label', underline: link && p.State === 'Hover' }), icon('chevron-down', ic, 16)];
    body(c, { dir: 'H', h: z[0], px: link ? 0 : z[1], gap: 'space/1-5', align: 'center', justify: 'center', fill: t[0], stroke: t[1], radius: 'radius/control' }, kids);
    if (!loading) { c.children[0].name = 'icon-leading'; c.children[2].name = 'icon-trailing'; }
    touchMode(c);
  });
  if (p.State === 'Focus') focusRing(c);
}

async function buildActions(page) {
  const root = pageShell(page, 'Actions', 'Buttons and icon buttons. One primary action per area; secondary for everything else; destructive actions ask for confirmation (…).');
  const button = makeSet('Button', BUTTON_AXES, buttonVariant, BUTTON_OPTS);
  componentBlock(root, button, { title: 'Button', summary: 'Height 32 (Sm), 36 (Md) or 48 (Touch). Label in sentence case, verb first. Link and Loading arrived in 1.7.0.',
    use: ['Primary for the main action of a page or card (Accept, Start reviewing).', 'Secondary for supporting actions (Export, View shop).', 'Destructive for Reject…, Suspend… — always followed by a confirmation.', 'Link for text actions under a form (Forgot password?, Back to sign in).', 'Loading while a submit is in flight; the form is read-only, no page spinner.', 'Touch size on the tablet order board and on every Auth screen.'],
    props: ['Label (text)', 'Leading icon / Trailing icon (boolean)', 'Icon (instance swap)', 'Variant · Size · State'],
    a11y: ['Focus state uses the Focus/Ring effect.', 'Disabled buttons explain why nearby (e.g. "Complete the 2 remaining checks").', 'Loading keeps the label and sets aria-busy; the width does not change.', 'Icon-only actions use IconButton with an aria-label.'],
    dont: ['Two primary buttons side by side.', 'Colour-only meaning: destructive labels say what they do.', 'Link for the main action of a form.'] });

  const ICB = { Secondary: { Default: ['bg/surface', 'border/control'], Hover: ['bg/subtle', 'border/control'], Focus: ['bg/surface', 'border/control'], Disabled: ['bg/surface', 'border/default'] }, Ghost: { Default: [null, null], Hover: ['bg/subtle', null], Focus: [null, null], Disabled: [null, null] } };
  const iconBtn = makeSet('IconButton', { Variant: ['Secondary', 'Ghost'], Size: ['Sm', 'Md', 'Touch'], State: ['Default', 'Hover', 'Focus', 'Disabled'] }, function (c, p) {
    const t = ICB[p.Variant][p.State]; const z = BTN_SIZE[p.Size];
    withTouch(z[3], function () {
      body(c, { dir: 'H', w: z[0], h: z[0], align: 'center', justify: 'center', fill: t[0], stroke: t[1], radius: 'radius/control' }, [icon('more-vertical', p.State === 'Disabled' ? 'icon/muted' : 'icon/default', 18)]);
      c.children[0].name = 'icon'; touchMode(c);
    });
    if (p.State === 'Focus') focusRing(c);
  }, { width: 1180, desc: 'Square icon-only button. Always give it an accessible name in code.', swap: [{ prop: 'Icon', node: 'icon', def: 'more-vertical' }] });
  componentBlock(root, iconBtn, { title: 'IconButton', summary: 'Row actions (more), zoom, sort, sound on the board.', use: ['Row actions menu, pagination arrows, zoom in and out.'], props: ['Icon (instance swap)', 'Variant · Size · State'], a11y: ['aria-label is required: "Actions for MP-10482".'] });
  tag(root);
}

// Input (release 1.7.0 adds the Type axis: Text, Password, Code). Top level, so "Update library" can add the new variants.
const INPUT_AXES = { Type: ['Text', 'Password', 'Code'], State: ['Default', 'Hover', 'Focus', 'Filled', 'Disabled', 'Error'] };
const INPUT_OPTS = { width: 1040, colAxis: 'Type', desc: 'Text and search input. Border uses border/input (3:1). Type=Password (1.7.0) adds a show/hide IconButton (exposed as "reveal"; icon eye while the password is hidden, swap it to eye-off while it shows; aria-pressed in code). Type=Code (1.7.0) is one field in the mono text style for a 6-digit code or a backup code: inputmode numeric, autocomplete one-time-code, no auto-advance or auto-submit. Password and Code keep their own text per state, because a TEXT property would force one text on every variant; Value applies to Type=Text.',
  text: [{ prop: 'Value', node: 'value', def: 'Order number or product' }], bool: [{ prop: 'Leading icon', node: 'icon-leading', def: true }] };
const INPUT_DOC = { title: 'Input', summary: 'Search, filters and form fields. Wrap it in Field for a label, helper and error.', use: ['Search inside index pages; filters; form fields inside Field.', 'Type=Password for every password; Type=Code for a one-time code or backup code.'], props: ['Value (text, Type=Text)', 'Leading icon (boolean)', 'Type · State'], a11y: ['Always paired with a visible or visually hidden label (Field).', 'Error state adds a message below; colour is not enough.', 'The show/hide button is named "Show password" or "Hide password" and sits after its field in the focus order.'] };
const INPUT_ICON = { Text: 'search', Password: 'lock', Code: 'key' };
function inputVariant(c, p) {
  const type = p.Type || 'Text';
  const border = p.State === 'Error' ? 'status/critical/solid' : (p.State === 'Focus' ? 'action/primary' : (p.State === 'Hover' ? 'text/muted' : 'border/input'));
  const filled = p.State === 'Filled' || (type !== 'Text' && p.State === 'Focus');
  let value;
  if (type === 'Text') value = text(p.State === 'Filled' ? 'MP-10482' : 'Order number or product', 'Body/Default', p.State === 'Filled' ? 'text/primary' : 'text/muted', { name: 'value', sizeH: 'FILL', truncate: true });
  else if (type === 'Password') value = text(filled ? '••••••••••••••••' : '', 'Body/Default', p.State === 'Disabled' ? 'text/muted' : 'text/primary', { name: 'secret', sizeH: 'FILL', truncate: true });
  else value = text(filled ? '482913' : '', 'Mono/Default', p.State === 'Disabled' ? 'text/muted' : 'text/primary', { name: 'code', sizeH: 'FILL', truncate: true });
  const kids = [icon(INPUT_ICON[type], 'icon/muted', 16), value];
  if (type === 'Password') kids.push(inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: p.State === 'Disabled' ? 'Disabled' : 'Default', Icon: { icon: 'eye' } }, { name: 'reveal' }));
  body(c, { dir: 'H', w: 280, h: 'size/control', pad: [0, type === 'Password' ? 'space/0-5' : 'space/2-5', 0, 'space/2-5'], gap: 'space/2', align: 'center', fill: p.State === 'Disabled' ? 'bg/muted' : 'bg/surface', stroke: border, radius: 'radius/control' }, kids);
  c.children[0].name = 'icon-leading';
  if (type === 'Password') safe('expose reveal', function () { c.children[2].isExposedInstance = true; });
  if (p.State === 'Focus') focusRing(c);
}

async function buildForms(page) {
  const root = pageShell(page, 'Forms & selection', 'Inputs, checkboxes, switches, segmented controls, tabs and filter chips.');
  const input = makeSet('Input', INPUT_AXES, inputVariant, INPUT_OPTS);
  componentBlock(root, input, INPUT_DOC);
  fieldBlock(root);
  selectBlock(root);
  textareaBlock(root);

  const cb = makeSet('Checkbox', { Value: ['Unchecked', 'Checked', 'Indeterminate'], State: ['Default', 'Focus', 'Disabled'] }, function (c, p) {
    const on = p.Value !== 'Unchecked';
    body(c, { dir: 'H', w: 16, h: 16, align: 'center', justify: 'center', fill: on ? (p.State === 'Disabled' ? 'action/primary-disabled' : 'action/primary') : (p.State === 'Disabled' ? 'bg/muted' : 'bg/surface'), stroke: on ? null : 'border/input', radius: 4 }, [
      p.Value === 'Checked' ? icon('check', 'text/on-accent', 12) : (p.Value === 'Indeterminate' ? icon('minus', 'text/on-accent', 12) : null),
    ]);
    if (p.State === 'Focus') focusRing(c);
  }, { width: 520, desc: 'Row selection and checks.' });
  componentBlock(root, cb, { title: 'Checkbox', summary: '16 px box with a 24 px hit area in code.', a11y: ['Header checkbox uses Indeterminate when some rows are selected.', 'Label each row checkbox: "Select MP-10482".'] });
  checkboxRowBlock(root);

  const sw = makeSet('Switch', { On: ['True', 'False'], Size: ['Md', 'Touch'] }, function (c, p) {
    const W = p.Size === 'Touch' ? 40 : 32, H = p.Size === 'Touch' ? 24 : 18, K = H - 4;
    c.layoutMode = 'NONE'; c.resize(W, H); c.cornerRadius = H / 2;
    c.fills = [paint(p.On === 'True' ? 'status/success/fg' : 'border/control')];
    const k = ellipse({ name: 'knob', w: K, fill: 'bg/surface', xy: [p.On === 'True' ? W - K - 2 : 2, 2] }); add(c, k);
  }, { width: 520, desc: 'On/off setting that applies immediately, e.g. Taking instant orders.' });
  componentBlock(root, sw, { title: 'Switch', summary: 'Immediate on/off settings.', a11y: ['role="switch" with aria-checked.', 'Turning off instant orders asks for confirmation.'] });

  const seg = makeComponent('SegmentedControl', function (c) {
    body(c, { dir: 'H', h: 'size/control', stroke: 'border/control', radius: 'radius/control', fill: 'bg/surface', clip: true }, [
      frame({ name: 'segment-1', dir: 'H', px: 'space/3', align: 'center', fill: 'bg/selected', sizeV: 'FILL' }, [text('Today', 'Body/Strong', 'text/link', { name: 'label-1' })]),
      frame({ name: 'segment-2', dir: 'H', px: 'space/3', align: 'center', stroke: 'border/control', sides: ['left'], sizeV: 'FILL' }, [text('7 days', 'Body/Default', 'text/secondary', { name: 'label-2' })]),
      frame({ name: 'segment-3', dir: 'H', px: 'space/3', align: 'center', stroke: 'border/control', sides: ['left'], sizeV: 'FILL' }, [text('30 days', 'Body/Default', 'text/secondary', { name: 'label-3' })]),
    ]);
  }, { desc: 'Period switcher. First segment selected.', text: [{ prop: 'Segment 1', node: 'label-1', def: 'Today' }, { prop: 'Segment 2', node: 'label-2', def: '7 days' }, { prop: 'Segment 3', node: 'label-3', def: '30 days' }] });
  const segWrap = frame({ name: 'SegmentedControl', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(segWrap, seg);
  componentBlock(root, segWrap, { title: 'SegmentedControl', summary: 'Switch the period of a dashboard.', a11y: ['role="group" with aria-pressed on each segment.'] });

  const tab = makeSet('Tab', { Selected: ['True', 'False'] }, function (c, p) {
    const on = p.Selected === 'True';
    body(c, { dir: 'H', h: 40, px: 'space/2-5', gap: 'space/1-5', align: 'center', stroke: on ? 'action/primary' : null, sides: ['bottom'], strokeW: 2 }, [
      text('All', on ? 'Body/Strong' : 'Body/Medium', on ? 'text/link' : 'text/secondary', { name: 'label' }), text('128', 'Body/Default', 'text/muted', { name: 'count' }),
    ]);
  }, { width: 520, desc: 'Saved view tab with count.', text: [{ prop: 'Label', node: 'label', def: 'All' }, { prop: 'Count', node: 'count', def: '128' }], bool: [{ prop: 'Show count', node: 'count', def: true }] });
  componentBlock(root, tab, { title: 'Tab', summary: 'Saved views on index pages. Counts are live.', a11y: ['role="tab" with aria-selected; the bar is role="tablist".'] });

  const chip = makeSet('FilterChip', { Type: ['Applied', 'Add'] }, function (c, p) {
    if (p.Type === 'Applied') {
      body(c, { dir: 'H', h: 30, pad: [0, 6, 0, 10], gap: 'space/1-5', align: 'center', fill: 'bg/selected', radius: 'radius/pill' }, [text('Placed: Today', 'Body/Small Strong', 'text/link', { name: 'label' }), icon('x', 'text/link', 14)]);
    } else {
      body(c, { dir: 'H', h: 30, px: 'space/2-5', gap: 'space/1-5', align: 'center', stroke: 'border/input', dash: [3, 3], radius: 'radius/pill' }, [text('+ Add filter', 'Body/Small', 'text/secondary', { name: 'add-label' })]);
    }
  }, { width: 520, desc: 'Applied filter (removable) and the add-filter trigger.', text: [{ prop: 'Label', node: 'label', def: 'Placed: Today' }] });
  componentBlock(root, chip, { title: 'FilterChip', summary: 'Applied filters sit next to search. Removing one updates results at once.', a11y: ['The × button is labelled "Remove filter Placed".'] });
  fieldPreferred();
  tag(root);
}

async function buildStatus(page) {
  const root = pageShell(page, 'Status & feedback', 'Badges, status, certificates, health, deadlines, meters and banners. State is always a word plus a shape, never colour alone.');
  const BICON = { Success: 'check', Info: 'clock', Attention: 'clock', Critical: 'alert-circle', Neutral: 'circle' };
  const badge = makeSet('Badge', { Tone: ['Success', 'Info', 'Attention', 'Critical', 'Neutral'], Leading: ['Dot', 'Icon', 'None'] }, function (c, p) {
    const t = TONE[p.Tone];
    body(c, { dir: 'H', h: 'size/badge', px: 'space/2', gap: 'space/1-5', align: 'center', fill: t[0], radius: 'radius/pill' }, [
      p.Leading === 'Dot' ? dot(t[1]) : (p.Leading === 'Icon' ? icon(BICON[p.Tone], t[1], 12) : null), text(p.Tone === 'Critical' ? 'Overdue 4 h' : (p.Tone === 'Attention' ? 'Due 5:00 pm' : (p.Tone === 'Success' ? 'Active' : (p.Tone === 'Info' ? 'Scheduled' : 'Due 2 Oct'))), 'Caption/Strong', t[1], { name: 'label' }),
    ]);
    if (p.Leading === 'Icon') c.children[0].name = 'icon';
  }, { width: 1040, desc: 'Short status or deadline label.', text: [{ prop: 'Label', node: 'label', def: 'Active' }], swap: [{ prop: 'Icon', node: 'icon', def: 'check' }] });
  componentBlock(root, badge, { title: 'Badge', summary: 'Pill, 22 px. Tone carries meaning; the dot or icon repeats it for colour-blind users.', use: ['Success: active, healthy, paid.', 'Info: scheduled, in review.', 'Attention: due today, waiting.', 'Critical: overdue, suspended.', 'Neutral: future dates, counts.'] });

  const ST = [['Needs action', 'Attention', 0], ['Preparing', 'Info', 50], ['Ready for pickup', 'Info', 75], ['Out for delivery', 'Info', 88], ['Delivered', 'Success', 100], ['Cancelled', 'Critical', -1], ['Scheduled', 'Neutral', 0], ['In review', 'Info', 50]];
  const sb = makeSet('StatusBadge', { Status: ST.map(function (s) { return s[0]; }) }, function (c, p) {
    const s = ST.filter(function (x) { return x[0] === p.Status; })[0]; const t = TONE[s[1]];
    body(c, { dir: 'H', h: 'size/badge', pad: [0, 8, 0, 7], gap: 'space/1-5', align: 'center', fill: t[0], radius: 'radius/pill' }, [
      s[2] < 0 ? rect({ name: 'stop', w: 10, h: 10, fill: t[1], radius: 2 }) : progressRing(t[1], s[2]), text(s[0], 'Caption/Strong', t[1], { name: 'label' }),
    ]);
  }, { width: 1040, desc: 'Order and review status with a progress ring: empty = waiting, half = in progress, full = done.' });
  componentBlock(root, sb, { title: 'StatusBadge', summary: 'The ring shows how far along the flow the item is.', a11y: ['The ring is decorative; the word is the status.'] });

  const cnt = makeSet('CountBadge', { Tone: ['Attention', 'Neutral', 'Info', 'Critical'] }, function (c, p) {
    const t = TONE[p.Tone];
    body(c, { dir: 'H', h: 20, px: 'space/2', align: 'center', justify: 'center', fill: p.Tone === 'Critical' ? 'status/critical/meter' : t[0], radius: 'radius/pill' }, [text('3', 'Caption/Strong', p.Tone === 'Critical' ? 'text/on-accent' : t[1], { name: 'count' })]);
  }, { width: 520, desc: 'Counts in navigation and notifications.', text: [{ prop: 'Count', node: 'count', def: '3' }] });
  componentBlock(root, cnt, { title: 'CountBadge', summary: 'Attention for work waiting on you, Neutral for plain counts, Critical for unread alerts.' });

  const CK = { Seller: ['cert/seller', 'badge-check', 'Halal', false], Manufacturer: ['cert/manufacturer', 'briefcase', 'Halal · manufacturer', false], Vegan: ['cert/vegan', 'leaf', 'Vegan', false], 'Self-declared': ['cert/vegan', 'leaf', 'Vegan · self-declared', true], Revoked: ['status/critical', null, 'Halal', false] };
  const cert = makeSet('CertChip', { Kind: Object.keys(CK) }, function (c, p) {
    const k = CK[p.Kind]; const rev = p.Kind === 'Revoked';
    const fg = rev ? 'status/critical/fg' : k[0] + '/fg';
    body(c, { dir: 'H', h: 24, px: 'space/2', gap: 'space/1-5', align: 'center', fill: rev ? 'status/critical/bg' : k[0] + '/bg', stroke: rev ? 'status/critical/border' : (k[3] ? 'cert/vegan/self-declared-border' : k[0] + '/border'), dash: k[3] ? [3, 3] : null, radius: 'radius/chip' }, [
      k[1] ? icon(k[1], fg, 13) : null, text(k[2], 'Caption/Strong', fg, { name: 'scheme', strike: rev }), text(rev ? 'Revoked' : '· exp 15 Oct', 'Caption/Strong', rev ? 'status/critical/fg' : 'status/attention/fg', { name: rev ? 'revoked' : 'note' }),
    ]);
  }, { width: 1040, desc: 'Certificate kind (CERT-24/44). Seller and manufacturer certificates are verified; self-declared is dashed.', text: [{ prop: 'Note', node: 'note', def: '· exp 15 Oct' }], bool: [{ prop: 'Show note', node: 'note', def: false }] });
  componentBlock(root, cert, { title: 'CertChip', summary: 'Show who stands behind the claim: the seller, the manufacturer, or nobody (self-declared).', use: ['Show the expiry note when 14 days or fewer remain.'], a11y: ['The kind is in the text, not only in the border style.'] });

  const HL = { Healthy: ['status/success/fg', 'check'], 'At risk': ['status/attention/fg', 'alert-triangle'], Unhealthy: ['status/critical/fg', 'alert-circle'], 'No data': ['text/muted', null] };
  const health = makeSet('HealthIndicator', { State: Object.keys(HL) }, function (c, p) {
    const h = HL[p.State];
    body(c, { dir: 'H', gap: 'space/1-5', align: 'center' }, [h[1] ? icon(h[1], h[0], 14) : null, text(p.State, p.State === 'No data' ? 'Body/Default' : 'Body/Strong', h[0], { name: 'label' })]);
  }, { width: 520, desc: 'Seller account health against targets.' });
  componentBlock(root, health, { title: 'HealthIndicator', summary: 'Icon + word. Used in seller tables and seller summaries.' });

  const MT = { Accent: ['chart/meter-track', 'action/primary'], Attention: ['status/attention/track', 'status/attention/solid'], Critical: ['status/critical/track', 'status/critical/meter'], Success: ['status/success/track', 'status/success/fg'] };
  const meter = makeSet('Meter', { Tone: Object.keys(MT), Value: ['0', '25', '50', '75', '100'] }, function (c, p) {
    const m = MT[p.Tone]; c.layoutMode = 'NONE'; c.resize(120, 6); c.fills = [];
    const tr = rect({ name: 'track', w: 120, h: 6, fill: m[0], radius: 3, xy: [0, 0] }); add(c, tr); tr.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    const v = parseInt(p.Value, 10);
    if (v > 0) { const fl = rect({ name: 'fill', w: Math.max(2, 1.2 * v), h: 6, fill: m[1], radius: 3, xy: [0, 0] }); add(c, fl); fl.constraints = { horizontal: 'SCALE', vertical: 'STRETCH' }; }
  }, { width: 1040, gapX: 40, desc: 'Share of time or capacity used. Accent < 75 %, Attention 75–99 %, Critical ≥ 100 %.' });
  componentBlock(root, meter, { title: 'Meter', summary: 'Resize the instance freely; the fill scales.', a11y: ['role="meter" with aria-valuenow and a label.'] });

  const DL = { Overdue: ['Critical', 'Overdue 4 h', 'Critical', '100'], 'Due soon': ['Attention', 'Due 5:00 pm', 'Accent', '75'], Upcoming: ['Neutral', 'Due 2 Oct', 'Accent', '25'] };
  const dl = makeSet('DeadlineBadge', { Tone: Object.keys(DL) }, function (c, p) {
    const d = DL[p.Tone];
    body(c, { dir: 'V', gap: 'space/1-5' }, [inst('Badge', { Tone: d[0], Leading: 'None', Label: d[1] }, { name: 'badge' }), inst('Meter', { Tone: d[2], Value: d[3] }, { name: 'meter' })]);
  }, { width: 520, desc: 'Deadline text plus the share of the review time already used.', bool: [{ prop: 'Show meter', node: 'meter', def: true }] });
  componentBlock(root, dl, { title: 'DeadlineBadge', summary: 'Rules (pending PO, D15): overdue = critical, under 24 h = attention, later = neutral.' });

  const IB = { Info: ['bg/info-banner', 'border/info', 'text/link', 'badge-check'], Attention: ['status/attention/surface', 'status/attention/border', 'status/attention/fg', 'clock'], Critical: ['status/critical/bg', 'status/critical/border', 'status/critical/fg', 'alert-circle'], Success: ['status/success/bg', 'status/success/track', 'status/success/fg', 'check'] };
  const banner = makeSet('InfoBanner', { Tone: Object.keys(IB) }, function (c, p) {
    const b = IB[p.Tone];
    body(c, { dir: 'H', w: 960, pad: [14, 16, 14, 16], gap: 'space/3', align: 'start', fill: b[0], stroke: b[1], radius: 'radius/card' }, [
      icon(b[3], b[2], 20),
      frame({ name: 'content', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Your Halal certificate renewal is in review', 'Body/Strong', 'text/primary', { name: 'title', sizeH: 'FILL' }), text('Your current certificate stays valid until 15 Oct 2026, so your 38 Halal offers are not affected.', 'Body/Default', 'text/secondary', { name: 'body', sizeH: 'FILL' })]),
      text('View certificate', 'Body/Strong', 'text/link', { name: 'action' }),
    ]);
  }, { width: 1040, desc: 'Page-level message. One per page at most.', text: [{ prop: 'Title', node: 'title', def: 'Your Halal certificate renewal is in review' }, { prop: 'Body', node: 'body', def: 'Your current certificate stays valid until 15 Oct 2026, so your 38 Halal offers are not affected.' }, { prop: 'Action', node: 'action', def: 'View certificate' }], bool: [{ prop: 'Show action', node: 'action', def: true }] });
  componentBlock(root, banner, { title: 'InfoBanner', summary: 'Explain what is happening and what (if anything) the user needs to do.', a11y: ['role="status" for information, role="alert" only for critical.'] });

  const tip = makeComponent('Tooltip', function (c) {
    body(c, { dir: 'V', pad: [8, 10, 8, 10], gap: 'space/0-5', fill: 'chart/tooltip-bg', radius: 'radius/control' }, [text('Today, 2:30 pm', 'Caption/Default', 'chart/tooltip-muted', { name: 'label' }), text('AUD 12,904.60', 'Body/Strong', 'chart/tooltip-fg', { name: 'value' })]);
  }, { desc: 'Chart and map tooltip (inverse surface).', text: [{ prop: 'Label', node: 'label', def: 'Today, 2:30 pm' }, { prop: 'Value', node: 'value', def: 'AUD 12,904.60' }] });
  const tipWrap = frame({ name: 'Tooltip', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(tipWrap, tip);
  componentBlock(root, tipWrap, { title: 'Tooltip', summary: 'Inverse surface so it reads above any chart.' });
  toastBlock(root);
  dialogBlock(root);
  tag(root);
}
