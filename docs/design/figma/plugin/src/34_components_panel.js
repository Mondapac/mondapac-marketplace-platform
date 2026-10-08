// ---------------------------------------------------------------- release 1.8.0 "Panel" components
// Select, Textarea, CheckboxRow (Forms & selection); Toast, DialogBody + Dialog (Status & feedback); EmptyState and the
// State=Loading variants of TableCell (Tables & collections). Spec: figma-1.2.0-spec.md (renumbered 1.8.0), section 2.
// Built by "Build library" on their library pages and added to an existing file by "Update library" (see 50_main.js).
// The page subtitles repeat the ones the build uses, so Update library can find (or, if missing, recreate) each page's root frame.
const PANEL_SUBTITLE = {
  'Forms & selection': 'Inputs, checkboxes, switches, segmented controls, tabs and filter chips.',
  'Status & feedback': 'Badges, status, certificates, health, deadlines, meters and banners. State is always a word plus a shape, never colour alone.',
  'Tables & collections': 'Index pages: header cells, cells by content type, pagination and the floating bulk action bar. Tables use real <table> markup in code.',
};
// The components 1.8.0 adds, by library page (hosts) in the order Update library builds them.
const PANEL_SETS = ['Select', 'Textarea', 'CheckboxRow', 'Toast', 'DialogBody', 'Dialog', 'EmptyState'];

// ---- Select (Forms & selection): the trigger of a single-choice list; the list is a Menu
const SELECT_AXES = { State: ['Default', 'Hover', 'Focus', 'Open', 'Filled', 'Disabled', 'Error'] };
const SELECT_OPTS = { width: 1040, desc: 'Single choice from a short list (role picker). This is the trigger only; the list is a Menu instance that a template or the code places below it with a 4 px gap, as wide as the trigger. Wrap it in Field for the label, helper and error. States: Default, Hover, Focus (Focus/Ring), Open (primary border, chevron turned 180 degrees, list shown), Filled, Disabled and Error. Value is the placeholder text, or the chosen text while Filled; Leading icon is off by default. Rows of the list are MenuItem instances: the name, a one-line description, and a trailing check on the selected row (MenuItem State=Selected); a choice the user may not make is a disabled MenuItem with its reason on the description line. Code builds a listbox, not a native <select>.',
  text: [{ prop: 'Value', node: 'value', def: 'Select a role' }], bool: [{ prop: 'Leading icon', node: 'icon-leading', def: false }], swap: [{ prop: 'Icon', node: 'icon-leading', def: 'user' }] };
function selectVariant(c, p) {
  const border = { Error: 'status/critical/solid', Focus: 'action/primary', Open: 'action/primary', Hover: 'text/muted' }[p.State] || 'border/input';
  const filled = p.State === 'Filled';
  body(c, { dir: 'H', w: 280, h: 'size/control', pad: [0, 'space/2-5', 0, 'space/2-5'], gap: 'space/2', align: 'center', fill: p.State === 'Disabled' ? 'bg/muted' : 'bg/surface', stroke: border, radius: 'radius/control' }, [
    icon('user', 'icon/muted', 16),
    text(filled ? 'Seller reviewer' : 'Select a role', 'Body/Default', filled ? 'text/primary' : 'text/muted', { name: 'value', sizeH: 'FILL', truncate: true }),
    icon('chevron-down', 'icon/muted', 16),
  ]);
  c.children[0].name = 'icon-leading'; c.children[0].visible = false;
  c.children[2].name = 'chevron';
  if (p.State === 'Open') c.children[2].rotation = 180;
  if (p.State === 'Focus') focusRing(c);
}
function selectBlock(root) {
  const sel = makeSet('Select', SELECT_AXES, selectVariant, SELECT_OPTS);
  componentBlock(root, sel, { title: 'Select', summary: 'The trigger for a short list of choices (1.8.0). The list is a Menu; wrap the trigger in Field.',
    use: ['One choice from about 8 rows or fewer: the role picker in the invite and change-role dialogs.', 'Open shows the list below the trigger; the selected row has the check.'],
    props: ['Value (text), Leading icon (boolean), Icon (instance swap)', 'State: Default, Hover, Focus, Open, Filled, Disabled, Error'],
    a11y: ['Trigger role="combobox" with aria-haspopup="listbox", aria-expanded and aria-controls; the list is role="listbox" with role="option" rows and aria-selected.', 'Disabled options stay focusable with aria-disabled and their reason in the description, so touch users can read it.', 'Arrow keys move, Home and End jump, type-ahead, Enter selects, Esc closes and returns focus to the trigger.', 'Error uses aria-invalid and aria-describedby. Border contrast is 3:1 (border/input). Touch: 48 px high, list rows 48 px.'],
    dont: ['A native <select> look-alike with no keyboard model.', 'A list longer than about 8 rows (add search later).', 'A disabled option with no reason.'] });
  return sel;
}

// ---- Textarea (Forms & selection)
const TEXTAREA_AXES = { State: ['Default', 'Hover', 'Focus', 'Filled', 'Disabled', 'Error'] };
const TEXTAREA_OPTS = { width: 1040, desc: 'Multi-line text, such as the reason a seller reads. Same states and colours as Input. Wrap it in Field for the label, helper, character counter ("{n} / {max}") and error. Min height is three lines of Body/Default plus padding; it grows with the text. Value is empty by default (a placeholder is not a label). Vertical resize only in code, no resize grip in Figma. dir="auto"; paste is never blocked; no maxlength truncation without the visible counter.',
  text: [{ prop: 'Value', node: 'value', def: '' }] };
function textareaVariant(c, p) {
  const border = { Error: 'status/critical/solid', Focus: 'action/primary', Hover: 'text/muted' }[p.State] || 'border/input';
  const filled = p.State === 'Filled';
  body(c, { dir: 'V', w: 280, pad: 'space/2-5', fill: p.State === 'Disabled' ? 'bg/muted' : 'bg/surface', stroke: border, radius: 'radius/control' }, [
    text(filled ? 'Your Halal certificate is not readable. Upload a clear copy of all pages, then contact us to continue.' : '', 'Body/Default', filled ? 'text/primary' : 'text/muted', { name: 'value', sizeH: 'FILL' }),
  ]);
  c.minHeight = 80; // three lines of Body/Default (20 px) plus the 10 px padding above and below
  if (p.State === 'Focus') focusRing(c);
}
function textareaBlock(root) {
  const ta = makeSet('Textarea', TEXTAREA_AXES, textareaVariant, TEXTAREA_OPTS);
  componentBlock(root, ta, { title: 'Textarea', summary: 'A longer free-text field (1.8.0): the reason a seller reads in the reject and suspend dialogs. Same states as Input.',
    use: ['Wrap it in Field: label, helper, the counter slot and the error message.'],
    props: ['Value (text)', 'State: Default, Hover, Focus, Filled, Disabled, Error'],
    a11y: ['Label, helper and counter come from Field; the counter is announced politely and not on every keystroke.', 'dir="auto". Paste is never blocked.', 'Error: aria-invalid and aria-describedby; the message is text with an icon.'],
    dont: ['maxlength that cuts text without a visible counter.', 'A placeholder in place of the label.'] });
  return ta;
}

// ---- CheckboxRow (Forms & selection): one permission on the role editor; from 1.10.0 also one reviewer check (P3)
// 1.10.0 "Seller admin" (sellers ux.md section 4): State=Saving (a check saves the moment it is ticked) and Show undo (a link Button "Undo" at the end
// of a recorded check). "Required" is the badge slot with Leading None and Label "Required"; "Recorded by {name} on {dateTime}" is the Description.
const CHECKBOXROW_AXES_180 = { Value: ['Unchecked', 'Checked'], State: ['Default', 'Hover', 'Focus', 'Disabled', 'Read-only'] };
const CHECKBOXROW_AXES = { Value: ['Unchecked', 'Checked'], State: ['Default', 'Hover', 'Focus', 'Disabled', 'Read-only', 'Saving'] };
const CHECKBOXROW_DESC_180 = 'One permission row: a Checkbox, a label, a one-line description and an optional "Protected" Badge (lock icon plus text). The whole row is one <label> (at least 32 px high; 24 px checkbox hit area). Disabled gives the reason in text on the description line (never a tooltip) and stays focusable (aria-disabled). Read-only is for a system or default role where nothing can change: it keeps full contrast, has no hover, and screen readers get "Granted" or "Not granted" as hidden text. Focus puts the Focus/Ring on the row. Group rows per resource in a <fieldset> with a <legend>; the group "Select all in {group}" is a Checkbox with Value=Indeterminate when some rows are on.';
const CHECKBOXROW_DESC = CHECKBOXROW_DESC_180 + ' From 1.10.0 it is also one reviewer check (P3): the check saves the moment it is ticked, State=Saving shows the new value with "Saving…" in place of the description (aria-busy on the row; the icon is drawn still and never spins under reduced motion), then the description reads "Recorded by {name} on {dateTime}". Show undo shows a link Button "Undo" at the end of a recorded check: it sets the check back to not done, and the approval guard counts it missing again. A required check sets the badge to Leading None and Label "Required" (a nested override of the badge slot).';
// 1.8.1: columns are the 2 Values (States as rows), so the set is 1176 wide; with State as columns it was 2960 and stuck out of its documentation row.
const CHECKBOXROW_OPTS = { width: 1280, colAxis: 'Value', desc: CHECKBOXROW_DESC,
  text: [{ prop: 'Label', node: 'label', def: 'View seller accounts' }, { prop: 'Description', node: 'description', def: 'See sellers, their status and their team.' }], bool: [{ prop: 'Show badge', node: 'badge', def: false }, { prop: 'Show undo', node: 'undo', def: false }] };
// The 1.10.0 node: the "Undo" link at the end of the row. It starts hidden, like its property.
function checkboxRowUndo() { const b = inst('Button', { Variant: 'Link', Size: 'Sm', State: 'Default', Label: 'Undo' }, { name: 'undo' }); b.visible = false; return b; }
function checkboxRowVariant(c, p) {
  const dis = p.State === 'Disabled'; const saving = p.State === 'Saving';
  const badge = inst('Badge', { Tone: 'Neutral', Leading: 'Icon', Label: 'Protected', Icon: { icon: 'lock' } }, { name: 'badge' });
  const desc = text(dis ? 'You can’t give a permission you don’t have.' : 'See sellers, their status and their team.', 'Caption/Default', 'text/muted', { name: 'description', sizeH: 'FILL' });
  const lines = [text('View seller accounts', 'Body/Default', dis ? 'text/muted' : 'text/primary', { name: 'label', sizeH: 'FILL' }), desc];
  // Saving: "Saving…" with a still icon takes the description's place; the description stays wired, hidden in this state.
  if (saving) { desc.visible = false; lines.push(frame({ name: 'saving', dir: 'H', gap: 'space/1', align: 'center' }, [icon('refresh-cw', 'icon/muted', 12), text('Saving…', 'Caption/Default', 'text/muted', { name: 'saving-text' })])); }
  body(c, { dir: 'H', w: 560, px: 'space/3', py: 'space/2-5', gap: 'space/3', align: 'start', fill: p.State === 'Hover' ? 'bg/subtle' : null, stroke: 'border/row', sides: ['bottom'] }, [
    inst('Checkbox', { Value: p.Value, State: p.State === 'Focus' ? 'Focus' : (dis ? 'Disabled' : 'Default') }, { name: 'checkbox' }),
    frame({ name: 'content', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, lines),
    badge,
    checkboxRowUndo(),
  ]);
  badge.visible = false;
  if (p.State === 'Focus') focusRing(c);
}
const CHECKBOXROW_PROPS_180 = ['Label, Description (text); Show badge (boolean, the "Protected" Badge)', 'Value: Unchecked, Checked. State: Default, Hover, Focus, Disabled, Read-only'];
const CHECKBOXROW_PROPS = ['Label, Description (text); Show badge (boolean, the "Protected" Badge, or "Required" on a reviewer check); Show undo (boolean, 1.10.0)', 'Value: Unchecked, Checked. State: Default, Hover, Focus, Disabled, Read-only, Saving (1.10.0)'];
const CHECKBOXROW_A11Y_180 = ['The row is one <label>; disabled rows use aria-disabled and stay focusable with the reason tied by aria-describedby.', 'Read-only keeps the checked state readable ("Granted" or "Not granted" as hidden text).', '"Protected" is text plus the lock icon, never colour alone.', 'A group per resource is a <fieldset> with a <legend>.'];
const CHECKBOXROW_A11Y = CHECKBOXROW_A11Y_180.concat(['Saving (1.10.0): aria-busy on the row and "Saving…" in a role="status" region; "Recorded" is announced once. "Undo" is named "Undo {check}" and keeps focus on the row after it.']);
function checkboxRowBlock(root) {
  const cr = makeSet('CheckboxRow', CHECKBOXROW_AXES, checkboxRowVariant, CHECKBOXROW_OPTS);
  componentBlock(root, cr, { title: 'CheckboxRow', summary: 'One permission on the role editor and later multi-select lists (1.8.0); one reviewer check that saves on its own (1.10.0). 2 values by 6 states.',
    use: ['A permission with a name and a one-line description. A permission the user cannot give is shown disabled with its reason, not hidden.', 'Read-only on a system or default role.', 'A reviewer check (P3, 1.10.0): ticking saves it at once (Saving), then "Recorded by {name} on {dateTime}" and "Undo".'],
    props: CHECKBOXROW_PROPS,
    a11y: CHECKBOXROW_A11Y,
    dont: ['A tooltip for the reason.', 'Hiding a permission the user cannot give.'] });
  return cr;
}

// Field's Control slot takes Input, Select and Textarea as preferred swap values (1.8.0). Returns true when it changed something.
function fieldPreferred() {
  const f = S.sets.Field, inp = S.sets.Input, sel = S.sets.Select, ta = S.sets.Textarea;
  if (!f || !f.comp || !f.keys.Control || !inp || !inp.set || !sel || !sel.set || !ta || !ta.set) return false;
  const want = [inp.set, sel.set, ta.set].map(function (n) { return { type: 'COMPONENT_SET', key: n.key }; });
  const have = f.comp.componentPropertyDefinitions[f.keys.Control].preferredValues || [];
  if (want.every(function (w) { return have.some(function (h) { return h.key === w.key; }); })) return false;
  f.comp.editComponentProperty(f.keys.Control, { preferredValues: want });
  return true;
}

// ---- Toast (Status & feedback)
const TOAST_TONE = { Success: ['status/success/track', 'check', 'status/success/fg'], Critical: ['status/critical/border', 'alert-circle', 'status/critical/fg'] };
const TOAST_OPTS = { width: 760, gapX: 40, desc: 'Confirmation after an action ("Role saved…"). It never carries the only copy of a reason or a code. Tone Success (check) or Critical (alert-circle); the icon and the words carry the meaning, the border colour only reinforces it. Width is size/dialog-sm (fills the width in a phone frame). Position: bottom end on desktop, bottom centre on phones above the BottomTabBar and the safe area, and never over the dialog it came from (it appears after the dialog closes). role="status" (Success, polite) or role="alert" (Critical); one live region per page; visible at least 6 seconds, paused on hover and focus, dismissed with Esc or the close button (named "Close"); no slide under prefers-reduced-motion.',
  text: [{ prop: 'Message', node: 'message', def: 'Role saved. Changes apply from each person’s next action.' }, { prop: 'Action', node: 'action', def: 'View role' }], bool: [{ prop: 'Show action', node: 'action', def: false }] };
function toastVariant(c, p) {
  const t = TOAST_TONE[p.Tone];
  body(c, { dir: 'H', w: 'size/dialog-sm', pad: ['space/3', 'space/4', 'space/3', 'space/4'], gap: 'space/3', align: 'start', fill: 'bg/surface', stroke: t[0], radius: 'radius/card', effect: 'Elevation/Floating' }, [
    icon(t[1], t[2], 20),
    text('Role saved. Changes apply from each person’s next action.', 'Body/Default', 'text/primary', { name: 'message', sizeH: 'FILL' }),
    text('View role', 'Body/Strong', 'text/link', { name: 'action' }),
    inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'close' }),
  ]);
  c.children[0].name = 'icon';
  c.children[2].visible = false;
}
function toastBlock(root) {
  const toast = makeSet('Toast', { Tone: ['Success', 'Critical'] }, toastVariant, TOAST_OPTS);
  componentBlock(root, toast, { title: 'Toast', summary: 'A short confirmation after an action (1.8.0). Message, an optional text action and a close button.',
    use: ['After a dialog closes or a save: "Role saved…", "Invitation sent to {email}.".', 'Critical for a failure that is not tied to a field.'],
    props: ['Message, Action (text); Show action (boolean); Tone: Success, Critical', 'Close is an IconButton named "Close" (identity.common.action.close)'],
    a11y: ['role="status" (Success) or role="alert" (Critical); one live region per page.', 'Visible at least 6 seconds, pauses on hover and focus, closes with Esc.', 'Respects prefers-reduced-motion (no slide).'],
    dont: ['The only copy of a reason or a code in a toast.', 'A toast over the dialog it came from.'] });
  return toast;
}

// ---- DialogBody + Dialog (Status & feedback)
const DIALOGBODY_TEXT = 'The change applies from their next action. They stay signed in.';
function dialogBodyBlock() {
  return makeComponent('DialogBody', function (c) {
    body(c, { dir: 'V', w: 360 }, [text(DIALOGBODY_TEXT, 'Body/Default', 'text/secondary', { name: 'body', sizeH: 'FILL' })]);
  }, { desc: 'The default content of a Dialog: one paragraph in Body/Default. Set Body from the Dialog instance (Content slot), or swap the slot for a form body built from Field, Input, Select and Textarea.', text: [{ prop: 'Body', node: 'body', def: DIALOGBODY_TEXT }] });
}
const DIALOG_AXES = { Size: ['Sm', 'Md'], Tone: ['Default', 'Destructive'], Layout: ['Centred', 'Sheet'] };
function dialogOpts(content) {
  return { width: 1400, gapX: 40, gapY: 40, skip: function (p) { return p.Layout === 'Sheet' && p.Size === 'Md'; },
    desc: 'A modal dialog over a bg/scrim scrim (the scrim belongs to the screen, not to this component). Size Sm is size/dialog-sm (400 px: confirm, change-role and invite dialogs), Md is size/dialog-md (560 px: dialogs with a reason field). Tone=Destructive makes the primary button a Destructive Button and changes nothing else; it opens with focus on Cancel (show the secondary Button in State=Focus). Layout=Sheet is for widths below 480 px: 360 here and full width in screens, top corners rounded, buttons stacked and full width with the primary first, then Cancel, both Size=Touch; it ignores Size, so Sheet by Md does not exist. Title is Heading/H2 and never truncates; Show secondary off is the single-button state (a read-only "View reason" dialog with one Close button). Content is a swap slot that defaults to DialogBody; primary and secondary are exposed Button instances, so their Label is set from the Dialog instance. role="dialog" (alertdialog when Destructive), aria-modal, aria-labelledby the title, aria-describedby the first body text; focus moves in, is trapped and returns to the trigger; Esc closes, except that a dialog holding typed text does not close on a scrim click; the page behind is inert. Max height 90% of the viewport: header and footer stay pinned and the body scrolls. No slide or fade under prefers-reduced-motion.',
    text: [{ prop: 'Title', node: 'title', def: 'Change role for Amira Said' }], bool: [{ prop: 'Show secondary', node: 'secondary', def: true }], swap: [{ prop: 'Content', node: 'content', comp: content }] };
}
function dialogVariant(c, p) {
  const sheet = p.Layout === 'Sheet'; const dest = p.Tone === 'Destructive';
  const w = sheet ? 360 : (p.Size === 'Md' ? 'size/dialog-md' : 'size/dialog-sm');
  const secondary = inst('Button', { Variant: 'Secondary', Size: sheet ? 'Touch' : 'Md', State: 'Default', Label: 'Cancel' }, { name: 'secondary', sizeH: sheet ? 'FILL' : null });
  const primary = inst('Button', { Variant: dest ? 'Destructive' : 'Primary', Size: sheet ? 'Touch' : 'Md', State: 'Default', Label: dest ? 'Deactivate account' : 'Change role' }, { name: 'primary', sizeH: sheet ? 'FILL' : null });
  body(c, { dir: 'V', w: w, fill: 'bg/surface', stroke: 'border/default', clip: true, effect: 'Elevation/Floating' }, [
    frame({ name: 'header', dir: 'H', pad: sheet ? 'space/4' : ['space/5', 'space/5', 'space/2', 'space/5'], gap: 'space/3', align: 'start', sizeH: 'FILL' }, [
      text('Change role for Amira Said', 'Heading/H2', 'text/primary', { name: 'title', sizeH: 'FILL' }),
      inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'close' }),
    ]),
    frame({ name: 'body', dir: 'V', gap: 'space/4', pad: sheet ? [0, 'space/4', 0, 'space/4'] : [0, 'space/5', 0, 'space/5'], sizeH: 'FILL' }, [inst('DialogBody', {}, { name: 'content', sizeH: 'FILL' })]),
    frame({ name: 'footer', dir: sheet ? 'V' : 'H', justify: sheet ? undefined : 'end', gap: 'space/2', pad: sheet ? 'space/4' : ['space/4', 'space/5', 'space/5', 'space/5'], sizeH: 'FILL' }, sheet ? [primary, secondary] : [secondary, primary]),
  ]);
  if (sheet) { bindNum(c, 'topLeftRadius', 'radius/card'); bindNum(c, 'topRightRadius', 'radius/card'); c.bottomLeftRadius = 0; c.bottomRightRadius = 0; }
  else radius(c, 'radius/card');
  safe('expose dialog buttons', function () { primary.isExposedInstance = true; secondary.isExposedInstance = true; });
}
function dialogBlock(root) {
  const had = S.sets.DialogBody && S.sets.DialogBody.comp; const db = had || dialogBodyBlock();
  if (!had) {
    const wrap = frame({ name: 'DialogBody', dir: 'H', pad: 32, fill: 'bg/surface', radius: 16 }); add(wrap, db);
    componentBlock(root, wrap, { title: 'DialogBody', summary: 'The default content of a Dialog (1.8.0): one paragraph.', props: ['Body (text)'] });
  }
  if (S.sets.Dialog) return S.sets.Dialog.set;
  const dlg = makeSet('Dialog', DIALOG_AXES, dialogVariant, dialogOpts(db));
  componentBlock(root, dlg, { title: 'Dialog', summary: 'Confirm, change-role, invite and add-seller dialogs, and the phone sheet (1.8.0). 6 variants: Size by Tone by Layout.',
    use: ['Confirming a consequential action: the title names the action and the object, and the primary button repeats the verb.', 'Destructive when the action cannot be undone or signs someone out; it opens with focus on Cancel.', 'Sheet below 480 px: stacked full-width buttons, primary first.'],
    props: ['Title (text); Show secondary (boolean); Content (instance swap, default DialogBody)', 'Primary and secondary are exposed Button instances: set their Label from the Dialog instance', 'Size: Sm or Md. Tone: Default or Destructive. Layout: Centred or Sheet (Sheet has no Md)'],
    a11y: ['role="dialog" (alertdialog when Destructive), aria-modal, aria-labelledby the title, aria-describedby the first body text.', 'Focus moves in, is trapped, and returns to the trigger; Esc closes; the page behind is inert.', 'A dialog holding typed text does not close on a scrim click.', 'The close button is named "Close" (identity.common.action.close).'],
    dont: ['Stacked dialogs, or a Toast over a dialog.', 'A dialog for something that can be a page.', 'A Destructive dialog that opens with focus on the primary button.'] });
  return dlg;
}

// ---- EmptyState (Tables & collections)
const EMPTY_AXES = { Size: ['Page', 'Card', 'Compact'] };
const EMPTY_OPTS = { width: 1500, gapX: 40, desc: 'What a page, a card or a list shows when it has nothing yet. Page is the page\'s H1 (Heading/H1) and fills the content area; Card sits inside a card or a table body (Heading/H2); Compact is a left-aligned row for an empty group inside a list. The icon tile is decorative (aria-hidden); the title is the heading of the region; a non-obvious state has an action (the nested Button is exposed, so set its Label from the EmptyState instance). The empty state replaces the table body; the table header and tabs stay. A failure to load is not an empty state: use InfoBanner Critical with "Try again".',
  text: [{ prop: 'Title', node: 'title', def: 'It’s just you so far' }, { prop: 'Body', node: 'body', def: 'Invite the people who help run your shop. Each person gets their own sign-in.' }], bool: [{ prop: 'Show action', node: 'action', def: true }], swap: [{ prop: 'Icon', node: 'icon', def: 'lock' }] };
function emptyStateVariant(c, p) {
  const page = p.Size === 'Page', compact = p.Size === 'Compact';
  const tile = frame({ name: 'icon-tile', dir: 'H', w: 'size/control-lg', h: 'size/control-lg', align: 'center', justify: 'center', fill: 'bg/muted', radius: 'radius/pill' }, [icon('lock', 'icon/default', 20)]);
  tile.children[0].name = 'icon';
  const titleT = text('It’s just you so far', page ? 'Heading/H1' : 'Heading/H2', 'text/primary', { name: 'title', sizeH: 'FILL' });
  const bodyT = text('Invite the people who help run your shop. Each person gets their own sign-in.', 'Body/Default', 'text/muted', { name: 'body', sizeH: 'FILL' });
  const action = inst('Button', { Variant: page ? 'Primary' : 'Secondary', Size: 'Md', State: 'Default', Label: 'Invite team member' }, { name: 'action' });
  if (compact) body(c, { dir: 'H', w: 560, pad: 'space/4', gap: 'space/3', align: 'center' }, [tile, frame({ name: 'text', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [titleT, bodyT]), action]);
  else body(c, { dir: 'V', w: page ? 640 : 560, pad: page ? 'space/10' : ['space/10', 'space/6', 'space/10', 'space/6'], gap: 'space/3', align: 'center' }, [tile, titleT, bodyT, action]);
  if (!compact) { titleT.textAlignHorizontal = 'CENTER'; bodyT.textAlignHorizontal = 'CENTER'; }
  safe('expose action', function () { action.isExposedInstance = true; });
}
function emptyStateBlock(root) {
  const es = makeSet('EmptyState', EMPTY_AXES, emptyStateVariant, EMPTY_OPTS);
  componentBlock(root, es, { title: 'EmptyState', summary: 'Nothing here yet (1.8.0). Page, Card and Compact, each with an icon, a title, a line of help and an optional action.',
    use: ['Page: a page with no access or no record (its title is the page H1).', 'Card: an empty list inside a card or a table body. Compact: an empty group inside a list ("No custom roles yet").', 'Icon: lock, users, search or check; pick it with the Icon swap.'],
    props: ['Title, Body (text); Show action (boolean); Icon (instance swap)', 'The action is an exposed Button: set its Label from the EmptyState instance', 'Size: Page, Card, Compact'],
    a11y: ['The title is the heading of the region; the icon is aria-hidden.', 'A state the user can act on has an action.'],
    dont: ['A sad illustration.', 'An empty state with no way forward when the user can act.', 'An empty state for a load failure: use InfoBanner Critical with "Try again".'] });
  return es;
}

// ---- TableCell State=Loading (Tables & collections): skeleton shapes in bg/muted, static in Figma (the code shimmers under prefers-reduced-motion: no-preference)
function skBar(w, h) { return rect({ name: 'skeleton', w: w === 'fill' ? 10 : w, h: h, fill: 'bg/muted', radius: 'radius/chip', sizeH: w === 'fill' ? 'FILL' : undefined }); }
// The layers of a Loading cell for each TableCell Type (Header has no Loading variant).
function tcSkeleton(type) {
  if (type === 'Text') return [skBar('fill', 'space/3')];
  if (type === 'Two-line') return [frame({ name: 'lines', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [skBar('fill', 'space/3'), skBar('size/sidebar-collapsed', 'space/2')])];
  if (type === 'Number') return [skBar('space/10', 'space/3')];
  if (type === 'Checkbox') return [rect({ name: 'skeleton', w: 'size/icon', h: 'size/icon', fill: 'bg/muted', radius: 'radius/chip' })];
  return [rect({ name: 'skeleton', w: 'size/icon', h: 'size/icon', fill: 'bg/muted', radius: 'radius/pill' })]; // Actions: a circle
}
const TABLECELL_TYPES_LOADING = ['Text', 'Two-line', 'Number', 'Checkbox', 'Actions'];
const TABLECELL_DESC_170 = 'Build rows from cells: fixed width for short columns, Fill for the main column.';
const TABLECELL_DESC = TABLECELL_DESC_170 + ' Loading shows skeleton bars; build rows from it for 8 skeleton rows (the table header and tabs stay, the region is aria-busy and the skeleton cells are aria-hidden).';
// Update library: add State=Loading to a TableCell set the plugin made, by cloning "Type=T, State=Default" (no combineAsVariants on the existing set).
// Returns the new variants. Existing variants, instances and their properties are not touched; the new column sits right of the existing ones.
function addTableCellLoading() {
  const set = S.sets.TableCell.set; const made = [];
  const todo = TABLECELL_TYPES_LOADING.filter(function (t) { return !set.children.some(function (c) { return c.name === 'Type=' + t + ', State=Loading'; }) && set.children.some(function (c) { return c.name === 'Type=' + t + ', State=Default'; }); });
  if (!todo.length) return made;
  let right = 0; set.children.forEach(function (c) { right = Math.max(right, c.x + c.width); });
  // A new column right of the existing ones; when some Loading variants exist already (a partly updated file) the new ones join their column.
  const there = set.children.filter(function (c) { return /State=Loading/.test(c.name); });
  const x = there.length ? there[0].x : right + 24; let colW = 0;
  todo.forEach(function (t) {
    const src = set.children.filter(function (c) { return c.name === 'Type=' + t + ', State=Default'; })[0];
    const c = src.clone(); c.name = 'Type=' + t + ', State=Loading';
    c.children.slice().forEach(function (k) { k.remove(); });
    tcSkeleton(t).forEach(function (n) { add(c, n); });
    set.appendChild(c);
    c.x = x; c.y = src.y; colW = Math.max(colW, c.width);
    made.push(c); S.counts.variants++;
  });
  set.resize(Math.max(set.width, x + colW + 32), set.height);
  return made;
}
