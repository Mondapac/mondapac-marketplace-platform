// ---------------------------------------------------------------- release 1.9.0 templates: Seller setup, S1 to S6 (planned as 1.3.0 in sellers ux.md 8.1 item 1)
// Spec: sellers ux.md 3.0, 3.1, 3.3, 3.5 and section 5 (en-AU copy). The steps sit in the limited seller shell (ID-UX F5, as S1 in 1.7.0); every
// frame is new and named "Seller · Setup · S<n> <screen>[ · <state>]", so the 1.7.0 S1 frames ("Seller · Your seller account · …", identity
// steps only) are not touched and Update library builds only the names a file does not have yet. Rule 4: the address fields and their
// labels, the business-number label and help, the tax question and the storefront address come from the API; the AU Market's values are
// shown because AU is the launch Market. Names, numbers, addresses and dates are examples.

const SETUP = { store: 'Kuraby Fresh', business: 'Kuraby Fresh Pty Ltd', phone: '0412 345 678', contact: 'hello@kurabyfresh.example', signIn: 'yusuf@kurabyfresh.example',
  street: '45 Station Road', locality: 'Kuraby', region: 'Queensland', postcode: '4112', zone: 'Brisbane time', zoneId: 'Australia/Brisbane', localTime: '10:14 AEST',
  idLabel: 'ABN', idHelp: '11 digits', abn: '12 345 678 901', taxQuestion: 'Is your business registered for GST?', taxFrom: '1 Jul 2024',
  storefront: 'mondapac.com.au/shop/', slug: 'kuraby-fresh', slugMin: 3, slugMax: 40, submitted: '6 Oct 2026, 10:14 AEST', withdrawn: '7 Oct 2026' };
// [screen id, title, step number]; S2 to S6 are steps 1 to 5.
const SETUP_STEPS = { business: ['S2', 'Business details', 1], address: ['S3', 'Address and area', 2], number: ['S4', 'Business number', 3], slug: ['S5', 'Shop web address', 4], submit: ['S6', 'Review and submit', 5] };
const SETUP_TOTAL = 5;
const STORE_HELP = 'Customers see this name. Don’t use words that claim a certification, and don’t copy another brand.';
const CONTACT_HELP = 'For customers and MondaPac to reach your business. You still sign in with ' + SETUP.signIn + '.';
const ZONE_HELP = 'We use this to work out your local time for cut-offs and certificate dates. Only MondaPac can change it.';
const OUTSIDE_AREA = ['We’re not in your area yet.', 'We’ve saved your details. You can submit once we open there.']; // error.address.outside-service-area, split into title and body
const EDIT_WARNING = ['Your application is waiting for review.', 'If you change anything, your submission is withdrawn and you’ll need to submit again.']; // edit-warning.banner, split
const SLUG_HELP = 'Lowercase letters, numbers and hyphens. ' + SETUP.slugMin + ' to ' + SETUP.slugMax + ' characters.';
const SLUG_SUGGESTED = 'Suggested from your store name. You can change it.'; // F13 step 5; no key yet (Jafar's wording)
const NUMBER_STATUS = {
  Checking: ['Checking', 'Checking with the official register…'],
  Matched: ['Success', 'Matched with the official register'],
  'Not matched': ['Critical', 'We couldn’t match this number with the official register. Check it and try again, or contact us.'],
  'Could not be checked': ['Info', 'We couldn’t check this right now. You can still submit, and a reviewer will check it.'],
  'Limit reached': ['Critical', 'You’ve changed this number too many times. Try again later.'],
};
const SLUG_STATUS = { Checking: ['Checking', 'Checking…'], Available: ['Success', 'Available now. It’s held for you when you submit.'], 'Not available': ['Critical', 'That address isn’t available. Try another.'], Throttled: ['Info', 'Too many checks. Wait a moment.'] };

function setupName(id, title, state, phone) { return 'Seller · Setup · ' + id + ' ' + title + (state ? ' · ' + state : '') + (phone ? ' (phone)' : ''); }
function stepName(key, state, phone) { const d = SETUP_STEPS[key]; return setupName(d[0], d[1], state, phone); }

// A Field (see authField) with the 1.9.0 parts: o.optional, o.status = [tone, text], o.prefix (the Input's fixed prefix).
function setupField(label, o) {
  o = o || {};
  const f = authField(label, o);
  const own = {};
  if (o.optional) Object.assign(own, prop('Field', 'Optional', true));
  if (o.status) Object.assign(own, prop('Field', 'Show status', true));
  if (Object.keys(own).length) f.setProperties(own);
  if (o.status) setNested(f, 'status', Object.assign({ Tone: o.status[0] }, prop('FieldStatus', 'Text', o.status[1])));
  if (o.prefix) setNested(f, 'control', Object.assign(prop('Input', 'Show prefix', true), prop('Input', 'Prefix', o.prefix)));
  return f;
}
function setupCard(title, kids) { return card(title, [header(title, null), frame({ name: 'body', dir: 'V', gap: 'space/4', pad: [0, 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, kids)]); }
function setupNote(s, name) { return text(s, 'Body/Small', 'text/muted', { name: name || 'note', sizeH: 'FILL' }); }
function setupBanner(tone, title, bodyText, action) {
  const p = { Tone: tone, Title: title, Body: bodyText, 'Show action': !!action }; if (action) p.Action = action;
  return inst('InfoBanner', p, { name: tone === 'Critical' ? 'error-summary' : 'banner', sizeH: 'FILL' });
}
function backToAccount(touch) { return inst('Button', { Variant: 'Ghost', Size: touch ? 'Touch' : 'Sm', State: 'Default', Label: 'Back to your seller account', 'Leading icon': true, Icon: { icon: 'chevron-left' } }, { name: 'back' }); }
function stepHeader(key, touch) {
  const d = SETUP_STEPS[key];
  return frame({ name: 'Page header', dir: 'V', gap: 'space/2', align: 'start', sizeH: 'FILL' }, [backToAccount(touch), text(d[1], 'Heading/H1', 'text/primary', { name: 'title', sizeH: 'FILL' }), text('Step ' + d[2] + ' of ' + SETUP_TOTAL, 'Body/Small Strong', 'text/muted', { name: 'step-counter' })]);
}
// The save bar: o.state (Clean, Dirty, Saving, Error), o.primary / o.secondary labels (secondary null hides it), o.disabled, o.noStatus.
function setupBar(o, sticky) {
  o = o || {};
  const bar = inst('FormActionBar', { Layout: sticky ? 'Sticky' : 'Inline', State: o.state || 'Clean' }, { name: 'FormActionBar', sizeH: 'FILL' });
  const own = {};
  if (o.secondary === null) Object.assign(own, prop('FormActionBar', 'Show secondary', false));
  if (o.noStatus) Object.assign(own, prop('FormActionBar', 'Show status', false));
  if (Object.keys(own).length) bar.setProperties(own);
  const pr = prop('Button', 'Label', o.primary || 'Save and continue'); if (o.disabled) pr.State = 'Disabled';
  setNested(bar, 'primary', pr);
  if (o.secondary) setNested(bar, 'secondary', prop('Button', 'Label', o.secondary));
  return bar;
}
// Desktop step page: limited shell, form column at most size/form-max (3.0 rules 1 and 2). touch: the step pages S2 to S6 have 48 px
// targets at every width (ux.md 6, Touch density as on Auth), so their Main takes the Touch dimension mode; the shell stays Desktop.
function setupPage(name, kids, w, touch) {
  const main = frame({ name: 'Main', dir: 'V', pad: ['space/7', 'space/8', 'space/10', 'space/8'], sizeH: 'FILL' }, [frame({ name: 'content', dir: 'V', gap: 'space/5', w: w || 'size/form-max' }, kids)]);
  if (touch) applyDensity(main, 'touch');
  const col = frame({ name: 'Column', dir: 'V', sizeH: 'FILL' }, [
    inst('Topbar', { Workspace: 'Seller', Crumb: 'Your seller account', 'Show search': false, 'Show notifications': false }, { name: 'Topbar', sizeH: 'FILL' }),
    main,
  ]);
  const scr = frame({ name: name, dir: 'H', w: 1440, fill: 'bg/page', clip: true }, [limitedSidebar(), col]);
  scr.minHeight = PANEL_MIN_H;
  tag(scr);
  return scr;
}
// Phone step page (360 wide, touch density): the content scrolls in Main, the save bar is pinned below it (Sticky).
function setupPhone(name, kids, bar) {
  const scr = phoneScreen(name, 'Seller', kids, null);
  const topbar = scr.children[0];
  ['menu-button', 'notifications'].forEach(function (n) { const x = topbar.findOne(function (k) { return k.name === n; }); if (x) x.visible = false; });
  if (bar) add(scr, bar);
  applyDensity(scr, 'touch');
  return scr;
}

// ---- S1 Your seller account, with the sellers steps (ux.md 3.1 S1 and 3.3)
// Step states: [state, by, detail]; detail is the steps.detail line (null: none).
const S1_SETUP = {
  'Details needed': { badge: ['Neutral', 'clipboard'], banner: ['Info', 'Finish your details', 'Complete the steps below, then submit them for review.'],
    steps: [['Done', 'Done'], ['To do', 'To do', '4 fields left'], ['To do', 'To do', '2 fields left'], ['To do', 'To do', '1 field left']], submit: ['Waiting', 'Waiting'], review: ['To do', 'To do'] },
  'Ready to submit': { badge: ['Info', 'send'], banner: ['Info', 'Your details are ready', 'Submit them for review when you’re ready.', 'Review and submit'],
    steps: [['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done']], submit: ['To do', 'To do'], review: ['To do', 'To do'] },
  'Not in your area yet': { badge: ['Attention', 'map-pin'], banner: ['Attention', 'We’re not in your area yet', 'Your details are saved. You can submit once we open there.', 'Contact us'],
    steps: [['Done', 'Done'], ['Needs attention', 'Not in your area yet'], ['Done', 'Done'], ['Done', 'Done']], submit: ['Waiting', 'Waiting'], review: ['To do', 'To do'] },
  'Awaiting review': { badge: ['Info', 'clock'], banner: ['Info', 'We’re reviewing your application', 'We’ll email you when there’s a decision. Until then you can’t sell. Changing your details withdraws your submission.'],
    steps: [['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done']], submit: ['Done', 'Done'], review: ['Waiting', 'In progress'], submitted: 'Submitted on ' + SETUP.submitted, withdraw: true },
  'Changes needed': { badge: ['Attention', 'alert-circle'], banner: ['Attention', 'Your application needs changes', 'Read the reason, update your details and submit again.'],
    reason: 'We couldn’t accept the business name you gave. Use the legal name of your business, then submit again.',
    steps: [['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done']], submit: ['To do', 'To do'], review: ['Needs attention', 'Needs changes'] }, // a reason carries no step data, so every step stays Done
  'Not approved': { badge: ['Critical', 'x'], banner: ['Critical', 'Your application wasn’t approved', 'You’ve reached the limit for new applications. Contact us if you have questions.', 'Contact us'],
    reason: 'The business details you gave don’t meet our requirements for new shops.',
    steps: [['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done'], ['Done', 'Done']], submit: ['Done', 'Done'], review: ['Needs attention', 'Not approved'] },
};
// Two frames reuse a state with another line (ux.md 3.1 S1): after MondaPac withdrew the submission, and when MondaPac submitted for the seller.
const S1_SETUP_FRAMES = [['Details needed'], ['Ready to submit'], ['Ready to submit', 'Withdrawn'], ['Not in your area yet'], ['Awaiting review'], ['Awaiting review', 'Submitted by MondaPac'], ['Changes needed'], ['Not approved']];
function setupStep(s, title, chevron) {
  const p = { State: s[0], Title: title, By: s[1], 'Show actions': false };
  const i = inst('ChecklistItem', p, { name: 'step', sizeH: 'FILL' });
  const own = {};
  if (s[2]) Object.assign(own, prop('ChecklistItem', 'Show detail', true), prop('ChecklistItem', 'Detail', s[2]));
  if (chevron) Object.assign(own, prop('ChecklistItem', 'Show chevron', true));
  if (Object.keys(own).length) i.setProperties(own);
  return i;
}
function s1SetupContent(state, variant) {
  const st = S1_SETUP[state];
  const banner = variant === 'Withdrawn'
    ? setupBanner('Info', 'Your submission was withdrawn on ' + SETUP.withdrawn + ' because MondaPac edited your details.', 'Submit again when you’re ready.', 'Review and submit')
    : setupBanner(st.banner[0], st.banner[1], st.banner[2], st.banner[3]);
  const head = [frame({ name: 'title-row', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, [text('Your seller account', 'Heading/H1'), bdg(st.badge[0], 'Icon', state, st.badge[1])])];
  if (variant === 'Submitted by MondaPac') head.push(setupNote('MondaPac submitted these details for you on 6 Oct 2026.', 'submitted'));
  else if (st.submitted) head.push(setupNote(st.submitted, 'submitted'));
  const slot = frame({ name: 'certification-slot', dir: 'H', pad: [12, 18, 12, 18], sizeH: 'FILL', stroke: 'border/row', sides: ['top'] }, [
    frame({ name: 'slot', dir: 'H', px: 'space/3', py: 'space/2', stroke: 'border/input', dash: [4, 4], radius: 'radius/control', sizeH: 'FILL' }, [text('Slot for the certificate steps (not needed to submit)', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]),
  ]);
  const stepTitles = ['Business details', 'Address and area', 'Business number', 'Shop web address'];
  const steps = [setupStep(['Done', '3 Oct 2026'], 'Account created'), setupStep(['Done', '3 Oct 2026'], 'Email confirmed')]
    .concat(st.steps.map(function (s, i) { return setupStep(s, stepTitles[i], true); }))
    .concat([slot, setupStep(st.submit, 'Review and submit', true), setupStep(st.review, 'MondaPac reviews your application')]);
  const kids = [frame({ name: 'Page header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, head), banner];
  if (st.reason) kids.push(inst('ReasonQuote', { Reason: st.reason, Date: 'Written on 6 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }));
  kids.push(card('Steps', steps));
  if (st.withdraw) kids.push(frame({ name: 'withdraw', dir: 'H', sizeH: 'FILL' }, [btn('Withdraw submission', 'Secondary', 'Md')]));
  kids.push(card('Help', [frame({ name: 'help', dir: 'V', gap: 'space/3', pad: [16, 18, 16, 18], sizeH: 'FILL' }, [text('Protect your account', 'Heading/H2'), text('Turn on two-step verification while you wait.', 'Body/Default', 'text/secondary', { sizeH: 'FILL' }), btn('Set up two-step verification', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'smartphone' } }), text(AUTH_SUPPORT, 'Body/Small', 'text/muted', { name: 'support', sizeH: 'FILL' })])]));
  return kids;
}
function s1SetupName(state, variant, phone) { return setupName('S1', 'Your seller account', state + (variant ? ' · ' + variant : ''), phone); }
function tplS1Setup(state, variant) { return setupPage(s1SetupName(state, variant), s1SetupContent(state, variant), 760); }
function tplS1SetupPhone(state) { return setupPhone(s1SetupName(state, null, true), s1SetupContent(state), null); }

// ---- S2 Business details
// o.fresh: a new file, nothing saved yet (ux.md 3.5: empty fields, no "Saved").
function s2Content(o) {
  o = o || {};
  const st = o.readOnly ? 'Disabled' : null; const v = function (x) { return o.fresh ? '' : x; };
  const kids = [];
  if (o.errors) kids.push(setupBanner('Critical', 'Check the details below', 'Enter a phone number.'));
  if (o.awaiting) kids.push(setupBanner('Attention', EDIT_WARNING[0], EDIT_WARNING[1]));
  if (o.readOnly) kids.push(setupBanner('Attention', 'MondaPac is recording a decision.', 'Try again in a moment.'));
  kids.push(setupCard('Your shop', [
    setupField('Store name', { value: v(SETUP.store), helper: STORE_HELP, state: st }),
    setupField('Business name', { value: v(SETUP.business), helper: 'The legal name of your business.', state: st }),
    o.errors ? setupField('Phone', { value: '', error: 'Enter a phone number.' }) : setupField('Phone', { value: v(SETUP.phone), state: st }),
    setupField('Contact email', { value: v(SETUP.contact), helper: CONTACT_HELP, optional: true, state: st }),
    readOnlyPair('Sign-in email', SETUP.signIn),
  ]));
  return kids;
}
function s2Bar(o, sticky) { o = o || {}; return setupBar({ state: o.errors ? 'Error' : (o.awaiting ? 'Dirty' : 'Clean'), secondary: 'Back to checklist', disabled: o.readOnly, noStatus: o.fresh }, sticky); } // awaiting review: the button keeps "Save and continue"; D3 carries "Save and withdraw" (ux.md flow F14 step 2)
function tplS2(state, o) { return setupPage(stepName('business', state), [stepHeader('business')].concat(s2Content(o), [s2Bar(o)]), null, true); }
function tplS2Phone() { return setupPhone(stepName('business', null, true), [stepHeader('business', true)].concat(s2Content()), s2Bar({}, true)); }

// ---- S3 Address and area
// The AU Market's address fields in its order (from the API). On a phone the Suburb and Postcode pair stacks (ux.md 6).
function addressFields(registered, fresh) {
  const v = function (x, y) { return fresh ? '' : (registered ? y : x); };
  return [
    setupField('Street address', { value: v(SETUP.street, '2/18 Logan Road') }),
    frame({ name: 'locality-row', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [setupField('Suburb', { value: v(SETUP.locality, 'Woolloongabba') }), setupField('Postcode', { value: v(SETUP.postcode, '4102') })]),
    panelField('State', { select: fresh ? { state: 'Default', value: 'Select a state' } : { state: 'Filled', value: SETUP.region } }),
  ];
}
function zoneResult() {
  return frame({ name: 'zone-result', dir: 'H', gap: 'space/2-5', align: 'start', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [
    icon('clock', 'icon/muted', 18),
    frame({ name: 'text', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Your work time zone is ' + SETUP.zone + ' (' + SETUP.zoneId + ').', 'Body/Strong', 'text/primary', { name: 'zone', sizeH: 'FILL' }), setupNote('Local time now: ' + SETUP.localTime, 'local-time'), setupNote(ZONE_HELP, 'zone-help')]),
  ]);
}
function s3Content(o) {
  o = o || {};
  const kids = [];
  if (o.outside) kids.push(setupBanner('Attention', OUTSIDE_AREA[0], OUTSIDE_AREA[1]));
  if (o.unresolved) kids.push(setupBanner('Attention', 'We couldn’t work out your time zone from this address.', 'Check the address, or contact us.', 'Contact us')); // error.timezone.unresolved, split
  const check = inst('CheckboxRow', { Value: o.registered ? 'Checked' : 'Unchecked', State: 'Default', Label: 'My registered business address is different', Description: 'Only the address where your shop works from sets your service area and time zone.' }, { name: 'registered-different', sizeH: 'FILL' });
  const body = addressFields(false, o.fresh).concat([check]);
  if (!o.fresh && !o.outside && !o.unresolved && !o.registered) body.push(zoneResult());
  kids.push(setupCard('Where your shop works from', body));
  if (o.registered) kids.push(setupCard('Registered business address', addressFields(true)));
  return kids;
}
function tplS3(state, o) { o = o || {}; return setupPage(stepName('address', state), [stepHeader('address')].concat(s3Content(o), [setupBar({ state: o.registered ? 'Dirty' : 'Clean', secondary: 'Back to checklist', noStatus: o.fresh })]), null, true); }

// ---- S4 Business number and tax registration
function numberField(state) {
  if (state === 'Empty') return setupField(SETUP.idLabel, { value: '', helper: SETUP.idHelp });
  if (state === 'Format error') return setupField(SETUP.idLabel, { value: '12 345 678', helper: SETUP.idHelp, error: 'That doesn’t look like a valid ' + SETUP.idLabel + '. Check the number and try again.' });
  const s = NUMBER_STATUS[state];
  return setupField(SETUP.idLabel, { value: SETUP.abn, helper: SETUP.idHelp, status: s ? [s[0], s[1]] : null });
}
// The tax answer is required and never preselected: before an answer no segment is selected (an override of segment 1 in this
// instance; the SegmentedControl component always draws its first segment selected). "Registered from" follows a Yes.
function segNone(seg) {
  const s1 = seg.findOne(function (n) { return n.name === 'segment-1'; }); if (s1) s1.fills = [];
  const l1 = seg.findOne(function (n) { return n.name === 'label-1'; });
  if (l1) { S.pending.push(l1.setTextStyleIdAsync(S.ts['Body/Default'].id)); l1.fills = [paint('text/secondary')]; }
}
function taxCard(answered) {
  const seg = inst('SegmentedControl', { 'Segment 1': 'Yes', 'Segment 2': 'No' }, { name: 'tax-answer' });
  const third = seg.findOne(function (n) { return n.name === 'segment-3'; }); if (third) third.visible = false;
  if (!answered) segNone(seg);
  const kids = [frame({ name: 'question', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [text(SETUP.taxQuestion, 'Body/Strong', 'text/primary', { name: 'tax-question', sizeH: 'FILL' }), seg, setupNote('MondaPac doesn’t decide whether you must register.', 'tax-help')])];
  if (answered) kids.push(setupField('Registered from', { value: SETUP.taxFrom }));
  return setupCard('Tax registration', kids);
}
function s4Content(state) { return [setupCard('Business number', [numberField(state)]), taxCard(state !== 'Empty')]; }
// First visit: nothing saved, no result line, the tax question unanswered. Saved: the number matched and the answer Yes.
function tplS4() { return setupPage(stepName('number'), [stepHeader('number')].concat(s4Content('Empty'), [setupBar({ secondary: 'Back to checklist', noStatus: true })]), null, true); }
function tplS4Saved() { return setupPage(stepName('number', 'Saved'), [stepHeader('number')].concat(s4Content('Matched'), [setupBar({ secondary: 'Back to checklist' })]), null, true); }
// One board with the business-number field in each result state (ux.md 3.1 S4), as the frontend builds them.
const NUMBER_BOARD = ['Checking', 'Matched', 'Not matched', 'Could not be checked', 'Limit reached', 'Format error', 'No register lookup'];
const SLUG_BOARD = ['Idle', 'Checking', 'Available', 'Not available', 'Format error', 'Throttled'];
function stateBoard(name, title, note, states, make) {
  const cells = states.map(function (s) { return frame({ name: s, dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [text(s, 'Caption/Strong', 'text/muted', { name: 'state' }), card(s, [frame({ name: 'body', dir: 'V', pad: 'space/5', sizeH: 'FILL' }, [make(s)])])]); });
  const scr = frame({ name: name, dir: 'V', w: 720, pad: 40, gap: 'space/6', fill: 'bg/page' }, [frame({ name: 'board-header', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text(title, 'Heading/H1'), para(note, 640)])].concat(cells));
  tag(scr);
  return scr;
}
function tplS4States() {
  return stateBoard(stepName('number', 'Result states'), 'Business number: result states', 'The result line under the field after a save (ux.md 3.1 S4). Not matched is one message for "not found" and "cancelled". With no register lookup in the Market there is no result line. A format or checksum error is the field error.', NUMBER_BOARD, numberField);
}

// ---- S5 Shop web address
function slugField(state) {
  if (state === 'Format error') return setupField('Shop web address', { value: 'Kuraby--Fresh', prefix: SETUP.storefront, error: 'Use ' + SETUP.slugMin + ' to ' + SETUP.slugMax + ' lowercase letters, numbers and hyphens, with no hyphen at the start, end or in a row.' });
  const s = SLUG_STATUS[state];
  return setupField('Shop web address', { value: SETUP.slug, prefix: SETUP.storefront, helper: SLUG_HELP, status: s ? [s[0], s[1]] : null });
}
// First visit: the field is prefilled by code from the store name (not AI), editable and marked as a suggestion (F13 step 5); nothing is saved yet.
function s5Content(state) {
  const kids = [slugField(state)];
  if (state === 'Idle') kids.push(setupNote(SLUG_SUGGESTED, 'suggestion'));
  kids.push(setupNote('You can only change this later by asking MondaPac.', 'help-later'));
  return [setupCard('Shop web address', kids)];
}
function tplS5() { return setupPage(stepName('slug'), [stepHeader('slug')].concat(s5Content('Idle'), [setupBar({ secondary: 'Back to checklist', noStatus: true })]), null, true); }
function tplS5States() {
  return stateBoard(stepName('slug', 'Statuses'), 'Shop web address: statuses', 'Checked on blur and after 600 ms without typing, one request at a time; no check for a format error, which is local (ux.md 3.1 S5). Taken and reserved show the same text.', SLUG_BOARD, slugField);
}

// ---- S6 Review and submit
// Rows: [card, label, value, state, note]; state Missing or Blocked marks a row.
function s6Rows(o) {
  o = o || {};
  return [
    ['Business details', 'Store name', SETUP.store], ['Business details', 'Business name', SETUP.business], ['Business details', 'Phone', SETUP.phone, o.missing ? 'Missing' : null], ['Business details', 'Contact email', SETUP.contact],
    ['Address and area', 'Where your shop works from', SETUP.street + ', ' + SETUP.locality + ' ' + SETUP.region + ' ' + SETUP.postcode, o.blocked ? 'Blocked' : null, o.blocked ? 'We’re not in your area yet.' : null], ['Address and area', 'Work time zone', SETUP.zone + ' (' + SETUP.zoneId + ')'],
    ['Business number', SETUP.idLabel, SETUP.abn, o.blocked ? 'Blocked' : null, o.blocked ? 'We couldn’t match this number with the official register.' : null], ['Business number', SETUP.taxQuestion, 'Yes'], ['Business number', 'Registered from', SETUP.taxFrom],
    ['Shop web address', 'Shop web address', SETUP.storefront + SETUP.slug, o.missing ? 'Missing' : null],
  ];
}
// A blocked row carries its reason in the note and "Contact us" as the second action (F13 step 6); a phone uses Width=Narrow.
function dataRow(r, readOnly, narrow) {
  const p = { Layout: 'Single', Width: narrow ? 'Narrow' : 'Wide', State: r[3] || 'Default', Label: r[1], 'Show action': !readOnly };
  if (r[3] !== 'Missing') p.Value = r[2];
  if (r[4]) { p['Show note'] = true; p.Note = r[4]; }
  if (r[3] === 'Blocked') p['Show second action'] = true;
  return inst('DataRow', p, { name: 'row · ' + r[1], sizeH: 'FILL' });
}
function s6Cards(o) {
  o = o || {};
  const rows = s6Rows(o); const groups = [];
  rows.forEach(function (r) { if (groups.indexOf(r[0]) < 0) groups.push(r[0]); });
  return groups.map(function (g) { return card(g, [header(g, null)].concat(rows.filter(function (r) { return r[0] === g; }).map(function (r) { return dataRow(r, o.awaiting, o.touch); }))); });
}
function s6Content(o) {
  o = o || {};
  const d = SETUP_STEPS.submit;
  const kids = [frame({ name: 'Page header', dir: 'V', gap: 'space/2', align: 'start', sizeH: 'FILL' }, [backToAccount(o.touch), text(d[1], 'Heading/H1', 'text/primary', { name: 'title', sizeH: 'FILL' }), text('Step ' + d[2] + ' of ' + SETUP_TOTAL, 'Body/Small Strong', 'text/muted', { name: 'step-counter' })])];
  if (o.empty) {
    kids.push(inst('EmptyState', { Size: 'Card', Title: 'Nothing saved yet', Body: 'Start with your business details.', Icon: { icon: 'clipboard' } }, { name: 'empty', sizeH: 'FILL' }));
    setNested(kids[kids.length - 1], 'action', prop('Button', 'Label', 'Business details'));
    return kids;
  }
  if (o.awaiting) kids.push(setupBanner('Info', 'We’re reviewing your application', 'Submitted on ' + SETUP.submitted + '. Changing your details withdraws your submission.'));
  else kids.push(setupBanner('Info', 'Before you submit', 'MondaPac reviews these details before you can sell. You’ll get an email when there’s a decision.'));
  return kids.concat(s6Cards(o));
}
function s6Bar(o, sticky) {
  o = o || {};
  if (o.awaiting) return frame({ name: 'withdraw', dir: 'H', sizeH: 'FILL' }, [btn('Withdraw submission', 'Secondary', sticky ? 'Touch' : 'Md')]);
  const bar = setupBar({ primary: o.again ? 'Submit again' : 'Submit for review', secondary: null, noStatus: true, disabled: o.missing || o.blocked }, sticky);
  if (!o.missing && !o.blocked) return bar;
  // "Finish {n} items first" (submit.help.blocked), linking to the first missing or blocked item, beside the disabled button.
  return frame({ name: 'submit', dir: 'V', gap: 'space/2', align: 'end', sizeH: 'FILL' }, [inst('Button', { Variant: 'Link', Size: sticky ? 'Touch' : 'Sm', State: 'Default', Label: 'Finish 2 items first.' }, { name: 'blocked-reason' }), bar]);
}
function tplS6(state, o) { o = o || {}; const kids = s6Content(o); if (!o.empty) kids.push(s6Bar(o)); return setupPage(stepName('submit', state), kids, null, true); }
function tplS6Phone() { return setupPhone(stepName('submit', null, true), s6Content({ touch: true }), s6Bar({}, true)); }

// ---- the list of 1.9.0 frames: [group, name, make], all on Templates · Seller
const SETUP_ROWS = ['setup-account', 'setup-details', 'setup-number', 'setup-submit', 'setup-phone'];
function setupDefs() {
  return { 'tpl-seller': S1_SETUP_FRAMES.map(function (f) { return ['setup-account', s1SetupName(f[0], f[1]), function () { return tplS1Setup(f[0], f[1]); }]; }).concat([
    ['setup-details', stepName('business'), function () { return tplS2(null, { fresh: true }); }],
    ['setup-details', stepName('business', 'Saved'), function () { return tplS2('Saved'); }],
    ['setup-details', stepName('business', 'Errors'), function () { return tplS2('Errors', { errors: true }); }],
    ['setup-details', stepName('business', 'Awaiting review'), function () { return tplS2('Awaiting review', { awaiting: true }); }],
    ['setup-details', stepName('business', 'Decision in progress'), function () { return tplS2('Decision in progress', { readOnly: true }); }],
    ['setup-details', stepName('address'), function () { return tplS3(null, { fresh: true }); }],
    ['setup-details', stepName('address', 'Saved'), function () { return tplS3('Saved'); }],
    ['setup-details', stepName('address', 'Registered address'), function () { return tplS3('Registered address', { registered: true }); }],
    ['setup-details', stepName('address', 'Outside area'), function () { return tplS3('Outside area', { outside: true }); }],
    ['setup-details', stepName('address', 'Time zone unresolved'), function () { return tplS3('Time zone unresolved', { unresolved: true }); }],
    ['setup-number', stepName('number'), tplS4],
    ['setup-number', stepName('number', 'Saved'), tplS4Saved],
    ['setup-number', stepName('number', 'Result states'), tplS4States],
    ['setup-number', stepName('slug'), tplS5],
    ['setup-number', stepName('slug', 'Statuses'), tplS5States],
    ['setup-submit', stepName('submit'), function () { return tplS6(null); }],
    ['setup-submit', stepName('submit', 'Missing'), function () { return tplS6('Missing', { missing: true }); }],
    ['setup-submit', stepName('submit', 'Blocked'), function () { return tplS6('Blocked', { blocked: true }); }],
    ['setup-submit', stepName('submit', 'Submit again'), function () { return tplS6('Submit again', { again: true }); }],
    ['setup-submit', stepName('submit', 'Awaiting review'), function () { return tplS6('Awaiting review', { awaiting: true }); }],
    ['setup-submit', stepName('submit', 'Empty'), function () { return tplS6('Empty', { empty: true }); }],
    ['setup-phone', s1SetupName('Details needed', null, true), function () { return tplS1SetupPhone('Details needed'); }],
    ['setup-phone', stepName('business', null, true), tplS2Phone],
    ['setup-phone', stepName('submit', null, true), tplS6Phone],
  ]) };
}
function setupNames() { return setupDefs()['tpl-seller'].map(function (d) { return d[1]; }); }
// The sets the 1.9.0 templates place (a template is built only when each one is the plugin's own).
const SETUP_TEMPLATE_NEEDS = ['Sidebar', 'Topbar', 'PhoneTopbar', 'Button', 'Input', 'Field', 'FieldStatus', 'Select', 'Badge', 'InfoBanner', 'CardHeader', 'ChecklistItem', 'ReasonQuote', 'CheckboxRow', 'SegmentedControl', 'DataRow', 'FormActionBar', 'EmptyState'];
// Dark preview copy added in 1.9.0.
const DARK_190 = [stepName('number', 'Saved'), stepName('submit', 'Missing'), stepName('submit', 'Blocked')];
