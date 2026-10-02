// ---------------------------------------------------------------- foundation pages
function brandMark(size) {
  const f = frame({ name: 'MondaPac mark', w: size, h: size, radius: Math.round(size / 4), fill: 'action/primary' });
  f.layoutMode = 'HORIZONTAL'; f.primaryAxisAlignItems = 'CENTER'; f.counterAxisAlignItems = 'CENTER';
  add(f, text('M', size > 40 ? 'Display/Hero' : 'Heading/H2', 'text/on-accent'));
  return f;
}
function swatch(token, theme, w, h) {
  const r = figma.createRectangle(); r.name = token + ' · ' + theme; r.resize(w || 40, h || 40); r.cornerRadius = 8;
  const hex = theme === 'dark' ? DARKHEX[token] : HEX[token];
  let p = { type: 'SOLID', color: rgb(hex) };
  const v = theme === 'dark' ? (S.modes.color ? S.color[token] : S.colorDark[token]) : S.color[token];
  p = figma.variables.setBoundVariableForPaint(p, 'color', v);
  r.fills = [p]; r.strokes = [paint('border/default')]; r.strokeWeight = 1; r.strokeAlign = 'INSIDE';
  if (theme === 'dark') {
    // Wrapper frame carries the theme, so "Upgrade to modes" can switch it to the Dark mode later.
    const wrap = frame({ name: 'dark mode', w: w || 40, h: h || 40 }); wrap.fills = [];
    add(wrap, r); wrap.setPluginData('theme', 'dark'); setDarkModeOn(wrap); return wrap;
  }
  return r;
}
function primSwatch(p) {
  const r = figma.createRectangle(); r.name = p.name; r.resize(88, 56); r.cornerRadius = 8;
  r.fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(p.hex) }, 'color', S.prim[p.name])];
  r.strokes = [paint('border/default')]; r.strokeWeight = 1; r.strokeAlign = 'INSIDE';
  return frame({ name: p.name, dir: 'V', gap: 'space/1', w: 88 }, [r, text(p.name.split('/')[1], 'Caption/Strong', 'text/primary'), text(p.hex, 'Mono/Small', 'text/muted')]);
}
function setDarkModeOn(node) {
  if (S.modes.color) node.setExplicitVariableModeForCollection(S.colorModes.collection, S.colorModes.dark);
}

async function pageCover(page) {
  const f = frame({ name: 'Cover', dir: 'V', gap: 'space/8', pad: [96, 96, 96, 96], w: 1600, h: 960, fill: 'bg/page', justify: 'between' });
  page.appendChild(f);
  add(f, frame({ name: 'Top', dir: 'H', gap: 'space/4', align: 'center' }, [brandMark(56), frame({ name: 'Brand', dir: 'V', gap: 'space/0-5' }, [text('MondaPac', 'Heading/Amount'), text('Marketplace platform · Brisbane, Australia', 'Body/Default', 'text/muted')])]));
  add(f, frame({ name: 'Title', dir: 'V', gap: 'space/4' }, [
    text('Design System', 'Caption/Overline', 'text/link'),
    text('Admin and Seller panels', 'Display/Hero'),
    para('One structure for both panels. Differences live in navigation, features and permissions — never in the look. Everything in this file is built from variables, styles and components; change the system here and every screen follows.', 880),
  ]));
  const meta = [['Version', SPEC.version], ['Updated', '1 Oct 2026'], ['Themes', 'Light · Dark'], ['Density', 'Desktop · Touch'], ['Status', 'Stable foundation']];
  add(f, frame({ name: 'Meta', dir: 'H', gap: 'space/4' }, meta.map(function (m) {
    return frame({ name: m[0], dir: 'V', gap: 'space/1', pad: 'space/4', w: 220, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [text(m[0], 'Caption/Default', 'text/muted'), text(m[1], 'Heading/H2')]);
  })));
  tag(f);
}

async function pageGettingStarted(page) {
  const root = pageShell(page, 'Getting started', 'How this library is organised, how to use it, and how changes flow from Figma to code.');
  let s = docSection(root, 'Principles');
  add(s, frame({ name: 'Principles', dir: 'H', gap: 'space/4', wrap: true, rowGap: 'space/4', w: 1440 }, [
    ['One structure, two workspaces', 'Admin and Seller share the shell, templates and components. Only navigation items, features and permissions differ.'],
    ['Tokens, not values', 'Every colour, space, radius and size is a variable. Never type a hex value or a pixel size into a design.'],
    ['Accessible by default', 'WCAG 2.2 AA: text 4.5:1, UI boundaries 3:1, state never by colour alone, touch targets 44–48 px on tablet.'],
    ['Data first', 'Numbers, deadlines and status are the product. Show the comparison, the trend and the deadline next to every figure.'],
    ['Built for the counter', 'Sellers work on a tablet with busy hands: large targets, short labels, one decision per card.'],
    ['Light and dark', 'Every colour token has a light and a dark value. Check new work in both before handing it over.'],
  ].map(function (p) { return frame({ name: p[0], dir: 'V', gap: 'space/2', pad: 'space/6', w: 464, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [text(p[0], 'Heading/H2'), para(p[1], 416)]); })));

  s = docSection(root, 'File structure', 'Pages are grouped by separators. On the Starter plan (3 pages per file) each group is one page and each topic is a section on it. Foundations hold variables and styles, Components hold the library, Templates show full screens built only from components.');
  add(s, table(['Group', 'Pages', 'Contents'], [
    ['Start', 'Cover · Getting started · Changelog', 'What this is, how to use it, what changed'],
    ['Foundations', 'Colour · Typography · Spacing, size & radius · Elevation & motion · Icons · Accessibility', 'Variables, text styles, effect styles, icon components'],
    ['Components', 'Actions · Forms & selection · Status & feedback · Data display · Tables & collections · Navigation & shell · Review & detail · Board & delivery', 'Component sets with variants and properties, each with usage notes'],
    ['Templates', 'Admin · Seller · Dark preview', 'Full screens assembled from instances; the reference for new screens'],
    ['Workspace', 'Sandbox · Archive', 'Proposals in progress and retired components'],
  ], [180, 560, 600]));

  s = docSection(root, 'Naming', 'Names are the API between design and code. Keep them identical in Figma, in tokens and in components.');
  add(s, table(['Thing', 'Pattern', 'Example'], [
    ['Colour variable', 'role/name or role/state/part', 'bg/surface · text/muted · status/critical/fg'],
    ['Dimension variable', 'category/step', 'space/4 · radius/card · size/control'],
    ['Code syntax', 'var(--mp-…) set on every variable', 'var(--mp-color-text-muted)'],
    ['Text style', 'Group/Name', 'Body/Default · Heading/H1 · Mono/Default'],
    ['Component', 'PascalCase, matches the React component', 'Button · StatusBadge · OrderCard'],
    ['Variant property', 'Title Case keys, Title Case values', 'Variant=Primary, Size=Md, State=Hover'],
    ['Layers inside components', 'kebab-case', 'label · icon-leading · meter-fill'],
  ], [220, 420, 700]));

  s = docSection(root, 'How changes flow', 'Figma is the source of truth for the UI. Code follows through exported tokens and reviewed component changes.');
  add(s, frame({ name: 'Flow', dir: 'H', gap: 'space/3', align: 'center' }, [
    ['1 · Propose', 'Draft in Sandbox, link the ticket'], ['2 · Review', 'Design review: tokens only, all states, light + dark, a11y'], ['3 · Publish', 'Move to the library page, bump the version, write the changelog'],
    ['4 · Export', 'Run the plugin → Export tokens; commit docs/design/tokens'], ['5 · Build', 'Frontend updates components; QA checks against this file'],
  ].map(function (st, i, arr) {
    const card = frame({ name: st[0], dir: 'V', gap: 'space/1', pad: 'space/4', w: 248, fill: 'bg/surface', stroke: 'border/default', radius: 'radius/card' }, [text(st[0], 'Body/Strong'), text(st[1], 'Body/Small', 'text/muted', { w: 216 })]);
    return card;
  })));
  add(s, para('Plan note: on the Starter plan a collection has one mode and team libraries cannot be published. Dark and touch values are kept in parallel collections (Color · Dark, Dimension · Touch) and product screens live in this same file. After upgrading to Professional, run the plugin command "Upgrade to modes" and publish this file as a library.', 1200, 'text/muted'));
  tag(root);
}

async function pageChangelog(page) {
  const root = pageShell(page, 'Changelog', 'Semantic versioning: MAJOR for breaking renames or removals, MINOR for new components or variants, PATCH for fixes.');
  add(root, table(['Version', 'Date', 'Changes'], [
    [SPEC.version, '1 Oct 2026', 'First release. Foundations (variables light/dark, desktop/touch, text and effect styles, icons), ' + Object.keys(S.sets).length + ' components, Admin and Seller templates, dark preview.'],
  ], [140, 160, 1100]));
  tag(root);
}

async function pageColor(page) {
  const root = pageShell(page, 'Colour', 'Two layers. Primitives are raw values and are hidden from the library. Semantic tokens describe a role and switch between light and dark. Designs use semantic tokens only.');
  let s = docSection(root, 'Semantic tokens', 'Each row shows the light and dark value. Code syntax is set on every variable, so Dev Mode shows the CSS variable.');
  const groups = {};
  SPEC.color.forEach(function (c) { const g = c.name.split('/')[0]; (groups[g] = groups[g] || []).push(c); });
  Object.keys(groups).forEach(function (g) {
    add(s, text(g, 'Heading/H2'));
    const tbl = frame({ name: g, dir: 'V', stroke: 'border/default', radius: 'radius/card', fill: 'bg/surface', clip: true, w: 1440 });
    add(tbl, frame({ name: 'Header', dir: 'H', fill: 'bg/subtle', stroke: 'border/default', sides: ['bottom'], px: 'space/4', py: 'space/2', gap: 'space/4', sizeH: 'FILL' }, [
      text('Token', 'Body/Small Strong', 'text/muted', { w: 300 }), text('Light', 'Body/Small Strong', 'text/muted', { w: 180 }), text('Dark', 'Body/Small Strong', 'text/muted', { w: 180 }), text('Use', 'Body/Small Strong', 'text/muted', { w: 380 }), text('Code', 'Body/Small Strong', 'text/muted', { w: 300 }),
    ]));
    groups[g].forEach(function (c, i) {
      const darkCell = frame({ name: 'Dark', dir: 'H', gap: 'space/2', align: 'center', w: 180 }, [swatch(c.name, 'dark', 28, 28), text(c.darkHex, 'Mono/Small', 'text/muted')]);
      add(tbl, frame({ name: c.name, dir: 'H', px: 'space/4', py: 'space/2', gap: 'space/4', align: 'center', stroke: i < groups[g].length - 1 ? 'border/row' : null, sides: ['bottom'], sizeH: 'FILL' }, [
        text(c.name, 'Mono/Default', 'text/primary', { w: 300 }),
        frame({ name: 'Light', dir: 'H', gap: 'space/2', align: 'center', w: 180 }, [swatch(c.name, 'light', 28, 28), text(c.lightHex, 'Mono/Small', 'text/muted')]),
        darkCell,
        text(c.description, 'Body/Small', 'text/secondary', { w: 380 }),
        text(cssVar('color', c.name), 'Mono/Small', 'text/muted', { w: 300 }),
      ]));
    });
    add(s, tbl);
  });
  s = docSection(root, 'Primitives', 'Named by hue family and darkness step: step = 1000 × (1 − OKLab lightness). Higher numbers are darker. Not for direct use.');
  const fams = {};
  SPEC.primitives.forEach(function (p) { const f = p.name.split('/')[0]; (fams[f] = fams[f] || []).push(p); });
  Object.keys(fams).forEach(function (f) {
    add(s, frame({ name: f, dir: 'V', gap: 'space/2' }, [text(f, 'Heading/H2'), frame({ name: f + ' ramp', dir: 'H', gap: 'space/2', wrap: true, rowGap: 'space/3', w: 1440 }, fams[f].map(primSwatch))]));
  });
  tag(root);
}

async function pageTypography(page) {
  const root = pageShell(page, 'Typography', 'IBM Plex Sans for interface text, IBM Plex Mono for order numbers, certificate numbers and keyboard hints. Sizes and line heights are variables bound into the text styles.');
  const s = docSection(root, 'Text styles');
  SPEC.type.forEach(function (t) {
    add(s, frame({ name: t.name, dir: 'H', gap: 'space/8', align: 'center', py: 'space/3', stroke: 'border/row', sides: ['bottom'], w: 1440 }, [
      frame({ name: 'Spec', dir: 'V', gap: 'space/1', w: 320 }, [text(t.name, 'Body/Strong'), text(t.family + ' ' + t.style + ' · ' + t.size + ' / ' + t.lineHeight + (t.case ? ' · uppercase' : ''), 'Mono/Small', 'text/muted')]),
      text(t.name.indexOf('Mono') === 0 ? 'MP-10482 · Ctrl K' : (t.size >= 22 ? 'AUD 12,904.60' : 'Accept order MP-10482 before 2:50 pm'), t.name, 'text/primary', { w: 1000 }),
    ]));
  });
  tag(root);
}

async function pageSpacing(page) {
  const root = pageShell(page, 'Spacing, size & radius', 'A 2 px base with 4 px steps for layout. Values switch between Desktop and Touch density; touch makes controls 48 px.');
  let s = docSection(root, 'Spacing');
  SPEC.dimension.filter(function (d) { return d.name.indexOf('space/') === 0; }).forEach(function (d) {
    add(s, frame({ name: d.name, dir: 'H', gap: 'space/4', align: 'center' }, [text(d.name, 'Mono/Default', 'text/primary', { w: 160 }), rect({ name: 'bar', w: d.name, h: 16, fill: 'action/primary', radius: 2 }), text(d.desktop + ' px', 'Body/Small', 'text/muted')]));
  });
  s = docSection(root, 'Radius');
  add(s, frame({ name: 'Radius', dir: 'H', gap: 'space/6' }, SPEC.dimension.filter(function (d) { return d.name.indexOf('radius/') === 0; }).map(function (d) {
    return frame({ name: d.name, dir: 'V', gap: 'space/2', align: 'center' }, [rect({ name: 'sample', w: 96, h: 64, fill: 'bg/selected', stroke: 'action/primary', radius: d.name }), text(d.name, 'Mono/Small', 'text/primary'), text(d.desktop === 999 ? 'pill' : d.desktop + ' px (touch ' + d.touch + ')', 'Caption/Default', 'text/muted')]);
  })));
  s = docSection(root, 'Sizes', 'Desktop and touch values. On the Starter plan touch values are in the "Dimension · Touch" collection.');
  add(s, table(['Token', 'Desktop', 'Touch', 'Use'], SPEC.dimension.filter(function (d) { return d.name.indexOf('size/') === 0 || d.name.indexOf('border/') === 0; }).map(function (d) {
    const use = { 'size/control-sm': 'Row buttons', 'size/control': 'Buttons and inputs', 'size/control-lg': 'Tablet header controls', 'size/badge': 'Badges', 'size/icon': 'Icons', 'size/thumb': 'Product thumbnail in rows', 'size/sidebar': 'Sidebar width', 'size/sidebar-collapsed': 'Collapsed sidebar', 'size/topbar': 'Top bar height', 'border/width': 'Default border', 'border/width-strong': 'Selected tab, urgent card' }[d.name] || '';
    return [d.name, d.desktop + ' px', d.touch + ' px', use];
  }), [260, 160, 160, 600]));
  tag(root);
}

async function pageElevation(page) {
  const root = pageShell(page, 'Elevation & motion', 'The interface is flat: borders separate surfaces. Shadows are reserved for things that float above the page.');
  let s = docSection(root, 'Effect styles');
  add(s, frame({ name: 'Effects', dir: 'H', gap: 'space/8', pad: 'space/8', fill: 'bg/page' }, SPEC.effects.map(function (e) {
    return frame({ name: e.name, dir: 'V', gap: 'space/3', align: 'center' }, [frame({ name: 'sample', w: 200, h: 120, fill: 'bg/surface', radius: 'radius/card', effect: e.name, stroke: 'border/default' }), text(e.name, 'Body/Strong'), text(e.description, 'Caption/Default', 'text/muted', { w: 200, align: 'center' })]);
  })));
  s = docSection(root, 'Motion', 'Short and purposeful. With prefers-reduced-motion every movement becomes instant.');
  add(s, table(['Token', 'Value', 'Use'], [
    ['duration/fast', '120 ms', 'Hover and press colour changes'], ['duration/base', '160 ms', 'Bulk action bar in and out, tab change'], ['duration/slow', '240 ms', 'Order card moving between board columns'], ['easing (code only)', 'cubic-bezier(0.2, 0, 0, 1)', 'Standard easing for all movement'],
  ], [280, 260, 700]));
  tag(root);
}

async function pageIcons(page, iconsWrap) {
  const root = pageShell(page, 'Icons', 'Line icons on a 24 px grid, drawn at 20 px with a 1.75 px stroke. Swap icons through the Icon property on components; colour them with icon, text or status tokens.');
  const s = docSection(root, 'Library');
  add(s, iconsWrap);
  tag(root);
}

async function pageA11y(page) {
  const root = pageShell(page, 'Accessibility', 'WCAG 2.2 AA is the floor. Every pair below was measured for both themes.');
  let s = docSection(root, 'Contrast', 'Text needs 4.5:1. Icons, chart marks, focus rings and input borders need 3:1.');
  const rows = CONTRAST.filter(function (c, i) { return i % 1 === 0; }).map(function (c) { return [c[0], c[2] + ' on ' + c[3], c[1], c[4] + ':1', c[5] + ':1', c[6] ? 'Pass' : 'Fail']; });
  add(s, table(['Theme', 'Pair', 'Kind', 'Ratio', 'Needs', 'Result'], rows, [100, 520, 140, 120, 120, 120]));
  s = docSection(root, 'Rules');
  add(s, bullets([
    'Never show state by colour alone: badges carry a dot, a progress ring or an icon, and a word.',
    'Focus: every interactive component has a Focus state using the Focus/Ring effect (2 px gap + 2 px ring).',
    'Touch: tablet actions are 48 px high; nothing interactive is smaller than 24 × 24 px (WCAG 2.5.8).',
    'Timers update every 60 seconds and are not announced; only crossing a threshold is announced.',
    'Charts and maps have a text alternative and a "View as table" option in code.',
    'Logical layout: build with auto layout and start/end alignment so the UI can mirror for RTL.',
  ], 1100));
  tag(root);
}
