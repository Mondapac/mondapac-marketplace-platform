// Proposal · Admin · Catalog · Add product (john 31 Oct 2026): one long page in the Shopify layout, adapted to a marketplace.
// The platform product is content only: price, stock, SKU and Cost live on each seller's Offer, so the page has no Price or Inventory card.
// Title and description are entered once in English (translation to published languages happens later, per the buyer i18n decision).
// "Write with AI" drafts the description (AIS-03, admin and seller) in a modal; the draft goes into the field only on Use text and is saved only with the form.
const PAP = 'Proposal · Admin · Catalog · Add product';
function papTag(n) { n.setPluginData('proposal', 'admin-add-product'); return n; }
function papCard(name, title, kids, o) {
  o = o || {};
  return card(name, [frame({ name: 'body', dir: 'V', gap: 'space/4', pad: 20, sizeH: 'FILL' }, [title ? frame({ name: 'card head', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(title, 'Body/Strong'), pcSp()].concat(o.right || [])) : null].concat(kids))], o.w ? { w: o.w, sizeH: null } : {});
}
// Optional fields stay folded as small buttons until needed (Shopify's pill row).
function papPills(list, open) {
  return frame({ name: 'optional fields', dir: 'H', gap: 'space/2', align: 'center', pad: ['space/3', 0, 0, 0], stroke: 'border/row', sides: ['top'], sizeH: 'FILL' }, list.map(function (p) {
    return frame({ name: 'pill · ' + p[0], dir: 'H', gap: 'space/1-5', align: 'center', pad: [5, 10, 5, 10], radius: 'radius/control', fill: 'bg/subtle' }, [text(p[0], 'Body/Small', 'text/secondary'), p[1] ? text(p[1], 'Body/Small Strong', 'text/primary') : null]);
  }).concat([pcSp(), icon(open ? 'chevron-down' : 'chevron-right', 'icon/muted', 16)]));
}
// The sticky bar at the top while there are unsaved changes.
function papBar(o) {
  o = o || {};
  return frame({ name: 'unsaved bar', dir: 'H', gap: 'space/2', align: 'center', pad: [10, 16, 10, 16], radius: 'radius/card', fill: o.err ? 'status/critical/bg' : 'bg/info-banner', stroke: o.err ? 'status/critical/border' : 'border/default', sizeH: 'FILL' }, [
    icon(o.err ? 'alert-circle' : 'info', o.err ? 'status/critical/fg' : 'icon/default', 16), text(o.label || 'Unsaved product', 'Body/Strong', o.err ? 'status/critical/fg' : 'text/primary'), pcSp(),
    btn('Discard', 'Secondary', 'Sm'), btn(o.primary || 'Save draft', 'Primary', 'Sm', o.saveOff ? { State: 'Disabled' } : {})]);
}
function papEditor(value, o) {
  o = o || {};
  const tb = frame({ name: 'toolbar', dir: 'H', gap: 'space/2', align: 'center', pad: [6, 8, 6, 8], fill: 'bg/subtle', stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [
    inst('Select', { State: 'Filled', Value: 'Paragraph' }, { name: 'block', w: 130 }), text('B', 'Body/Strong'), text('I', 'Body/Default'), text('U', 'Body/Default'), icon('menu', 'icon/muted', 16), icon('more-horizontal', 'icon/muted', 16), pcSp(),
    btn(o.writing ? 'Writing…' : 'Write with AI', 'Secondary', 'Sm', Object.assign({ 'Leading icon': true, Icon: { icon: 'zap' } }, o.aiOff ? {} : {}, o.writing ? { State: 'Disabled' } : {}))]);
  if (o.aiOff) tb.children[tb.children.length - 1].visible = false;
  const body = frame({ name: 'editor body', dir: 'V', gap: 'space/1-5', pad: 12, h: o.h || 150, sizeH: 'FILL' }, value ? value.map(function (l) { return text(l, 'Body/Default', 'text/primary', { sizeH: 'FILL' }); }) : [text('Describe the product: what it is, how it tastes or is used, pack and storage.', 'Body/Default', 'text/muted', { sizeH: 'FILL' })]);
  return frame({ name: 'rich text editor', dir: 'V', radius: 'radius/control', stroke: o.focus ? 'action/primary' : 'border/input', fill: 'bg/surface', clip: true, sizeH: 'FILL' }, [tb, body]);
}
function papMedia(n) {
  if (!n) return frame({ name: 'media drop', dir: 'V', gap: 'space/2', align: 'center', justify: 'center', pad: 28, radius: 'radius/control', stroke: 'border/input', fill: 'bg/subtle', sizeH: 'FILL' }, [
    frame({ name: 'acts', dir: 'H', gap: 'space/3', align: 'center' }, [btn('Upload images', 'Secondary', 'Sm'), ppLink('Select existing', null, 'select-existing')]),
    text('JPG, PNG or WebP, at least 1200 px on the long side. Images only for now.', 'Caption/Default', 'text/muted')]);
  const tiles = [];
  for (let i = 0; i < n; i++) tiles.push(rect({ name: 'image ' + (i + 1), w: i === 0 ? 168 : 80, h: i === 0 ? 168 : 80, fill: 'bg/muted', radius: 'radius/control', stroke: i === 0 ? 'action/primary' : null }));
  tiles.push(frame({ name: 'add image', dir: 'H', w: 80, h: 80, align: 'center', justify: 'center', radius: 'radius/control', stroke: 'border/input', fill: 'bg/subtle' }, [icon('plus', 'icon/muted', 18)]));
  return frame({ name: 'media grid', dir: 'H', gap: 'space/2', wrap: true, rowGap: 'space/2', align: 'start', sizeH: 'FILL' }, tiles);
}
function papMain(o) {
  o = o || {};
  const titleCtl = o.titleError ? frame({ name: 'field · Title', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [text('Title', 'Body/Strong'), pcIn(o.title, 'Error'), text(o.titleError, 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' })])
    : pcField('Title', o.title ? pcIn(o.title) : inst('Input', { Type: 'Text', State: 'Focus', Value: 'e.g. Sella basmati rice', 'Leading icon': false }, { name: 'input', sizeH: 'FILL' }), 'In English. It is translated when a new buyer language is published.');
  return papCard('Product', null, [titleCtl, pcField('Description', papEditor(o.desc, { writing: o.writing, aiOff: o.aiOff, focus: o.descFocus })), pcField('Images', papMedia(o.images))]);
}
function papCategory(o) {
  o = o || {};
  return papCard('Category and tax', 'Category', [
    pcField('Product category', inst('Select', { State: o.cat ? 'Filled' : 'Default', Value: o.cat || 'Choose a category or subcategory' }, { name: 'category', sizeH: 'FILL' }), o.cat ? 'Its feature set adds the details below and suggests variant types.' : 'Only a category or subcategory (levels 3 and 4). It decides the product details and variant types.'),
    pcField('Tax category', inst('Select', { State: o.cat ? 'Filled' : 'Default', Value: o.cat ? 'Food: GST-free (basic food)' : 'Choose a tax category' }, { name: 'tax', sizeH: 'FILL' }), 'Required. Separate from the product category: it decides GST on every seller’s offer.')]);
}
function papDetails(o) {
  o = o || {};
  if (!o.on) return papCard('Product details', 'Product details', [text('Choose a category first. Its feature set lists what to fill in here.', 'Body/Small', 'text/muted', { sizeH: 'FILL' })]);
  return papCard('Product details', 'Product details', [
    frame({ name: 'row 1', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [pcField('Brand', inst('Select', { State: 'Filled', Value: 'Tilda' }, { name: 'brand', sizeH: 'FILL' })), pcField('Country of origin', inst('Select', { State: 'Filled', Value: 'India' }, { name: 'origin', sizeH: 'FILL' }))]),
    frame({ name: 'row 2', dir: 'H', gap: 'space/3', sizeH: 'FILL' }, [pcField('Grain length · required', inst('Select', { State: o.missing ? 'Error' : 'Filled', Value: o.missing ? 'Choose' : 'Extra long' }, { name: 'grain', sizeH: 'FILL' })), pcField('Variety · recommended', pcIn('Sella (parboiled)'))]),
    o.missing ? text('Choose the grain length. Rice and grains needs it.', 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' }) : null,
    papPills([['Cooking time'], ['Storage'], ['Ingredients'], ['Allergen statement']], false),
    text('Ingredients, allergen statement and warnings are label text: copied as printed, never written by AI and never translated.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })]);
}
// Variants: first the one-time question, then the option editor and a grouped table with the product-side columns only.
function papVariantsAsk(sel) {
  return papCard('Variants', 'Variants', [
    paRadio(sel === 'one', 'One size', 'Sold as a single item, e.g. Sella basmati rice 5 kg.'),
    paRadio(sel === 'many', 'Different sizes or flavours', 'Sellers choose which ones they sell. Uses the variant types of the category.'),
    inst('InfoBanner', { Tone: 'Info', Title: 'You can’t switch between these after the first publish', Body: 'A one-size product can still get sizes later with Add sizes. Variant types are fixed once published.', 'Show action': false }, { name: 'fixed', sizeH: 'FILL' })]);
}
function papOption(name, values, editing) {
  const chips = values.map(function (v) { return frame({ name: 'value · ' + v, dir: 'H', gap: 'space/1', align: 'center', pad: [4, 8, 4, 6], radius: 'radius/chip', fill: 'bg/selected' }, [icon('more-vertical', 'icon/muted', 12), text(v, 'Body/Small', 'text/link'), editing ? icon('x', 'icon/muted', 12) : null]); });
  if (!editing) return frame({ name: 'option · ' + name, dir: 'H', gap: 'space/3', align: 'center', pad: [12, 12, 12, 12], stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [icon('more-vertical', 'icon/muted', 16), frame({ name: 'text', dir: 'V', gap: 'space/1-5', sizeH: 'FILL' }, [text(name, 'Body/Strong'), frame({ name: 'values', dir: 'H', gap: 'space/1-5', wrap: true, rowGap: 'space/1-5', sizeH: 'FILL' }, chips)])]);
  return frame({ name: 'option · ' + name + ' (editing)', dir: 'H', gap: 'space/3', align: 'start', pad: 12, stroke: 'border/row', sides: ['bottom'], sizeH: 'FILL' }, [icon('more-vertical', 'icon/muted', 16), frame({ name: 'edit', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [
    pcField('Variant type', inst('Select', { State: 'Filled', Value: name }, { name: 'type', sizeH: 'FILL' })),
    frame({ name: 'values box', dir: 'H', gap: 'space/1-5', wrap: true, rowGap: 'space/1-5', align: 'center', pad: 8, radius: 'radius/control', stroke: 'action/primary', sizeH: 'FILL' }, chips.concat([text('Add from the list…', 'Body/Small', 'text/muted')])),
    frame({ name: 'acts', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [btn('Remove', 'Ghost', 'Sm'), pcSp(), btn('Done', 'Primary', 'Sm')])])]);
}
function papVariantTable(groups, open) {
  const head = headerRow([['', 44], ['Variant', 'fill'], ['Barcode (GTIN)', 170], ['Ship weight', 110], ['Sellers', 80]]);
  const rows = [];
  groups.forEach(function (g, gi) {
    const isOpen = open === gi;
    rows.push(row([[pvTick(false), 44, { justify: 'center' }], [frame({ name: 'group', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [rect({ name: 'thumb', w: 40, h: 40, fill: 'bg/muted', radius: 'radius/control' }), twoLine(g[0], g[1].length + ' variants', 'Body/Strong'), icon(isOpen ? 'chevron-down' : 'chevron-right', 'icon/muted', 16)]), 'fill'], [text('—', 'Body/Small', 'text/muted'), 170], [text(g[2], 'Body/Small', 'text/muted'), 110], [text('0', 'Body/Small', 'text/muted'), 80]], false, false, 60));
    if (isOpen) g[1].forEach(function (v) {
      rows.push(row([[pvTick(false), 44, { justify: 'center' }], [frame({ name: 'variant', dir: 'H', gap: 'space/2', align: 'center', pad: [0, 0, 0, 24], sizeH: 'FILL' }, [rect({ name: 'thumb', w: 32, h: 32, fill: 'bg/muted', radius: 'radius/chip' }), text(v[0], 'Body/Default')]), 'fill'], [pcIn(v[1] || '', v[1] ? null : 'Default'), 170], [pcIn(v[2]), 110], [text('0', 'Body/Small', 'text/muted'), 80]], false, false, 52));
    });
  });
  rows.push(frame({ name: 'table foot', dir: 'H', pad: [10, 16, 10, 16], fill: 'bg/subtle', sizeH: 'FILL' }, [text('No price or stock here: each seller sets them on their own offer after you publish.', 'Caption/Default', 'text/muted')]));
  return card('variant table', [head].concat(rows));
}
function papVariants(o) {
  o = o || {};
  const opts = card('options', [papOption('Pack size', ['1 kg', '5 kg', '10 kg'], o.editing), o.two ? papOption('Grain', ['White', 'Brown']) : null,
    frame({ name: 'add option', dir: 'H', pad: [10, 12, 10, 12], sizeH: 'FILL' }, [ppLink(o.two ? 'Add another option (2 of 2)' : 'Add another option', 'plus', 'add-option')])]);
  const groups = o.two ? [['White', [['1 kg', '9 300633 01233 8', '1.05 kg'], ['5 kg', '9 300633 01234 5', '5.1 kg'], ['10 kg', '', '10.2 kg']], '1.05–10.2 kg'], ['Brown', [['1 kg', '', '1.05 kg'], ['5 kg', '', '5.1 kg'], ['10 kg', '', '10.2 kg']], '1.05–10.2 kg']]
    : [['1 kg', [], '1.05 kg'], ['5 kg', [], '5.1 kg'], ['10 kg', [], '10.2 kg']];
  const table = o.two ? papVariantTable(groups, 0) : card('variant table', [headerRow([['', 44], ['Variant', 'fill'], ['Barcode (GTIN)', 170], ['Ship weight', 110], ['Sellers', 80]])].concat([['1 kg', '9 300633 01233 8', '1.05 kg'], ['5 kg', '9 300633 01234 5', '5.1 kg'], ['10 kg', '', '10.2 kg']].map(function (v) {
    return row([[pvTick(false), 44, { justify: 'center' }], [frame({ name: 'variant', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [rect({ name: 'thumb', w: 40, h: 40, fill: 'bg/muted', radius: 'radius/control' }), text(v[0], 'Body/Strong')]), 'fill'], [pcIn(v[1]), 170], [pcIn(v[2]), 110], [text('0', 'Body/Small', 'text/muted'), 80]], false, false, 60);
  }), [frame({ name: 'table foot', dir: 'H', pad: [10, 16, 10, 16], fill: 'bg/subtle', sizeH: 'FILL' }, [text('No price or stock here: each seller sets them on their own offer after you publish.', 'Caption/Default', 'text/muted')])]));
  return papCard('Variants', 'Variants', [opts, frame({ name: 'table tools', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [text(o.two ? '6 variants · grouped by Grain' : '3 variants', 'Body/Small Strong', 'text/secondary'), pcSp(), btn('Set ship weight for selected', 'Secondary', 'Sm')]), table],
    { right: [bdg('Info', 'None', 'Suggested by Rice and grains')] });
}
function papSide(o) {
  o = o || {};
  const status = papCard('Status', 'Status', [
    frame({ name: 'state', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [bdg(o.published ? 'Success' : 'Neutral', 'Dot', o.published ? 'Published' : 'Draft'), o.revision ? bdg('Attention', 'None', 'Revision 2 · unpublished changes') : null]),
    text(o.published ? 'Changes are saved as a new revision. Buyers keep seeing revision 1 until you publish.' : 'Sellers can’t find it until you publish. Save draft keeps your work.', 'Body/Small', 'text/muted', { sizeH: 'FILL' }),
    btn(o.published ? 'Publish revision 2' : 'Publish', 'Primary', 'Md', { State: o.canPublish ? 'Default' : 'Disabled' }),
    o.canPublish ? null : text(o.blockers || 'To publish: title, category, tax category and one image.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })], { w: 340 });
  const org = papCard('Organisation', 'Organisation', [
    pcValue('Market', text('Australia', 'Body/Default')), pcValue('Scope', text('Platform product', 'Body/Default')),
    text('No tags or collections: categories drive the menu and filters. Certification badges belong to each seller’s offer, never to the product.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })], { w: 340 });
  const kids = [status, org];
  if (o.published) kids.push(papCard('Sellers selling it', 'Sellers selling it', [
    frame({ name: 'tiles', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [['Sellers', '3'], ['Offers', '7'], ['From', '$6.20']].map(function (t) { return frame({ name: 'tile · ' + t[0], dir: 'V', gap: 'space/1', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text(t[0], 'Caption/Default', 'text/muted'), text(t[1], 'Body/Strong')]); })),
    text('Read only. Each seller sets price and stock on their own offer.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' }), ppLink('Open the 7 offers', 'external-link', 'open-offers')], { w: 340 }));
  return frame({ name: 'side', dir: 'V', gap: 'space/4', w: 340 }, kids);
}
function papScreen(state, o) {
  o = o || {};
  const title = o.edit ? 'Sella basmati rice' : 'Add product';
  const crumb = 'Catalog / Products / ' + (o.edit ? 'Sella basmati rice' : 'Add product');
  const main = frame({ name: 'main', dir: 'V', gap: 'space/4', sizeH: 'FILL' }, o.main);
  const kids = [o.bar === false ? null : papBar(o.barOpts), pageTitle(title, o.edit ? 'Platform product · Australia · MP-004127' : 'Platform product · Australia', [], o.edit ? bdg('Success', 'Dot', 'Published') : null),
    frame({ name: 'layout', dir: 'H', gap: 'space/5', align: 'start', sizeH: 'FILL' }, [main, papSide(o.side)])];
  const scr = screen(PAP + ' · ' + state, 'Admin', 'nav-catalogue', crumb, kids, { minH: PANEL_MIN_H, gap: 'space/4' });
  (o.overlay ? [].concat(o.overlay) : []).forEach(function (p) { add(scr, p); });
  return papTag(scr);
}
// "Write with AI" opens a modal (john 31 Oct): the writer gives keywords and a short note; the form's title, category and details are used too.
// st: 'input' (before Generate), 'blocked' (title or category empty), 'writing', 'ready', 'failed', 'limit'.
function papAiModal(st) {
  st = st || 'input';
  const chip = function (v) { return frame({ name: 'keyword · ' + v, dir: 'H', gap: 'space/1', align: 'center', pad: [4, 8, 4, 8], radius: 'radius/chip', fill: 'bg/selected' }, [text(v, 'Body/Small', 'text/link'), icon('x', 'icon/muted', 12)]); };
  const kw = frame({ name: 'keywords box', dir: 'H', gap: 'space/1-5', wrap: true, rowGap: 'space/1-5', align: 'center', pad: 8, radius: 'radius/control', stroke: 'border/input', fill: 'bg/surface', sizeH: 'FILL' }, (st === 'blocked' ? [] : ['aged 2 years', 'biryani', 'extra long grain'].map(chip)).concat([text('Type a word and press Enter', 'Body/Small', 'text/muted')]));
  const used = frame({ name: 'also used', dir: 'V', gap: 'space/1-5', pad: 'space/3', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text('Also used, from the form', 'Caption/Strong', 'text/muted')].concat(
    (st === 'blocked' ? [['Title', 'Missing'], ['Category', 'Missing'], ['Product details', '—']] : [['Title', 'Sella basmati rice'], ['Category', 'Basmati rice'], ['Product details', 'Tilda · India · Extra long · Sella (parboiled)']]).map(function (r) {
      return frame({ name: 'used · ' + r[0], dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [text(r[0], 'Body/Small', 'text/muted', { w: 120 }), text(r[1], 'Body/Small', r[1] === 'Missing' ? 'status/critical/fg' : 'text/primary', { sizeH: 'FILL' })]);
    }).concat([text('Change these in the form. Images aren’t sent.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' })])));
  const inputs = [pcField('Keywords', kw, 'Up to 10. Words you want in the text.'),
    pcField('Short note', pcTa(st === 'blocked' ? '' : 'Cooks in 15 minutes. Firm grains that don’t stick.'), 'Up to 300 characters. Certifications come from seller offers, not from the text.'),
    frame({ name: 'opts', dir: 'H', gap: 'space/2', sizeH: 'FILL' }, [pcField('Tone', inst('Select', { State: 'Filled', Value: 'Clear and friendly' }, { name: 'tone', sizeH: 'FILL' })), pcField('Length', inst('Select', { State: 'Filled', Value: 'About 80 words' }, { name: 'length', sizeH: 'FILL' }))]), used];
  let body, foot;
  if (st === 'input' || st === 'blocked') {
    body = inputs;
    foot = [st === 'blocked' ? text('Add a title and category first.', 'Caption/Default', 'text/muted') : null, pcSp(), btn('Cancel', 'Secondary', 'Md'), btn('Generate', 'Primary', 'Md', Object.assign({ 'Leading icon': true, Icon: { icon: 'zap' } }, st === 'blocked' ? { State: 'Disabled' } : {}))];
  } else if (st === 'writing') {
    body = [frame({ name: 'writing', dir: 'H', gap: 'space/2', align: 'center', pad: 'space/4', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [icon('clock', 'icon/muted', 16), text('Writing a draft… It takes a few seconds. Closing this keeps your form as it is.', 'Body/Small', 'text/secondary', { sizeH: 'FILL' })])];
    foot = [pcSp(), btn('Stop', 'Secondary', 'Md')];
  } else if (st === 'ready') {
    body = [frame({ name: 'draft', dir: 'V', gap: 'space/2', pad: 'space/4', fill: 'bg/subtle', radius: 'radius/control', sizeH: 'FILL' }, [text('Draft · check it before you use it', 'Caption/Strong', 'text/muted'),
      text('Tilda Sella basmati is an extra-long grain rice, parboiled and aged for two years. The grains stay firm and separate after cooking, so it is a good choice for biryani and pilaf. It cooks in about 15 minutes. Store in a cool, dry place.', 'Body/Default', 'text/primary', { sizeH: 'FILL' })]),
      text('1 sentence was left out: it named a certification.', 'Caption/Default', 'status/attention/fg', { sizeH: 'FILL' }),
      pcField('The description already has text', frame({ name: 'mode', dir: 'V', gap: 'space/2', sizeH: 'FILL' }, [paRadio(true, 'Replace it'), paRadio(false, 'Add below it')]))];
    foot = [btn('Back to edit', 'Ghost', 'Md'), pcSp(), btn('Try again', 'Secondary', 'Md'), btn('Use text', 'Primary', 'Md')];
  } else {
    body = inputs.slice(0, 2).concat([st === 'failed' ? inst('InfoBanner', { Tone: 'Critical', Title: 'We couldn’t write a draft.', Body: 'Try again, or write it yourself. Your form wasn’t changed.', 'Show action': false }, { name: 'failed', sizeH: 'FILL' })
      : inst('InfoBanner', { Tone: 'Attention', Title: 'Today’s AI drafts are used up.', Body: 'They reset at midnight Brisbane time. You can still write the description yourself.', 'Show action': false }, { name: 'limit', sizeH: 'FILL' })]);
    foot = [pcSp(), btn('Cancel', 'Secondary', 'Md'), btn(st === 'failed' ? 'Try again' : 'Generate', 'Primary', 'Md', st === 'limit' ? { State: 'Disabled' } : {})];
  }
  return frame({ name: 'AI modal (' + st + ')', dir: 'V', w: 560, pad: 'space/6', gap: 'space/4', fill: 'bg/surface', radius: 'radius/card', effect: 'Elevation/Floating' }, [
    frame({ name: 'head', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, [icon('zap', 'text/link', 18), text('Write description with AI', 'Heading/H2'), pcSp(), inst('IconButton', { Variant: 'Ghost', Size: 'Sm', State: 'Default', Icon: { icon: 'x' } }, { name: 'close' })]),
    st === 'ready' || st === 'writing' ? null : text('Give a few keywords and a short note. The draft uses only what you give and what the form already says.', 'Body/Small', 'text/secondary', { sizeH: 'FILL' })].concat(body, [frame({ name: 'footer', dir: 'H', gap: 'space/2', align: 'center', sizeH: 'FILL' }, foot)]));
}
// The screen dimmed with the modal centred on it.
function papWithModal(scr, modal) {
  const h = Math.max(PANEL_MIN_H, Math.round(scr.height || PANEL_MIN_H));
  const scrim = frame({ name: 'modal scrim', dir: 'V', w: 1440, h: h, align: 'center', pad: [96, 0, 0, 0], fill: 'bg/scrim' }, [modal]);
  setMeta(scrim, { abs: [0, 0] });
  add(scr, scrim);
  return scr;
}
function papStates() {
  const b = function (n, tone, t, body, act) { return inst('InfoBanner', Object.assign({ Tone: tone, Title: t, Body: body, 'Show action': !!act }, act ? { Action: act } : {}), { name: n, sizeH: 'FILL' }); };
  const field = function (n, v, msg) { return frame({ name: n, dir: 'V', gap: 'space/1', sizeH: 'FILL' }, [pcIn(v, 'Error'), text(msg, 'Body/Small', 'status/critical/fg', { sizeH: 'FILL' })]); };
  const leave = pcDialog('Leave with unsaved changes', 'Leave this page?', 'Your changes to Sella basmati rice aren’t saved.', [], 'Leave without saving', { destructive: true, focusCancel: true, w: 440 });
  const publish = pcDialog('Publish product', 'Publish Sella basmati rice?', 'Sellers in Australia can find it and add their offers. Buyers see it once at least one offer is on sale.', [pcImpact([['Variants', '6'], ['Title and description', 'English · translated when a buyer language is published']])], 'Publish', { w: 480 });
  const scr = frame({ name: PAP + ' · States and messages', dir: 'V', w: 1240, pad: 40, gap: 'space/4', fill: 'bg/page' }, [text('Add product: states and messages', 'Heading/H1'),
    para('Copy is a draft for Jafar (product designer) and Reza (UI/UX).', 820),
    text('Fields', 'Caption/Strong', 'text/muted'), field('claim', 'Halal Sella basmati rice', 'Product text can’t include certification words like "halal". Badges come from seller offers.'),
    field('gtin', '9 300633 01234 5', 'This barcode is already on Sella basmati rice 5 kg. Open that product instead.'),
    text('Page', 'Caption/Strong', 'text/muted'), papBar({ label: '2 fields need fixing', err: true, primary: 'Save draft', saveOff: true }),
    b('stale', 'Attention', 'Someone published a newer revision.', 'Reload to see it. Your changes are kept.', 'Reload'),
    b('published', 'Success', 'Sella basmati rice is published.', 'Sellers can now add their offers.', 'View product'),
    b('read-only', 'Info', 'View only', 'Your role can’t change platform products.'),
    text('Write with AI', 'Caption/Strong', 'text/muted'),
    frame({ name: 'ai states', dir: 'H', gap: 'space/4', align: 'start', wrap: true, rowGap: 'space/4', sizeH: 'FILL' }, [papAiModal('blocked'), papAiModal('writing'), papAiModal('failed'), papAiModal('limit')]),
    text('Keywords and the note are data, not instructions. The draft is checked on the server like any product text; it adds no new facts, no links or images, and nothing about halal, health or allergies.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' }),
    text('When AI is switched off for the Market or the provider isn’t set, the button is hidden and the form works the same.', 'Caption/Default', 'text/muted', { sizeH: 'FILL' }),
    text('Dialogs', 'Caption/Strong', 'text/muted'), frame({ name: 'dialogs', dir: 'H', gap: 'space/4', align: 'start', wrap: true, rowGap: 'space/4', sizeH: 'FILL' }, [publish, leave])]);
  tag(scr); return papTag(scr);
}
PROPOSALS['admin-add-product'] = { title: PAP, rows: function () {
  const desc = ['Tilda Sella basmati is an extra-long grain rice, parboiled and aged for two years.', 'The grains stay firm and separate after cooking. Good for biryani and pilaf.'];
  const empty = papScreen('1 Empty', { bar: false, main: [papMain({}), papCategory({}), papDetails({}), papVariantsAsk(null)], side: {} });
  const filled = papScreen('2 One size, filled', { main: [papMain({ title: 'Sella basmati rice 5 kg', desc: desc, images: 3 }), papCategory({ cat: 'Pantry › Rice and grains › Rice › Basmati rice' }), papDetails({ on: true }), papVariantsAsk('one')], side: { canPublish: true } });
  const variants = papScreen('3 Sizes, editing an option', { main: [papMain({ title: 'Sella basmati rice', desc: desc, images: 3 }), papCategory({ cat: 'Pantry › Rice and grains › Rice › Basmati rice' }), papDetails({ on: true }), papVariants({ editing: true })], side: { canPublish: true } });
  const twoAxes = papScreen('4 Two variant types, grouped', { main: [papMain({ title: 'Sella basmati rice', desc: desc, images: 4 }), papCategory({ cat: 'Pantry › Rice and grains › Rice › Basmati rice' }), papDetails({ on: true }), papVariants({ two: true })], side: { canPublish: true } });
  const aiIn = papWithModal(papScreen('5 Write with AI, modal', { main: [papMain({ title: 'Sella basmati rice', images: 3 }), papCategory({ cat: 'Pantry › Rice and grains › Rice › Basmati rice' }), papDetails({ on: true })], side: {} }), papAiModal('input'));
  const aiOut = papWithModal(papScreen('5b Write with AI, draft ready', { main: [papMain({ title: 'Sella basmati rice', desc: ['Long grain rice.'], images: 3 }), papCategory({ cat: 'Pantry › Rice and grains › Rice › Basmati rice' }), papDetails({ on: true })], side: {} }), papAiModal('ready'));
  const errors = papScreen('6 Can’t publish yet', { barOpts: { label: '2 fields need fixing', err: true, saveOff: true }, main: [papMain({ title: 'Halal Sella basmati rice', titleError: 'Product text can’t include certification words like "halal". Badges come from seller offers.', desc: desc, images: 3 }), papCategory({ cat: 'Pantry › Rice and grains › Rice › Basmati rice' }), papDetails({ on: true, missing: true }), papVariantsAsk('one')], side: { blockers: 'To publish: fix the title and choose the grain length.' } });
  const edit = papScreen('7 Edit, published, new revision', { edit: true, barOpts: { label: 'Unsaved changes', primary: 'Save revision' }, main: [papMain({ title: 'Sella basmati rice', desc: desc, images: 4 }), papCategory({ cat: 'Pantry › Rice and grains › Rice › Basmati rice' }), papDetails({ on: true }), papVariants({ two: true })], side: { published: true, revision: true, canPublish: true } });
  return [[empty, filled, variants], [twoAxes, aiIn, aiOut], [errors, edit, papStates()]];
} };
