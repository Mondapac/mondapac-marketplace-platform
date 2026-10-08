// ---------------------------------------------------------------- release 1.10.0 "Seller admin" components (sellers ux.md section 4, planned there as 1.4.0)
// SettingRow is new; CheckboxRow gains State=Saving and Show undo (34_components_panel.js). Build library makes both on Forms & selection;
// Update library adds SettingRow and changes the plugin's own CheckboxRow in place (propertySteps1100, below; see 50_main.js step 2g).

// ---- SettingRow (Forms & selection): one setting that saves on its own. C1 Admin-only settings on the seller page (P2), Seller settings (P4)
// and every later setting (SEL-15). The control is a swap slot: a Switch, or a SegmentedControl for two or three answers.
const SETTINGROW_AXES = { State: ['Default', 'Saving', 'Locked', 'Error'] };
// [icon, icon colour, sample message, text colour]: Locked gives the reason, Error says the save failed. The Error text has no copy key yet (sample).
const SETTINGROW_MSG = { Locked: ['lock', 'icon/muted', 'Your role can view these settings but not change them.', 'text/secondary'], Error: ['alert-circle', 'status/critical/fg', 'We couldn’t save this change. Try again.', 'status/critical/fg'] };
const SETTINGROW_KEYS = ['Label', 'Description', 'Meta', 'Message', 'Show meta', 'Control'];
function settingRowOpts(control) {
  return { width: 1368, desc: 'One setting that saves on its own (1.10.0): a label, a description, the control and the line "Changed by {name} on {date}" (Meta, read from the setting itself; Show meta off before the first change). Control is a swap slot (default a Switch, preferred Switch and SegmentedControl) and an exposed instance, so its value and segment labels are set from the row. State: Default; Saving while the request runs (the control shows the new value, "Saving…" with a still icon, aria-busy); Locked when the role cannot change it or the feature is not there yet (the control is drawn at 40% and stays focusable with aria-disabled; Message gives the reason in text, never a tooltip); Error when the save failed (the control shows the old value again; Message says so). A change with a consequence goes through a confirm dialog first (D3). A list that follows a choice, such as the CheckboxRow list for "Only selected types", sits under the row, not inside it. Width size/form-max; fill the card in screens.',
    text: [{ prop: 'Label', node: 'label', def: 'Require approval for new sellers' }, { prop: 'Description', node: 'description', def: 'New sign-ups wait for a person to approve them.' }, { prop: 'Meta', node: 'meta', def: 'Changed by Layla Haddad on 6 Oct 2026' }, { prop: 'Message', node: 'message-text', def: SETTINGROW_MSG.Locked[2] }],
    bool: [{ prop: 'Show meta', node: 'meta', def: true }], swap: [{ prop: 'Control', node: 'control', comp: control }] };
}
function settingRowVariant(c, p) {
  const m = SETTINGROW_MSG[p.State];
  const lines = [text('Require approval for new sellers', 'Body/Strong', 'text/primary', { name: 'label', sizeH: 'FILL' }), text('New sign-ups wait for a person to approve them.', 'Body/Small', 'text/secondary', { name: 'description', sizeH: 'FILL' })];
  if (p.State === 'Saving') lines.push(frame({ name: 'saving', dir: 'H', gap: 'space/1-5', align: 'center' }, [icon('refresh-cw', 'icon/muted', 14), text('Saving…', 'Body/Small', 'text/muted', { name: 'saving-text' })]));
  if (m) lines.push(frame({ name: 'message', dir: 'H', gap: 'space/1-5', align: 'start', sizeH: 'FILL' }, [frame({ name: 'icon-box', dir: 'H', pad: [1, 0, 0, 0] }, [icon(m[0], m[1], 14)]), text(m[2], 'Body/Small', m[3], { name: 'message-text', sizeH: 'FILL' })]));
  lines.push(text('Changed by Layla Haddad on 6 Oct 2026', 'Caption/Default', 'text/muted', { name: 'meta', sizeH: 'FILL' }));
  const control = inst('Switch', { On: 'True', Size: 'Md' }, { name: 'control' });
  if (p.State === 'Locked') control.opacity = 0.4;
  body(c, { dir: 'H', w: 'size/form-max', pad: ['space/4', 'space/5', 'space/4', 'space/5'], gap: 'space/4', align: 'start', stroke: 'border/row', sides: ['bottom'] }, [
    frame({ name: 'content', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, lines),
    frame({ name: 'control-box', dir: 'H', pad: [2, 0, 0, 0] }, [control]),
  ]);
  safe('expose control', function () { control.isExposedInstance = true; });
}
// Switch and SegmentedControl are the preferred values of the Control slot.
function settingRowPreferred(set, key) {
  const sw = S.sets.Switch, seg = S.sets.SegmentedControl;
  const want = [];
  if (sw && sw.set) want.push({ type: 'COMPONENT_SET', key: sw.set.key });
  if (seg && seg.comp) want.push({ type: 'COMPONENT', key: seg.comp.key });
  if (want.length) safe('SettingRow preferred controls', function () { set.editComponentProperty(key, { preferredValues: want }); });
}
function settingRowBlock(root) {
  const control = S.sets.Switch.set.children.filter(function (v) { return v.name === 'On=True, Size=Md'; })[0];
  const set = makeSet('SettingRow', SETTINGROW_AXES, settingRowVariant, settingRowOpts(control));
  settingRowPreferred(set, S.sets.SettingRow.keys.Control);
  componentBlock(root, set, { title: 'SettingRow', summary: 'One setting that saves on its own (1.10.0): Admin-only settings on the seller page (C1), Seller settings (P4) and every later setting.',
    use: ['One setting per row inside a Card; each row saves on its own, after a confirm dialog when the change has a consequence.', 'Control: a Switch for on or off; a SegmentedControl for two or three answers (All types or Only selected types). A list that follows the choice sits under the row.', 'Saving while the request runs; Locked when the role cannot change it or the feature is not there yet; Error when the save failed (the control shows the old value again).', 'Meta is "Changed by {name} on {date}", from the setting itself.'],
    props: ['Label, Description, Meta, Message (text); Show meta (boolean)', 'Control (instance swap, Switch or SegmentedControl), exposed so its value is set from the row', 'State: Default, Saving, Locked, Error'],
    a11y: ['The label names the control (role="switch", or a radio group for a SegmentedControl); the description and the meta line are tied with aria-describedby.', 'Locked: the control is aria-disabled and stays focusable; the reason is text beside it, never a tooltip.', 'Saving: aria-busy on the row and "Saving…" in a role="status" region. Error is announced once and keeps focus on the control.', 'Every state is words with an icon, never colour alone.'],
    dont: ['A separate Save button for one setting.', 'Hiding a setting the role cannot change.'] });
  return set;
}

// ---- Update library (1.10.0): CheckboxRow State=Saving and Show undo, added in place to the plugin's own set.
// A first, read-only pass decides what the set needs and reports variants or a Usage panel changed by hand; run() then edits only the set
// and its documentation block. The undo link is added hidden at the end of each 1.8.0 variant, as Show undo defaults to off.
const CHECKBOXROW_USE_180 = ['A permission with a name and a one-line description. A permission the user cannot give is shown disabled with its reason, not hidden.', 'Read-only on a system or default role.'];
const CHECKBOXROW_SUMMARY_180 = 'One permission on the role editor and later multi-select lists (1.8.0). 2 values by 5 states.';
function checkboxRowDocs(set) {
  const named = function (n, name) { return n && n.children ? n.children.filter(function (k) { return k.name === name; })[0] : null; };
  const row = set.parent && set.parent.type === 'FRAME' && set.parent.name === 'Component + usage' ? set.parent : null;
  const panel = named(row, 'Usage'); const sec = row && row.parent;
  const head = named(sec, 'Section header'); const summary = head && head.children.filter(function (k) { return k.type === 'TEXT'; })[1];
  const list = function (g) { const l = named(named(panel, g), 'List'); return l ? l.children : null; };
  const texts = function (items) { return items ? items.map(function (it) { return it.children[1] && it.children[1].type === 'TEXT' ? it.children[1].characters : null; }) : null; };
  return { summary: summary, use: list('When to use'), props: list('Properties'), a11y: list('Accessibility'), useList: named(named(panel, 'When to use'), 'List'), a11yList: named(named(panel, 'Accessibility'), 'List'), texts: texts };
}
function propertySteps1100(own) {
  const steps = [];
  const rec = S.sets.CheckboxRow;
  if (!rec || !rec.set) return steps;
  if (!own('CheckboxRow')) { log('ℹ skipped CheckboxRow State=Saving and Show undo: the CheckboxRow set is not the plugin\'s'); return steps; }
  const deps = ['Button', 'Badge', 'Checkbox'].filter(function (n) { return !own(n); });
  if (deps.length) { log('ℹ skipped CheckboxRow State=Saving and Show undo: they need the plugin\'s ' + deps.join(', ')); return steps; }
  const set = rec.set;
  const lacking = set.children.filter(function (v) { return !v.children.some(function (k) { return k.name === 'undo'; }); });
  const odd = lacking.filter(function (v) { return v.layoutMode !== 'HORIZONTAL' || v.children.map(function (k) { return k.name; }).join() !== 'checkbox,content,badge'; });
  if (odd.length) log('ℹ skipped the CheckboxRow undo action in ' + odd.map(function (v) { return v.name; }).join('; ') + ': its layers were changed by hand');
  const todo = lacking.filter(function (v) { return odd.indexOf(v) < 0; });
  const have = {}; set.children.forEach(function (v) { have[variantName(sortedProps(v.variantProperties, rec.axes))] = 1; });
  const saving = combos(CHECKBOXROW_AXES).filter(function (p) { return p.State === 'Saving' && !have[variantName(sortedProps(p, rec.axes))]; });
  const prop = !rec.keys['Show undo']; const desc = set.description === CHECKBOXROW_DESC_180;
  // the documentation block: replaced or extended only when it still holds the 1.8.0 text
  const d = checkboxRowDocs(set); const t = d.texts;
  const same = function (a, b) { return !!a && a.length === b.length && a.every(function (x, i) { return x === b[i]; }); };
  const old = d.summary && d.summary.characters === CHECKBOXROW_SUMMARY_180 && same(t(d.use), CHECKBOXROW_USE_180) && same(t(d.props), CHECKBOXROW_PROPS_180) && same(t(d.a11y), CHECKBOXROW_A11Y_180);
  const done = d.summary && d.summary.characters !== CHECKBOXROW_SUMMARY_180 && same(t(d.props), CHECKBOXROW_PROPS) && same(t(d.a11y), CHECKBOXROW_A11Y);
  if (!old && !done) log('ℹ skipped CheckboxRow Usage: Saving and Show undo: the documentation block was changed by hand');
  if (prop || todo.length || saving.length || desc || old) steps.push({ node: set, label: 'CheckboxRow Saving and undo', run: function () {
    const out = [];
    if (prop) { rec.keys['Show undo'] = set.addComponentProperty('Show undo', 'BOOLEAN', false); out.push('CheckboxRow property Show undo'); }
    todo.forEach(function (v) { add(v, checkboxRowUndo()); });
    set.children.forEach(function (v) { wireVariant(v, rec.keys, { bool: [{ prop: 'Show undo', node: 'undo' }] }); });
    if (todo.length) out.push('CheckboxRow undo action (' + todo.length + ' variants)');
    const made = saving.length ? addVariants(rec, saving, checkboxRowVariant, CHECKBOXROW_OPTS, 'Value') : [];
    if (made.length) out.push('variants added to CheckboxRow (' + made.length + '): State=Saving');
    if (desc) { set.description = CHECKBOXROW_DESC; out.push('update CheckboxRow description'); }
    if (old) {
      const swapText = function (node, from, to) { node.characters = to; if (node.name === from.slice(0, 40)) node.name = to.slice(0, 40); }; // text() names a layer by its first 40 characters
      swapText(d.summary, CHECKBOXROW_SUMMARY_180, 'One permission on the role editor and later multi-select lists (1.8.0); one reviewer check that saves on its own (1.10.0). 2 values by 6 states.');
      d.props.forEach(function (it, i) { swapText(it.children[1], CHECKBOXROW_PROPS_180[i], CHECKBOXROW_PROPS[i]); });
      [[d.useList, 'A reviewer check (P3, 1.10.0): ticking saves it at once (Saving), then "Recorded by {name} on {dateTime}" and "Undo".'], [d.a11yList, CHECKBOXROW_A11Y[CHECKBOXROW_A11Y.length - 1]]].forEach(function (x) {
        const w = x[0].children[0].children[1].width + 16; const tmp = bullets([x[1]], w); tmp.children.slice().forEach(function (it) { x[0].appendChild(it); }); tmp.remove();
      });
      out.push('CheckboxRow Usage: Saving and Show undo');
    }
    return out;
  } });
  return steps;
}
// What the 1.10.0 templates need from CheckboxRow and SettingRow; a file that lacks one gets no Seller admin templates.
function sellerAdminLacks() {
  const out = [];
  const cb = S.sets.CheckboxRow, sr = S.sets.SettingRow;
  if (cb && cb.set) {
    if (!cb.keys['Show undo']) out.push('CheckboxRow Show undo');
    const noUndo = cb.set.children.filter(function (v) { return !v.children.some(function (k) { return k.name === 'undo'; }); }).length;
    if (noUndo) out.push('CheckboxRow undo action (' + noUndo + ' variants without it)');
  }
  if (sr && sr.set) SETTINGROW_KEYS.forEach(function (k) { if (!sr.keys[k]) out.push('SettingRow ' + k); });
  return out;
}
