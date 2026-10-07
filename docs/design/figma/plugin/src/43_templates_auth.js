// ---------------------------------------------------------------- release 1.7.0 templates: Auth (A1 to A11) and Seller · Your seller account (S1)
// identity ux.md 3.0, 3.1, 3.2 S1, section 5 (en-AU copy) and 8.1 item 1. Every frame is built from library instances,
// in touch density (3.0 rule 1). Desktop frames are 1280 wide (form column 45% = 576, AuthShowcase 55%); phone frames are
// 360 wide with the form column alone and a space/4 gutter.
const AUTH = {
  Seller: { type: 'Seller account', icon: 'store', panel: 'Seller Centre', email: 'yusuf@kurabyfresh.example', noun: 'seller' },
  Admin: { type: 'Admin account', icon: 'shield-check', panel: 'Admin', email: 'layla.haddad@mondapac.example', noun: 'admin' },
};
const AUTH_SUPPORT = 'Need help? Email support@mondapac.example.';
const AUTH_POLICY = 'Use at least 15 characters. A short sentence works well.';
const AUTH_PRIVACY = 'We collect these details to create and protect your account. Read how we handle them in our privacy policy.';
const AUTH_SEPARATE = 'This is a seller account. It’s separate from any customer account that uses the same email.';

// Touch density for a whole frame: a mode where the plan has modes, otherwise a rebind to "Dimension · Touch".
function applyDensity(node, density) {
  if (S.modes.dim) node.setExplicitVariableModeForCollection(S.dimModes.collection, density === 'touch' ? S.dimModes.touch : S.dimModes.desktop);
  else { const m = pairMaps(S.dim, S.dimTouch); rebindTree(node, density === 'touch' ? m.ab : m.ba); }
  node.setPluginData('density', density);
}
function accountBadge(ws) { return inst('Badge', { Tone: 'Neutral', Leading: 'Icon', Label: AUTH[ws].type, Icon: { icon: AUTH[ws].icon } }, { name: 'account-type' }); }
function authTitle(s) { return text(s, 'Heading/H1', 'text/primary', { name: 'title', sizeH: 'FILL' }); }
function authBody(s) { return text(s, 'Body/Default', 'text/secondary', { name: 'body', sizeH: 'FILL' }); }
function authNote(s, name) { return text(s, 'Body/Small', 'text/muted', { name: name || 'note', sizeH: 'FILL' }); }
function authStep(s) { return text(s, 'Body/Small Strong', 'text/muted', { name: 'step' }); }
function authBanner(tone, title, bodyText) { return inst('InfoBanner', { Tone: tone, Title: title, Body: bodyText, 'Show action': false }, { name: tone === 'Critical' ? 'error-summary' : 'banner', sizeH: 'FILL' }); }
function authField(label, o) {
  o = o || {};
  const props = { Label: label, 'Show helper': !!o.helper, 'Show error': !!o.error };
  if (o.helper) props.Helper = o.helper;
  if (o.error) props.Error = o.error;
  const f = inst('Field', props, { name: 'field-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), sizeH: 'FILL' });
  const type = o.type || 'Text';
  const state = o.error ? 'Error' : (o.state || ((type === 'Text' ? o.value : o.filled) ? 'Filled' : 'Default'));
  const ctl = Object.assign({ Type: type, State: state }, prop('Input', 'Leading icon', type !== 'Text'));
  if (type === 'Text') Object.assign(ctl, prop('Input', 'Value', o.value || ''));
  setNested(f, 'control', ctl);
  return f;
}
function authPrimary(label, state) { return inst('Button', { Variant: 'Primary', Size: 'Touch', State: state || 'Default', Label: label }, { name: 'primary-action', sizeH: 'FILL' }); }
function authSecondary(label, iconName, fill) { return inst('Button', { Variant: 'Secondary', Size: 'Touch', State: 'Default', Label: label, 'Leading icon': !!iconName, Icon: { icon: iconName || 'plus' } }, { name: 'secondary-action', sizeH: fill ? 'FILL' : null }); }
function authLinks(labels) { return frame({ name: 'links', dir: 'V', align: 'start' }, labels.filter(Boolean).map(function (l) { return inst('Button', { Variant: 'Link', Size: 'Touch', State: 'Default', Label: l }, { name: 'link' }); })); }
function authCheck(label, help) {
  return frame({ name: 'checkbox-row', dir: 'H', gap: 'space/2-5', align: 'start', sizeH: 'FILL' }, [
    frame({ name: 'box', dir: 'H', pad: [2, 0, 0, 0] }, [inst('Checkbox', { Value: 'Unchecked', State: 'Default' })]),
    frame({ name: 'text', dir: 'V', gap: 'space/0-5', sizeH: 'FILL' }, [text(label, 'Touch/Body', 'text/primary', { name: 'label', sizeH: 'FILL' }), help ? authNote(help, 'help') : null]),
  ]);
}
function mailTile() { return frame({ name: 'mail-icon', dir: 'H', w: 48, h: 48, align: 'center', justify: 'center', fill: 'bg/selected', radius: 'radius/pill' }, [icon('mail', 'text/link', 24)]); }
// QR placeholder on its white plate (bg/qr). The modules use bg/auth-showcase-admin, the only token that stays dark in both
// themes; the real code is drawn by the frontend in black on bg/qr.
function qrPlate() {
  const M = 6, Q = 25, N = 21;
  const plate = frame({ name: 'qr-code', w: 176, h: 176, fill: 'bg/qr', stroke: 'border/default', radius: 'radius/control' });
  const finder = function (cx, cy) {
    add(plate, rect({ name: 'finder', w: 7 * M, h: 7 * M, fill: 'bg/auth-showcase-admin', xy: [Q + cx * M, Q + cy * M] }));
    add(plate, rect({ name: 'finder-gap', w: 5 * M, h: 5 * M, fill: 'bg/qr', xy: [Q + (cx + 1) * M, Q + (cy + 1) * M] }));
    add(plate, rect({ name: 'finder-eye', w: 3 * M, h: 3 * M, fill: 'bg/auth-showcase-admin', xy: [Q + (cx + 2) * M, Q + (cy + 2) * M] }));
  };
  finder(0, 0); finder(14, 0); finder(0, 14);
  const cells = []; let seed = 7;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if ((x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12)) continue;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    if (seed % 100 < 46) { const px = Q + x * M, py = Q + y * M; cells.push('M ' + px + ' ' + py + ' L ' + (px + M) + ' ' + py + ' L ' + (px + M) + ' ' + (py + M) + ' L ' + px + ' ' + (py + M) + ' Z'); }
  }
  add(plate, vector({ name: 'modules', d: cells.join(' '), fill: 'bg/auth-showcase-admin', closed: true }));
  return plate;
}
function keyRow() {
  return frame({ name: 'setup-key', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [
    frame({ name: 'key', dir: 'H', h: 'size/control', px: 'space/3', align: 'center', fill: 'bg/subtle', stroke: 'border/default', radius: 'radius/control', sizeH: 'FILL' }, [text('JBSW Y3DP EHPK 3PXP', 'Mono/Default', 'text/primary', { name: 'key-text' })]),
    authSecondary('Copy', 'copy'),
  ]);
}
const BACKUP_CODES = ['K7Q2M 9XW4P', '3HJ8R T6V2C', 'W5N9D 4QK7M', 'P2X6F 8RJ3T', 'C9M4V 7HW2K', 'T3K8P 5NX9D', 'F6R2W 3JC8V', 'M8V5H 2TP6Q', 'X4D7K 9MF3R', 'J2W9T 6CV4H'];
function backupCodes() {
  const col = function (list, n) { return frame({ name: 'column-' + n, dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, list.map(function (c) { return text(c, 'Mono/Default', 'text/primary'); })); };
  return frame({ name: 'backup-codes', dir: 'H', gap: 'space/6', pad: 'space/4', fill: 'bg/subtle', stroke: 'border/default', radius: 'radius/card', sizeH: 'FILL' }, [col(BACKUP_CODES.slice(0, 5), 1), col(BACKUP_CODES.slice(5), 2)]);
}

// ---- the frame: form column (bg/surface, 45%, at least 480) + AuthShowcase (55%); phone: the form column alone
function authFrame(name, ws, kids, phone) {
  const content = frame({ name: 'content', dir: 'V', gap: 'space/5', w: phone ? undefined : 'size/auth-card', sizeH: phone ? 'FILL' : null }, kids);
  const header = frame({ name: 'header', dir: 'H', sizeH: 'FILL' }, [inst('BrandMark', { Panel: AUTH[ws].panel }, { name: 'brand-mark' })]);
  const footer = frame({ name: 'footer', dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [text('MondaPac Australia', 'Caption/Strong', 'text/secondary', { name: 'market' }), text(AUTH_SUPPORT, 'Caption/Default', 'text/muted', { name: 'support', sizeH: 'FILL' })]);
  const form = frame({ name: 'Form column', dir: 'V', gap: 'auto', align: 'center', pad: phone ? [24, 16, 24, 16] : [32, 48, 32, 48], fill: 'bg/surface', w: phone ? undefined : 576, minW: phone ? undefined : 480, sizeH: phone ? 'FILL' : null, sizeV: 'FILL' }, [header, content, footer]);
  const parts = phone ? [form] : [form, inst('AuthShowcase', { Workspace: ws }, { name: 'AuthShowcase', sizeH: 'FILL', sizeV: 'FILL' })];
  const scr = frame({ name: name, dir: 'H', w: phone ? 360 : 1280, h: phone ? 780 : 900, fill: 'bg/surface', clip: true }, parts);
  applyDensity(scr, 'touch');
  tag(scr);
  return scr;
}

// ---- screens: each returns the content column's children
function authA1(ws, state) {
  const seller = ws === 'Seller';
  let banner = null;
  if (state === 'Error') banner = authBanner('Critical', 'Email or password is incorrect.', 'Check both and try again.');
  if (state === 'Throttled') banner = authBanner('Critical', 'Too many attempts.', 'Try again in 15 minutes. You can still reset your password.');
  if (state === 'Two-step paused') banner = authBanner('Critical', 'Too many wrong codes.', 'Two-step sign-in is paused for 24 hours. Reset your password to try again sooner.');
  if (state === 'Session ended') banner = authBanner('Info', 'Your session has ended.', 'Sign in again to continue.');
  return [
    accountBadge(ws), authTitle('Sign in to your ' + AUTH[ws].noun + ' account'), banner,
    authField('Email', { value: AUTH[ws].email }),
    authField('Password', { type: 'Password', filled: !state || state === 'Session ended' }),
    seller ? authCheck('Keep me signed in on this device', 'Only on a device you don’t share. You stay signed in for up to 30 days.') : null,
    authPrimary('Sign in', state === 'Throttled' ? 'Disabled' : 'Default'),
    authLinks(['Forgot password?', seller ? 'New to MondaPac? Create a seller account' : null]),
    seller ? authNote('Seller and customer accounts are separate. Each has its own password.') : null,
  ];
}
function authA2() {
  return [accountBadge('Seller'), authTitle('Create a seller account'), authBody('First confirm your email. Then MondaPac reviews your application before you can sell.'),
    authField('Your name', { value: 'Yusuf Karimi' }), authField('Email', { value: AUTH.Seller.email }), authField('Password', { type: 'Password', filled: true, helper: AUTH_POLICY }),
    authPrimary('Create account'), authNote(AUTH_PRIVACY, 'privacy-notice'), authLinks(['Already have a seller account? Sign in'])];
}
function authA3(ws) {
  const admin = ws === 'Admin';
  return [accountBadge(ws), mailTile(), authTitle('Check your email'),
    authBody(admin ? 'Your two-step verification was reset. We’ve sent a link to ' + AUTH.Admin.email + ' to set it up again. The link works for 60 minutes.' : 'We’ve sent an email to ' + AUTH.Seller.email + '. Open it and follow the link to continue.'),
    authNote('It can take a few minutes. Check your spam folder too.'), authSecondary('Send it again', 'send'),
    authLinks([admin ? null : 'Wrong address? Sign up again', 'Back to sign in'])];
}
function authA4(state) {
  if (state === 'Not usable') return [accountBadge('Seller'), authTitle('This link can’t be used'), authBody('It may have expired or already been used. Enter your email and we’ll send a new one.'), authField('Email', { value: AUTH.Seller.email }), authPrimary('Send a new link'), authLinks(['Back to sign in'])];
  return [accountBadge('Seller'), authTitle('Confirm your email'), authBody('Enter your password to confirm your email. Then you’ll see the status of your application.'), authField('Password', { type: 'Password', filled: true }), authPrimary('Confirm email')];
}
function authA5(ws, state) {
  if (state === 'Sent') return [accountBadge(ws), mailTile(), authTitle('Check your email'), authBody('If ' + (ws === 'Admin' ? 'an admin' : 'a seller') + ' account uses ' + AUTH[ws].email + ', we’ve sent a link to reset its password. The link works for 60 minutes.'), authLinks(['Back to sign in'])];
  return [accountBadge(ws), authTitle('Reset your ' + AUTH[ws].noun + ' account password'), authField('Email', { value: AUTH[ws].email }), authPrimary('Send reset link'), authLinks(['Back to sign in'])];
}
function authA6(ws) {
  return [accountBadge(ws), authTitle('Choose a new password'), authBody('Changing your password signs you out everywhere.'), authField('New password', { type: 'Password', filled: true, helper: AUTH_POLICY }), authPrimary('Save new password')];
}
function authA7(ws, state) {
  const help = ws === 'Admin' ? 'No phone and no backup codes? Ask another admin who manages admin accounts to reset it.' : 'No phone and no backup codes? Email support@mondapac.example from the address you sign in with.';
  const backup = state === 'Backup code';
  return [accountBadge(ws), authTitle(backup ? 'Enter a backup code' : 'Enter your 6-digit code'), authBody(backup ? 'Each backup code works once.' : 'Open your authenticator app and enter the code for MondaPac.'),
    authField(backup ? 'Backup code' : '6-digit code', { type: 'Code', filled: !backup }), authPrimary('Verify'),
    authLinks([backup ? 'Use your authenticator app instead' : 'Use a backup code instead', 'Can’t use either?']), authNote(help, 'help')];
}
// Two-step set-up steps. step: 'password' | 'scan' | 'code' | 'codes'; label like "Step 2 of 4"; cancel: seller set-up before the code is accepted.
function authSetupStep(ws, step, label, o) {
  o = o || {};
  const kids = [accountBadge(ws), authStep(label)];
  if (step === 'password') return kids.concat([authTitle(o.again ? 'Set up two-step verification again' : 'Set up two-step verification'), authBody('Enter your password to continue.'), ws === 'Admin' ? authNote('Admin accounts must use two-step verification.', 'required') : null, authField('Password', { type: 'Password', filled: true }), authPrimary('Continue'), o.cancel ? authLinks(['Cancel']) : null]);
  if (step === 'scan') return kids.concat([authTitle('Set up two-step verification'), ws === 'Admin' ? authNote('Admin accounts must use two-step verification.', 'required') : null, authBody('Scan this code with an authenticator app on your phone.'), qrPlate(), authNote('Can’t scan it? Enter this key in the app instead.', 'manual'), keyRow(), authSecondary('Open authenticator app', 'smartphone', true), authPrimary('Continue'), o.cancel ? authLinks(['Cancel']) : null]);
  if (step === 'code') return kids.concat([authTitle('Set up two-step verification'), authBody('Enter the 6-digit code the app shows.'), authField('6-digit code', { type: 'Code', filled: true }), authPrimary('Verify'), o.cancel ? authLinks(['Cancel']) : null]);
  return kids.concat([authTitle('Save your backup codes'), authBody('If you lose your phone, a backup code lets you sign in. Each code works once. We can’t show them again.'), backupCodes(),
    frame({ name: 'code-actions', dir: 'H', gap: 'space/2' }, [authSecondary('Copy', 'copy'), authSecondary('Download', 'download'), authSecondary('Print', 'printer')]),
    authCheck('I’ve saved these codes'), authPrimary('Continue', 'Disabled')]);
}
function authA9(ws, variant) {
  if (variant === 'Not usable') return [accountBadge(ws), authTitle('This invitation can’t be used'), authBody('Ask the person who invited you to send a new one.'), authLinks(['Back to sign in'])];
  const email = authField('Email', { value: variant === 'Admin' ? 'omar.saleh@mondapac.example' : (variant === 'Team member' ? 'amina.rahman@kurabyfresh.example' : AUTH.Seller.email), state: 'Disabled', helper: 'You’ll sign in with this email.' });
  const pw = authField('Password', { type: 'Password', filled: true, helper: AUTH_POLICY });
  if (variant === 'Admin') return [accountBadge(ws), authTitle('Set up your admin account'), authBody('You’ve been invited to be a MondaPac admin with the role Seller reviewer. Enter your name and choose a password, then set up two-step verification.'), email, authField('Your name', { value: 'Omar Saleh' }), pw, authNote(AUTH_PRIVACY, 'privacy-notice'), authPrimary('Accept and continue')];
  if (variant === 'Team member') return [accountBadge(ws), authTitle('Join a seller team on MondaPac'), authBody('Yusuf Karimi invited you to join as Order packer. Enter your name and choose a password to accept.'), email, authField('Your name', { value: 'Amina Rahman' }), pw, authNote(AUTH_SEPARATE, 'separate'), authNote(AUTH_PRIVACY, 'privacy-notice'), authPrimary('Accept and continue')];
  return [accountBadge(ws), authTitle('Set up your seller account'), authBody('MondaPac has created a seller account for you. Choose a password to get started.'), email, pw, authNote(AUTH_SEPARATE, 'separate'), authNote(AUTH_PRIVACY, 'privacy-notice'), authPrimary('Accept and continue')];
}
function authA10(variant) {
  const owner = variant === 'Owner';
  return [accountBadge('Seller'), authBanner('Critical', 'This seller account is suspended', owner ? 'Nobody on your team can sign in while it’s suspended. The reason is below.' : 'Nobody on the team can sign in while it’s suspended. Ask your shop owner for details.'),
    owner ? inst('ReasonQuote', { Reason: 'Your Halal certificate expired on 30 Sep 2026 and no renewal was uploaded. Upload a current certificate, then contact us to lift the suspension.', Date: 'Written on 6 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }) : null,
    authLinks(['Back to sign in'])];
}
function authA11() {
  return [accountBadge('Seller'), authTitle('Turn off two-step verification?'), authBody('A MondaPac admin started this after a request to support. You’ll be signed out everywhere and sign in with your password only, until you set it up again.'), authPrimary('Turn off two-step verification'), authNote('Didn’t ask for this? Close this page and change your password.', 'help')];
}

// Every Auth frame: [row, name, make]. "Update library" builds only the names a file does not have yet.
function authScreens() {
  const L = [];
  const add2 = function (row, ws, id, state, make, phone) {
    const name = 'Auth · ' + ws + ' · ' + id + (state ? ' · ' + state : '') + (phone ? ' (phone)' : '');
    L.push([row, name, function () { return authFrame(name, ws, make(), phone); }]);
  };
  [null, 'Error', 'Throttled', 'Two-step paused', 'Session ended'].forEach(function (s) { add2('Seller', 'Seller', 'A1 Sign in', s, function () { return authA1('Seller', s); }); });
  add2('Seller', 'Seller', 'A2 Sign up', null, authA2);
  add2('Seller', 'Seller', 'A3 Check your email', null, function () { return authA3('Seller'); });
  add2('Seller', 'Seller', 'A4 Confirm your email', null, function () { return authA4(null); });
  add2('Seller', 'Seller', 'A4 Confirm your email', 'Not usable', function () { return authA4('Not usable'); });
  add2('Seller', 'Seller', 'A5 Forgot password', null, function () { return authA5('Seller', null); });
  add2('Seller', 'Seller', 'A5 Forgot password', 'Sent', function () { return authA5('Seller', 'Sent'); });
  add2('Seller', 'Seller', 'A6 Choose a new password', null, function () { return authA6('Seller'); });
  add2('Seller', 'Seller', 'A7 Two-step verification', null, function () { return authA7('Seller', null); });
  add2('Seller', 'Seller', 'A7 Two-step verification', 'Backup code', function () { return authA7('Seller', 'Backup code'); });
  add2('Seller', 'Seller', 'A8 Set up two-step', 'Step 1 of 4', function () { return authSetupStep('Seller', 'password', 'Step 1 of 4', { cancel: true }); });
  add2('Seller', 'Seller', 'A8 Set up two-step', 'Step 2 of 4', function () { return authSetupStep('Seller', 'scan', 'Step 2 of 4', { cancel: true }); });
  add2('Seller', 'Seller', 'A8 Set up two-step', 'Step 3 of 4', function () { return authSetupStep('Seller', 'code', 'Step 3 of 4', { cancel: true }); });
  add2('Seller', 'Seller', 'A8 Set up two-step', 'Step 4 of 4', function () { return authSetupStep('Seller', 'codes', 'Step 4 of 4'); });
  add2('Seller', 'Seller', 'A9 Accept invitation', 'Seller created by admin', function () { return authA9('Seller', 'Seller'); });
  add2('Seller', 'Seller', 'A9 Accept invitation', 'Team member', function () { return authA9('Seller', 'Team member'); });
  add2('Seller', 'Seller', 'A9 Accept invitation', 'Not usable', function () { return authA9('Seller', 'Not usable'); });
  add2('Seller', 'Seller', 'A10 Account suspended', 'Owner', function () { return authA10('Owner'); });
  add2('Seller', 'Seller', 'A10 Account suspended', 'Staff', function () { return authA10('Staff'); });
  add2('Seller', 'Seller', 'A11 Turn off two-step verification', null, authA11);
  [null, 'Error', 'Throttled', 'Two-step paused', 'Session ended'].forEach(function (s) { add2('Admin', 'Admin', 'A1 Sign in', s, function () { return authA1('Admin', s); }); });
  add2('Admin', 'Admin', 'A3 Check your email', 'Two-step reset', function () { return authA3('Admin'); });
  add2('Admin', 'Admin', 'A5 Forgot password', null, function () { return authA5('Admin', null); });
  add2('Admin', 'Admin', 'A5 Forgot password', 'Sent', function () { return authA5('Admin', 'Sent'); });
  add2('Admin', 'Admin', 'A6 Choose a new password', null, function () { return authA6('Admin'); });
  add2('Admin', 'Admin', 'A7 Two-step verification', null, function () { return authA7('Admin', null); });
  add2('Admin', 'Admin', 'A7 Two-step verification', 'Backup code', function () { return authA7('Admin', 'Backup code'); });
  add2('Admin', 'Admin', 'A8 Set up two-step again', 'Step 1 of 4', function () { return authSetupStep('Admin', 'password', 'Step 1 of 4', { again: true }); });
  add2('Admin', 'Admin', 'A9 Accept invitation', null, function () { return authA9('Admin', 'Admin'); });
  add2('Admin', 'Admin', 'A9 Accept invitation', 'Step 1 of 3', function () { return authSetupStep('Admin', 'scan', 'Step 1 of 3'); });
  add2('Admin', 'Admin', 'A9 Accept invitation', 'Step 2 of 3', function () { return authSetupStep('Admin', 'code', 'Step 2 of 3'); });
  add2('Admin', 'Admin', 'A9 Accept invitation', 'Step 3 of 3', function () { return authSetupStep('Admin', 'codes', 'Step 3 of 3'); });
  add2('Admin', 'Admin', 'A9 Accept invitation', 'Not usable', function () { return authA9('Admin', 'Not usable'); });
  ['Seller', 'Admin'].forEach(function (ws) {
    add2('Phone', ws, 'A1 Sign in', null, function () { return authA1(ws, null); }, true);
    add2('Phone', ws, 'A7 Two-step verification', null, function () { return authA7(ws, null); }, true);
  });
  return L;
}
// names: only these frames (Update library); otherwise all of them.
function buildAuthFrames(names) {
  const out = [];
  authScreens().forEach(function (d) { if (names && names.indexOf(d[1]) < 0) return; out.push({ row: d[0], frame: d[2]() }); });
  return out;
}
function authFrameNames() { return authScreens().map(function (d) { return d[1]; }); }

// ---- Seller · Your seller account (S1): the landing page while the seller is not approved, in the limited shell
const S1_STATES = { 'Awaiting approval': ['Info', 'clock', 'Info', 'We’re reviewing your application', 'We’ll email you when there’s a decision. Until then you can’t sell or use the rest of the seller panel.', 'Waiting', 'In progress'],
  'Changes needed': ['Attention', 'alert-circle', 'Attention', 'Your application needs changes', 'Read the reason below, then contact us to continue.', 'Needs attention', 'Needs changes'],
  'Not approved': ['Critical', 'x', 'Critical', 'Your application wasn’t approved', 'You’ve reached the limit for new applications. Contact us if you have questions.', 'Needs attention', 'Not approved'] };
function s1Content(state) {
  const st = S1_STATES[state];
  const step = function (s, title, by) { return inst('ChecklistItem', { State: s, Title: title, By: by, 'Show actions': false }, { name: 'step', sizeH: 'FILL' }); };
  const slot = frame({ name: 'phase-3-slot', dir: 'H', pad: [12, 18, 12, 18], sizeH: 'FILL', stroke: 'border/row', sides: ['top'] }, [
    frame({ name: 'slot', dir: 'H', px: 'space/3', py: 'space/2', stroke: 'border/input', dash: [4, 4], radius: 'radius/control', sizeH: 'FILL' }, [text('Slot for the steps the sellers module adds in Phase 3', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]),
  ]);
  return [
    frame({ name: 'Page header', dir: 'H', gap: 'space/3', align: 'center', wrap: true, rowGap: 'space/2', sizeH: 'FILL' }, [text('Your seller account', 'Heading/H1'), inst('Badge', { Tone: st[0], Leading: 'Icon', Label: state, Icon: { icon: st[1] } }, { name: 'status' })]),
    authBanner(st[2], st[3], st[4]),
    state === 'Changes needed' ? inst('ReasonQuote', { Reason: 'The business name on your application doesn’t match the name registered for your ABN. Send us the registered name or the correct ABN, then contact us to continue.', Date: 'Written on 6 Oct 2026' }, { name: 'reason', sizeH: 'FILL' }) : null,
    card('Steps', [step('Done', 'Account created', '3 Oct 2026'), step('Done', 'Email confirmed', '3 Oct 2026'), slot, step(st[5], 'MondaPac reviews your application', st[6])]),
    card('Help', [frame({ name: 'help', dir: 'V', gap: 'space/3', pad: [16, 18, 16, 18], sizeH: 'FILL' }, [text('Protect your account', 'Heading/H2'), text('Turn on two-step verification while you wait.', 'Body/Default', 'text/secondary', { sizeH: 'FILL' }), btn('Set up two-step verification', 'Secondary', 'Md', { 'Leading icon': true, Icon: { icon: 'smartphone' } }), text(AUTH_SUPPORT, 'Body/Small', 'text/muted', { name: 'support', sizeH: 'FILL' })])]),
  ];
}
function limitedSidebar() {
  const sb = inst('Sidebar', { Workspace: 'Seller', Collapsed: 'False' }, { name: 'Sidebar', sizeV: 'FILL' });
  const keep = { 'nav-home': 1, 'nav-settings': 1 };
  const items = sb.findOne(function (n) { return n.name === 'items'; });
  items.children.forEach(function (n) { if (!keep[n.name]) n.visible = false; });
  const sw = sb.findOne(function (n) { return n.name === 'shop-switcher'; }); if (sw) sw.visible = false;
  setNested(sb, 'nav-home', Object.assign(prop('NavItem', 'Label', 'Your seller account'), prop('NavItem', 'Icon', S.icons.store.id)));
  setNested(sb, 'nav-settings', Object.assign(prop('NavItem', 'Label', 'Account security'), prop('NavItem', 'Icon', S.icons.lock.id)));
  return sb;
}
function s1Name(state, phone) { return 'Seller · Your seller account · ' + state + (phone ? ' (phone)' : ''); }
function tplSellerAccount(state, menuOpen) {
  const col = frame({ name: 'Column', dir: 'V', sizeH: 'FILL' }, [
    inst('Topbar', { Workspace: 'Seller', Crumb: 'Your seller account', 'Show search': false, 'Show notifications': false }, { name: 'Topbar', sizeH: 'FILL' }),
    frame({ name: 'Main', dir: 'V', pad: [28, 32, 40, 32], sizeH: 'FILL' }, [frame({ name: 'content', dir: 'V', gap: 'space/5', w: 760 }, s1Content(state))]),
  ]);
  const scr = frame({ name: s1Name(state), dir: 'H', w: 1440, fill: 'bg/page', clip: true }, [limitedSidebar(), col]);
  if (menuOpen) add(scr, inst('Menu', {}, { name: 'Account menu (open)', abs: [1440 - 280 - 24, 60] }));
  tag(scr);
  return scr;
}
function tplSellerAccountPhone(state) {
  const scr = phoneScreen(s1Name(state, true), 'Seller', s1Content(state), null);
  const bar = scr.children[0];
  ['menu-button', 'notifications'].forEach(function (n) { const x = bar.findOne(function (k) { return k.name === n; }); if (x) x.visible = false; });
  return scr;
}
// S1 frames: [name, make]. The awaiting frame shows the account menu open (sign out lives there).
function s1Screens() {
  return [[s1Name('Awaiting approval'), function () { return tplSellerAccount('Awaiting approval', true); }], [s1Name('Changes needed'), function () { return tplSellerAccount('Changes needed'); }],
    [s1Name('Not approved'), function () { return tplSellerAccount('Not approved'); }], [s1Name('Awaiting approval', true), function () { return tplSellerAccountPhone('Awaiting approval'); }]];
}
// Dark preview copies added in 1.7.0 (sources by name).
const DARK_170 = ['Auth · Seller · A1 Sign in', 'Auth · Admin · A1 Sign in', s1Name('Changes needed')];

// Rows of frames under a header: Seller, Admin, then phone frames.
function rowsPage(host, title, subtitle, rows) {
  const head = frame({ name: title, dir: 'V', gap: 'space/3', w: 1200 }, [text('MondaPac Design System', 'Caption/Overline', 'text/link'), text(title, 'Display/Hero'), para(subtitle, 1100)]);
  head.fills = []; host.appendChild(head); head.x = 0; head.y = 0; tag(head);
  placeRows(host, rows, 240);
}
function placeRows(host, rows, y) {
  rows.forEach(function (r) {
    if (!r.length) return;
    let x = 0, h = 0;
    r.forEach(function (s) { host.appendChild(s); s.x = x; s.y = y; x += s.width + 160; h = Math.max(h, s.height); });
    y += h + 240;
  });
  return y;
}
const AUTH_SUBTITLE = 'Sign-in and account screens before the panel (identity ux.md 3.1), A1 to A11, for Seller and Admin. 1280 wide: the form column (bg/surface, 45%, at least 480) and AuthShowcase; 360 wide: the form column alone. Touch density at every width. Copy is the en-AU text of ux.md section 5; names and emails are examples.';
