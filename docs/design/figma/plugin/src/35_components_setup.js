// ---------------------------------------------------------------- release 1.9.0 "Seller setup" components (sellers ux.md section 4, planned there as 1.3.0)
// FieldStatus (the status line Field shows with Show status), DataRow and FormActionBar. Built by "Build library" on their library pages
// and added to an existing file by "Update library" (see 50_main.js), which also adds the 1.9.0 properties of Field, Input and ChecklistItem.

// ---- FieldStatus (Forms & selection): one line under a field for a check that runs after the person types or saves.
// ux.md names it Field's Status property (None, Checking, Success, Info, Critical); it is a set of its own placed in Field as an exposed
// instance, so Field stays one component: Status None is Show status off.
const FIELD_STATUS = {
  Checking: ['refresh-cw', 'icon/muted', 'text/secondary'],
  Success: ['check', 'status/success/fg', 'status/success/fg'],
  Info: ['info', 'status/info/fg', 'text/secondary'],
  Critical: ['alert-circle', 'status/critical/fg', 'status/critical/fg'],
};
const FIELD_STATUS_OPTS = { width: 1040, desc: 'The status line under a field (1.9.0): Checking while a check runs (role="status"; the icon is drawn still and never spins under reduced motion), Success, Info and Critical, each an icon and words, never colour alone. Field shows it with Show status (exposed as "status"); it reads the business-number result (S4) and the shop web address check (S5, D7). Text comes from the API as a translation key; never a server message.',
  text: [{ prop: 'Text', node: 'status-text', def: 'Checking…' }] };
function fieldStatusVariant(c, p) {
  const t = FIELD_STATUS[p.Tone];
  body(c, { dir: 'H', w: 360, gap: 'space/1-5', align: 'start' }, [
    frame({ name: 'icon-box', dir: 'H', pad: [1, 0, 0, 0] }, [icon(t[0], t[1], 16)]),
    text('Checking…', 'Body/Small', t[2], { name: 'status-text', sizeH: 'FILL' }),
  ]);
}
const FIELD_STATUS_AXES = { Tone: Object.keys(FIELD_STATUS) };
function fieldStatusBlock(root) {
  const set = makeSet('FieldStatus', FIELD_STATUS_AXES, fieldStatusVariant, FIELD_STATUS_OPTS);
  componentBlock(root, set, { title: 'FieldStatus', summary: 'The result line of a check on one field (1.9.0). Field places it under the control with Show status.',
    use: ['Business number: Checking, Matched (Success), Could not be checked (Info), Not matched (Critical).', 'Shop web address: Checking, Available (Success), Not available (Critical).', 'A format error stays the Field error, not a status: a field shows its error or its status, never both.'],
    props: ['Tone: Checking, Success, Info, Critical', 'Text (text)'],
    a11y: ['Checking is a role="status" region; the result replaces it in the same region.', 'Icon and words for every tone, never colour alone.'],
    dont: ['A spinner that keeps turning under reduced motion.', 'Words such as "verified" or "already registered".'] });
  return set;
}
// The slot Field holds (1.9.0): hidden until Show status is on.
function fieldStatusSlot() { const i = inst('FieldStatus', { Tone: 'Checking' }, { name: 'status', sizeH: 'FILL' }); i.visible = false; return i; }

// ---- DataRow (Review & detail): a label and a read-only value, or two values to compare. S6 summary, S7, P2 and P3.
// Width=Narrow (below 760 px) puts the label above the value, so a phone row keeps the value's width.
const DATAROW_AXES = { Layout: ['Single', 'Compare'], Width: ['Wide', 'Narrow'], State: ['Default', 'Missing', 'Blocked', 'Changed'] };
// Missing and Blocked belong to the summary before a submission (S6), so a Compare row has neither. Compare has no Narrow layout yet:
// its screens (S7, P2, P3) wait for the mobile navigation (D16) on phones.
const DATAROW_SKIP = function (p) { return p.Layout === 'Compare' && (p.State === 'Missing' || p.State === 'Blocked' || p.Width === 'Narrow'); };
const DATAROW_KEYS = ['Label', 'Value', 'Compare value', 'Value label', 'Compare label', 'Note', 'Show note', 'Show flag', 'Show action', 'Show second action'];
const DATAROW_OPTS = { width: 1440, colAxis: 'Layout', skip: DATAROW_SKIP, // Layout in 2 columns, Width and State in rows: 1368 px wide, so the block fits the page
  desc: 'A label and a read-only value (1.9.0). Layout=Compare shows two values side by side with their own labels (Current and Requested for a change request; Submitted and Register for an admin). Width=Narrow, below 760 px, puts the label above the value. State=Missing replaces the value with "Missing" (an empty required value); State=Blocked keeps the value and adds "Blocked" (outside the service area, time zone not found, a definite register negative), with the reason in the note and "Contact us" as the second action. State=Changed adds the Changed badge. Show note adds a line under the value; Show flag adds a Badge (exposed as "flag": Waiting for review, Matches, Differs); Show action and Show second action show link Buttons (exposed as "action" and "second-action": Edit, Request a change, Contact us). Values are plain text shown with dir="auto"; never a register value to a seller.',
  text: [{ prop: 'Label', node: 'label', def: 'Store name' }, { prop: 'Value', node: 'value', def: 'Kuraby Fresh' }, { prop: 'Compare value', node: 'compare-value', def: 'Kuraby Fresh Grocers' },
    { prop: 'Value label', node: 'value-label', def: 'Current' }, { prop: 'Compare label', node: 'compare-label', def: 'Requested' }, { prop: 'Note', node: 'note', def: 'We’re not in your area yet.' }],
  bool: [{ prop: 'Show note', node: 'note', def: false }, { prop: 'Show flag', node: 'flag', def: false }, { prop: 'Show action', node: 'action', def: true }, { prop: 'Show second action', node: 'second-action', def: false }] };
function rowMarker(ic, token, word) { return frame({ name: 'marker', dir: 'H', gap: 'space/1-5', align: 'center' }, [icon(ic, token, 16), text(word, 'Body/Small Strong', token, { name: 'marker-text' })]); }
function dataRowVariant(c, p) {
  const narrow = p.Width === 'Narrow';
  const value = function (node, str, strong) { return text(str, strong ? 'Body/Strong' : 'Body/Default', 'text/primary', { name: node, sizeH: 'FILL' }); };
  const note = text('We’re not in your area yet.', 'Body/Small', 'text/secondary', { name: 'note', sizeH: 'FILL' }); note.visible = false;
  let values;
  if (p.Layout === 'Compare') {
    values = frame({ name: 'values', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [
      frame({ name: 'pair', dir: 'H', gap: 'space/4', align: 'start', sizeH: 'FILL' }, [
        frame({ name: 'current', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Current', 'Caption/Default', 'text/muted', { name: 'value-label' }), value('value', 'Kuraby Fresh')]),
        frame({ name: 'requested', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text('Requested', 'Caption/Default', 'text/muted', { name: 'compare-label' }), value('compare-value', 'Kuraby Fresh Grocers', true)]),
      ]),
      note,
    ]);
  } else {
    const kids = [];
    if (p.State === 'Missing') kids.push(rowMarker('alert-circle', 'status/attention/fg', 'Missing'));
    else kids.push(value('value', 'Kuraby Fresh'));
    if (p.State === 'Blocked') kids.push(rowMarker('alert-triangle', 'status/attention/fg', 'Blocked'));
    kids.push(note);
    values = frame({ name: 'values', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, kids);
  }
  const flag = inst('Badge', { Tone: 'Neutral', Leading: 'None', Label: 'Waiting for review' }, { name: 'flag' }); flag.visible = false;
  const action = inst('Button', { Variant: 'Link', Size: 'Sm', State: 'Default', Label: 'Edit' }, { name: 'action' });
  const second = inst('Button', { Variant: 'Link', Size: 'Sm', State: 'Default', Label: 'Contact us' }, { name: 'second-action' }); second.visible = false;
  const changed = p.State === 'Changed' ? inst('Badge', { Tone: 'Info', Leading: 'None', Label: 'Changed' }, { name: 'changed' }) : null;
  const actions = frame({ name: 'actions', dir: 'H', gap: 'space/3', align: 'center' }, [action, second]);
  const label = text('Store name', 'Body/Small', 'text/muted', narrow ? { name: 'label', sizeH: 'FILL' } : { name: 'label', w: 168 });
  const box = { pad: ['space/3', 'space/4', 'space/3', 'space/4'], fill: 'bg/surface', stroke: 'border/row', sides: ['bottom'] };
  if (narrow) body(c, Object.assign({ dir: 'V', w: 360, gap: 'space/1' }, box), [label, values, frame({ name: 'meta', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/1' }, [changed, flag, actions])]);
  else body(c, Object.assign({ dir: 'H', w: 'size/form-max', gap: 'space/4', align: 'start' }, box), [label, values, changed, flag, actions]);
  safe('expose flag and actions', function () { flag.isExposedInstance = true; action.isExposedInstance = true; second.isExposedInstance = true; });
}
function dataRowBlock(root) {
  const set = makeSet('DataRow', DATAROW_AXES, dataRowVariant, DATAROW_OPTS);
  componentBlock(root, set, { title: 'DataRow', summary: 'Read-only values with an optional flag and actions (1.9.0): the summary before a seller submits (S6), the store profile (S7), the seller page and the review page (P2, P3).',
    use: ['Layout=Single for one value; Compare for current against requested, or submitted against the register (admins only).', 'Width=Narrow below 760 px: the label goes above the value.', 'Missing for an empty required value, Blocked for a value that stops the submission (its reason in the note, "Contact us" as the second action), Changed for a value changed since the last submission.', 'Stack rows inside a Card; the last row keeps its border (the Card clips it).'],
    props: ['Layout · Width · State (Compare has Wide only, with Default and Changed)', 'Label, Value, Compare value, Value label, Compare label, Note (text)', 'Show note, Show flag, Show action, Show second action (boolean); flag, action and second-action are exposed instances (Badge, link Buttons)'],
    a11y: ['A row is a <div> pair in a description list (<dl>: <dt> label, <dd> value).', '"Missing" and "Blocked" are words with an icon, never colour alone. Blocked is Attention, like the outside-area banner; a definite register negative keeps its Critical line on S4.', 'The actions are link Buttons with a focus state and 48 px targets in Touch density; each names its row: "Edit store name".'],
    dont: ['A register value shown to a seller.', 'Truncating a value: it wraps.'] });
  return set;
}

// ---- FormActionBar (Forms & selection): the save bar at the end of a form. Sticky at the bottom of the screen below 760 px.
const FAB_AXES = { Layout: ['Inline', 'Sticky'], State: ['Clean', 'Dirty', 'Saving', 'Error'] };
const FAB_STATUS = { Clean: ['check', 'status/success/fg', 'Saved', 'text/secondary'], Dirty: ['pencil', 'icon/muted', 'Unsaved changes', 'text/secondary'], Saving: ['refresh-cw', 'icon/muted', 'Saving…', 'text/muted'], Error: ['alert-circle', 'status/critical/fg', 'Not saved', 'status/critical/fg'] };
const FAB_OPTS = { width: 1440, colAxis: 'Layout', // Inline and Sticky in 2 columns, State in rows
  desc: 'The save bar of a form (1.9.0): a status text, a secondary action and the primary action. State: Clean (Saved), Dirty (Unsaved changes), Saving (the primary shows State=Loading at the same width), Error (Not saved; the error summary above the form says why and takes focus). Layout=Inline sits at the end of the form column; Layout=Sticky is pinned to the bottom of the screen below 760 px, with full-width touch buttons. The buttons are exposed ("primary", "secondary") so their labels are set from the bar; Show status and Show secondary hide the parts a form does not need. ID-UX B3 adopts it.',
  bool: [{ prop: 'Show status', node: 'status', def: true }, { prop: 'Show secondary', node: 'secondary', def: true }] };
function formActionBarVariant(c, p) {
  const st = FAB_STATUS[p.State]; const sticky = p.Layout === 'Sticky'; const size = sticky ? 'Touch' : 'Md';
  const status = frame({ name: 'status', dir: 'H', gap: 'space/1-5', align: 'center' }, [icon(st[0], st[1], 16), text(st[2], 'Body/Small Strong', st[3], { name: 'status-text' })]);
  const secondary = inst('Button', { Variant: 'Secondary', Size: size, State: 'Default', Label: 'Back to checklist' }, { name: 'secondary', sizeH: sticky ? 'FILL' : null });
  const primary = inst('Button', { Variant: 'Primary', Size: size, State: p.State === 'Saving' ? 'Loading' : 'Default', Label: 'Save and continue' }, { name: 'primary', sizeH: sticky ? 'FILL' : null });
  // one order in both layouts (status, secondary, primary), so the visual order is the DOM and focus order
  if (sticky) body(c, { dir: 'V', w: 360, pad: 'space/4', gap: 'space/3', fill: 'bg/surface', stroke: 'border/default', sides: ['top'] }, [status, secondary, primary]);
  else body(c, { dir: 'H', w: 'size/form-max', pad: ['space/4', 0, 0, 0], gap: 'space/3', align: 'center', stroke: 'border/row', sides: ['top'] }, [status, frame({ name: 'spacer', dir: 'H', h: 1, sizeH: 'FILL' }), secondary, primary]);
  safe('expose buttons', function () { secondary.isExposedInstance = true; primary.isExposedInstance = true; });
}
function formActionBarBlock(root) {
  const set = makeSet('FormActionBar', FAB_AXES, formActionBarVariant, FAB_OPTS);
  componentBlock(root, set, { title: 'FormActionBar', summary: 'One save bar for forms in both panels (1.9.0): the seller setup steps (Save and continue, Back to checklist), the store profile cards and later every settings form.',
    use: ['One bar per form or card group; one primary action.', 'Layout=Sticky below 760 px, so the primary action stays in reach while the form scrolls.', 'The status text is a role="status" region; Error goes with the error summary at the top of the form.'],
    props: ['Layout: Inline, Sticky', 'State: Clean, Dirty, Saving, Error', 'Show status, Show secondary (boolean); primary and secondary are exposed Buttons'],
    a11y: ['DOM, focus and visual order are the same in both layouts: status, secondary, primary (the primary is last, nearest the thumb on a phone).', 'Saving: the primary shows Loading at the same width with aria-busy="true", not disabled, so focus stays on it; focus stays on the primary after a save.', 'A disabled primary stays focusable and names its reason with aria-describedby; the reason is text beside it.', 'Show status is off until the form has been saved once: a form never saved shows no "Saved".', 'Sticky: the bar never covers the focused field (scroll-padding in code).'],
    dont: ['Two primary actions.', 'A status shown by colour alone.'] });
  return set;
}

// ---- Update library (1.9.0): the new properties of Input, ChecklistItem and Field, added in place to the plugin's own components.
// A first, read-only pass decides what each one needs and reports a component whose layers were changed by hand; each step's run()
// then edits only that component and returns the lines for the report. Nodes are added hidden, as their boolean's default is false.
function propertySteps190(own) {
  const steps = [];
  const named = function (v, name, type) { return v.children.filter(function (n) { return n.name === name && (!type || n.type === type); })[0]; };
  // Input: the prefix text after the leading icon in each Type=Text variant.
  const inp = S.sets.Input;
  if (!own('Input')) log('ℹ skipped Input properties Show prefix and Prefix: the Input set is not the plugin\'s');
  else {
    const textVars = inp.set.children.filter(function (v) { return v.variantProperties.Type === 'Text'; });
    const lacking = textVars.filter(function (v) { return !named(v, 'prefix'); });
    const odd = lacking.filter(function (v) { return !v.children[0] || v.children[0].name !== 'icon-leading' || !named(v, 'value', 'TEXT'); });
    if (odd.length) log('ℹ skipped the Input prefix in ' + odd.map(function (v) { return v.name; }).join('; ') + ': its layers were changed by hand');
    const todo = lacking.filter(function (v) { return odd.indexOf(v) < 0; });
    const props = !inp.keys.Prefix || !inp.keys['Show prefix']; const desc = inp.set.description === INPUT_DESC_170;
    if (props || todo.length || desc) steps.push({ node: inp.set, label: 'Input prefix', run: function () {
      const out = [];
      if (props) {
        if (!inp.keys.Prefix) inp.keys.Prefix = inp.set.addComponentProperty('Prefix', 'TEXT', INPUT_PREFIX);
        if (!inp.keys['Show prefix']) inp.keys['Show prefix'] = inp.set.addComponentProperty('Show prefix', 'BOOLEAN', false);
        out.push('Input properties Show prefix and Prefix');
      }
      todo.forEach(function (v) { v.insertChild(1, inputPrefix()); });
      textVars.forEach(function (v) { wireVariant(v, inp.keys, { text: [{ prop: 'Prefix', node: 'prefix' }], bool: [{ prop: 'Show prefix', node: 'prefix' }] }); });
      if (todo.length) out.push('Input prefix layer (' + todo.length + ' Type=Text variants)');
      if (desc) { inp.set.description = INPUT_OPTS.desc; out.push('update Input description'); }
      return out;
    } });
  }
  // ChecklistItem: the detail line after By, the chevron at the end of the row.
  const ck = S.sets.ChecklistItem;
  if (!own('ChecklistItem')) log('ℹ skipped ChecklistItem properties Show detail, Detail and Show chevron: the ChecklistItem set is not the plugin\'s');
  else {
    const content = function (v) { return named(v, 'content', 'FRAME'); };
    const lacking = ck.set.children.filter(function (v) { const c = content(v); return !c || !named(c, 'detail') || !named(v, 'chevron'); });
    const odd = lacking.filter(function (v) { const c = content(v); return v.layoutMode !== 'HORIZONTAL' || !c || !named(c, 'by', 'TEXT'); });
    if (odd.length) log('ℹ skipped the ChecklistItem detail and chevron in ' + odd.map(function (v) { return v.name; }).join('; ') + ': its layers were changed by hand');
    const todo = lacking.filter(function (v) { return odd.indexOf(v) < 0; });
    const props = !ck.keys.Detail || !ck.keys['Show detail'] || !ck.keys['Show chevron']; const desc = ck.set.description === CHECKLIST_DESC_170;
    if (props || todo.length || desc) steps.push({ node: ck.set, label: 'ChecklistItem detail', run: function () {
      const out = [];
      if (props) {
        if (!ck.keys.Detail) ck.keys.Detail = ck.set.addComponentProperty('Detail', 'TEXT', '2 fields left');
        if (!ck.keys['Show detail']) ck.keys['Show detail'] = ck.set.addComponentProperty('Show detail', 'BOOLEAN', false);
        if (!ck.keys['Show chevron']) ck.keys['Show chevron'] = ck.set.addComponentProperty('Show chevron', 'BOOLEAN', false);
        out.push('ChecklistItem properties Show detail, Detail and Show chevron');
      }
      todo.forEach(function (v) {
        const c = content(v);
        if (!named(c, 'detail')) c.insertChild(c.children.indexOf(named(c, 'by', 'TEXT')) + 1, checklistDetail());
        if (!named(v, 'chevron')) v.appendChild(checklistChevron());
      });
      ck.set.children.forEach(function (v) { wireVariant(v, ck.keys, { text: [{ prop: 'Detail', node: 'detail' }], bool: [{ prop: 'Show detail', node: 'detail' }, { prop: 'Show chevron', node: 'chevron' }] }); });
      if (todo.length) out.push('ChecklistItem detail line and chevron (' + todo.length + ' variants)');
      if (desc) { ck.set.description = CHECKLIST_OPTS.desc; out.push('update ChecklistItem description'); }
      return out;
    } });
  }
  // Field: the exposed FieldStatus line after the control (it needs the plugin's FieldStatus, made earlier in this run or before).
  const fr = S.sets.Field;
  if (fr && fr.comp) {
    const f = fr.comp; const has = named(f, 'status', 'INSTANCE'); const ctl = named(f, 'control', 'INSTANCE');
    if (!own('Field')) log('ℹ skipped Field property Show status: the Field component is not the plugin\'s');
    else if (!own('FieldStatus')) log('ℹ skipped Field property Show status: it needs the plugin\'s FieldStatus');
    else if (!has && (!ctl || f.layoutMode !== 'VERTICAL')) log('ℹ skipped Field property Show status: its layers were changed by hand');
    else {
      const props = !fr.keys['Show status']; const desc = f.description === FIELD_DESC_180;
      if (!has || props || desc) steps.push({ node: f, label: 'Field status', run: function () {
        const out = [];
        let st = has;
        if (!st) { st = fieldStatusSlot(); add(f, st); f.insertChild(f.children.indexOf(ctl) + 1, st); safe('expose Field status', function () { st.isExposedInstance = true; }); out.push('Field status line (an exposed FieldStatus)'); }
        if (props) { fr.keys['Show status'] = f.addComponentProperty('Show status', 'BOOLEAN', false); out.push('Field property Show status'); }
        st.componentPropertyReferences = Object.assign({}, st.componentPropertyReferences || {}, { visible: fr.keys['Show status'] });
        if (desc) { f.description = FIELD_DESC; out.push('update Field description'); }
        return out;
      } });
    }
  }
  // SegmentedControl: the radio-group use in its description and its Usage panel (Accessibility).
  const sr = S.sets.SegmentedControl; const sc = sr && sr.comp;
  if (sc && !own('SegmentedControl')) log('ℹ skipped SegmentedControl radio-group note: the component is not the plugin\'s');
  else if (sc) {
    const row = sc.parent && sc.parent.parent;
    const panel = row && row.type === 'FRAME' && row.name === 'Component + usage' ? named(row, 'Usage', 'FRAME') : null;
    const acc = panel && named(panel, 'Accessibility', 'FRAME'); const list = acc && named(acc, 'List', 'FRAME');
    const items = list ? list.children : [];
    const first = items.length && items[0].children[1];
    const note = items.length === 1 && first && first.type === 'TEXT' && first.characters === SEG_A11Y_170[0];
    const done = items.length === SEG_A11Y.length && items.every(function (it, i) { return it.children[1] && it.children[1].characters === SEG_A11Y[i]; });
    if (!note && !done) log('ℹ skipped SegmentedControl radio-group note in its Usage panel: the panel was changed by hand');
    const desc = sc.description === SEG_DESC_170;
    if (note || desc) steps.push({ node: sc, label: 'SegmentedControl radio group', run: function () {
      const out = [];
      if (note) {
        first.characters = SEG_A11Y[0]; if (first.name === SEG_A11Y_170[0].slice(0, 40)) first.name = SEG_A11Y[0].slice(0, 40); // text() names a layer by its first 40 characters
        const tmp = bullets(SEG_A11Y.slice(1), 312); tmp.children.slice().forEach(function (it) { list.appendChild(it); }); tmp.remove();
        out.push('SegmentedControl Usage: radio-group semantics');
      }
      if (desc) { sc.description = SEG_DESC; out.push('update SegmentedControl description'); }
      return out;
    } });
  }
  return steps;
}
// The 1.9.0 properties the Seller setup templates set; a file that lacks one gets no Seller setup templates.
function setupLacks() {
  const want = { Input: ['Prefix', 'Show prefix'], ChecklistItem: ['Detail', 'Show detail', 'Show chevron'], Field: ['Show status'] };
  const out = [];
  Object.keys(want).forEach(function (n) { const r = S.sets[n]; want[n].forEach(function (k) { if (!r || !r.keys[k]) out.push(n + ' ' + k); }); });
  // and the layers those properties show: a variant changed by hand that did not get them holds the templates back too
  const has = function (node, name) { return node.children.some(function (k) { return k.name === name; }); };
  const inp = S.sets.Input, ck = S.sets.ChecklistItem, fr = S.sets.Field;
  const noPrefix = inp && inp.set ? inp.set.children.filter(function (v) { return v.variantProperties.Type === 'Text' && !has(v, 'prefix'); }).length : 0;
  if (noPrefix) out.push('Input prefix layer (' + noPrefix + ' Type=Text variants without it)');
  const noDetail = ck && ck.set ? ck.set.children.filter(function (v) { const c = v.children.filter(function (k) { return k.name === 'content'; })[0]; return !c || !has(c, 'detail') || !has(v, 'chevron'); }).length : 0;
  if (noDetail) out.push('ChecklistItem detail and chevron (' + noDetail + ' variants without them)');
  if (fr && fr.comp && !fr.comp.children.some(function (k) { return k.name === 'status' && k.type === 'INSTANCE'; })) out.push('Field status line');
  return out;
}
