'use strict';
// Strict mock of the Figma Plugin API (documentAccess: dynamic-page) for testing the generator.
// It enforces the rules that make real plugins fail: unloaded fonts, FILL/HUG/ABSOLUTE rules, paint and
// effect shapes, variable types and scopes, mode limits, component property keys and references,
// edits inside instances, vector path grammar, sync APIs that throw in dynamic-page mode.

function makeFigma(opts) {
  opts = opts || {};
  let MAX_MODES = opts.maxModes || 1;
  let MAX_PAGES = opts.maxPages || Infinity;
  const FONTS = new Set(opts.fonts || [
    'Inter|Regular', 'Inter|Medium', 'Inter|Semi Bold', 'Inter|Bold', 'Roboto Mono|Regular', 'Roboto Mono|Medium',
    'IBM Plex Sans|Regular', 'IBM Plex Sans|Medium', 'IBM Plex Sans|SemiBold', 'IBM Plex Sans|Bold', 'IBM Plex Mono|Regular', 'IBM Plex Mono|Medium',
  ]);
  const loaded = new Set();
  const OUT = { messages: [], ui: null };
  let idc = 1;
  const byId = new Map();
  const MIXED = Symbol('figma.mixed');
  // Real Figma nodes are not extensible: plugin code cannot add its own properties to them.
  function seal(n) { Object.preventExtensions(n); return n; }
  function fail(m) { const e = new Error(m); e.mock = true; throw e; }
  const fk = (f) => f.family + '|' + f.style;
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function checkKeys(o, allowed, what) { Object.keys(o).forEach((k) => { if (allowed.indexOf(k) < 0) fail('Unrecognized key "' + k + '" in ' + what); }); }
  function checkRGB(c, alpha, what) {
    if (!c || typeof c !== 'object') fail(what + ': colour required');
    checkKeys(c, alpha ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'], what + ' colour');
    ['r', 'g', 'b'].concat(alpha ? ['a'] : []).forEach((k) => { if (!isNum(c[k]) || c[k] < 0 || c[k] > 1) fail(what + ': colour.' + k + ' must be 0..1, got ' + c[k]); });
  }
  function checkPaint(p) {
    if (!p || typeof p !== 'object') fail('Paint must be an object');
    if (p.type !== 'SOLID') fail('Only SOLID paints are used here, got ' + p.type);
    checkKeys(p, ['type', 'color', 'opacity', 'visible', 'blendMode', 'boundVariables'], 'SolidPaint');
    checkRGB(p.color, false, 'SolidPaint');
    if (p.opacity !== undefined && (!isNum(p.opacity) || p.opacity < 0 || p.opacity > 1)) fail('Paint opacity out of range');
    if (p.boundVariables) { checkKeys(p.boundVariables, ['color'], 'paint.boundVariables'); const v = VARS.get(p.boundVariables.color.id); if (!v) fail('Paint bound to missing variable'); }
  }
  function checkEffect(e) {
    checkKeys(e, ['type', 'color', 'offset', 'radius', 'spread', 'visible', 'blendMode', 'showShadowBehindNode', 'boundVariables'], 'Effect');
    if (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW') fail('Effect type ' + e.type);
    checkRGB(e.color, true, 'Effect'); if (!e.offset || !isNum(e.offset.x) || !isNum(e.offset.y)) fail('Effect offset'); if (!isNum(e.radius) || e.radius < 0) fail('Effect radius');
    if (e.visible === undefined || e.blendMode === undefined) fail('Effect needs visible and blendMode');
  }
  const deep = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  // ------------------------------------------------------------ variables
  const VARS = new Map(); const COLLS = new Map();
  const SCOPES = {
    COLOR: ['ALL_SCOPES', 'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR', 'EFFECT_COLOR'],
    FLOAT: ['ALL_SCOPES', 'TEXT_CONTENT', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP', 'STROKE_FLOAT', 'OPACITY', 'EFFECT_FLOAT', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT'],
    STRING: ['ALL_SCOPES', 'TEXT_CONTENT', 'FONT_FAMILY', 'FONT_STYLE'],
    BOOLEAN: ['ALL_SCOPES'],
  };
  class VariableCollection {
    constructor(name) { this.id = 'VariableCollectionId:' + (idc++); this.name = name; this._modes = [{ modeId: idc++ + ':0', name: 'Mode 1' }]; this._vars = []; this.hiddenFromPublishing = false; this.removed = false; COLLS.set(this.id, this); }
    get modes() { return this._modes.map((m) => Object.assign({}, m)); }
    get defaultModeId() { return this._modes[0].modeId; }
    get variableIds() { return this._vars.slice(); }
    addMode(name) {
      if (this._modes.length >= MAX_MODES) fail('in addMode: Limited to ' + MAX_MODES + ' modes only');
      if (this._modes.some((m) => m.name === name)) fail('Mode name exists');
      const id = idc++ + ':0'; this._modes.push({ modeId: id, name: name });
      this._vars.forEach((vid) => { const v = VARS.get(vid); v._values[id] = deep(v._values[this._modes[0].modeId]); });
      return id;
    }
    renameMode(id, name) { const m = this._modes.find((x) => x.modeId === id); if (!m) fail('renameMode: no such mode'); m.name = name; }
    remove() { this._vars.forEach((v) => { VARS.get(v).removed = true; VARS.delete(v); }); this.removed = true; COLLS.delete(this.id); }
  }
  class Variable {
    constructor(name, coll, type) {
      if (!(coll instanceof VariableCollection)) fail('createVariable: pass the collection node');
      if (!SCOPES[type]) fail('Bad variable type ' + type);
      if (/[.{}]/.test(name) || /^\/|\/$/.test(name) || name.indexOf('//') >= 0) fail('Invalid variable name ' + name);
      if (coll._vars.some((id) => VARS.get(id).name === name)) fail('Variable "' + name + '" already exists in ' + coll.name);
      this.id = 'VariableID:' + (idc++); this.name = name; this.resolvedType = type; this.variableCollectionId = coll.id; this._values = {}; this._scopes = ['ALL_SCOPES']; this.description = ''; this.codeSyntax = {}; this.removed = false;
      coll._vars.push(this.id); VARS.set(this.id, this);
    }
    get valuesByMode() { return deep(this._values); }
    get scopes() { return this._scopes.slice(); }
    set scopes(s) {
      if (!Array.isArray(s)) fail('scopes must be an array');
      s.forEach((x) => { if (SCOPES[this.resolvedType].indexOf(x) < 0) fail('Scope ' + x + ' is not valid for ' + this.resolvedType + ' variable ' + this.name); });
      if (s.indexOf('ALL_SCOPES') >= 0 && s.length > 1) fail('ALL_SCOPES cannot be combined');
      if (s.indexOf('ALL_FILLS') >= 0 && s.some((x) => /_FILL$/.test(x) && x !== 'ALL_FILLS')) fail('ALL_FILLS cannot be combined with other fill scopes');
      this._scopes = s.slice();
    }
    setValueForMode(modeId, value) {
      const c = COLLS.get(this.variableCollectionId); if (!c._modes.some((m) => m.modeId === modeId)) fail('setValueForMode: mode ' + modeId + ' is not in ' + c.name);
      if (value && value.type === 'VARIABLE_ALIAS') {
        checkKeys(value, ['type', 'id'], 'VariableAlias');
        const t = VARS.get(value.id); if (!t) fail('Alias to missing variable'); if (t === this) fail('Alias to itself');
        if (t.resolvedType !== this.resolvedType) fail('Alias type mismatch ' + t.resolvedType + ' → ' + this.resolvedType);
      } else if (this.resolvedType === 'COLOR') { checkRGB(value, 'a' in (value || {}), 'Variable ' + this.name); }
      else if (this.resolvedType === 'FLOAT') { if (!isNum(value)) fail('FLOAT variable ' + this.name + ' got ' + value); }
      else if (this.resolvedType === 'STRING') { if (typeof value !== 'string') fail('STRING variable got ' + value); }
      this._values[modeId] = deep(value);
    }
    setVariableCodeSyntax(p, v) { if (['WEB', 'ANDROID', 'iOS'].indexOf(p) < 0) fail('code syntax platform'); if (typeof v !== 'string') fail('code syntax value'); this.codeSyntax[p] = v; }
    resolve(modeId) {
      let v = this; let mode = modeId; let guard = 0;
      for (;;) {
        const c = COLLS.get(v.variableCollectionId); const val = v._values[mode !== undefined && v._values[mode] !== undefined ? mode : c._modes[0].modeId];
        if (val && val.type === 'VARIABLE_ALIAS') { v = VARS.get(val.id); mode = undefined; if (guard++ > 20) fail('alias loop'); continue; }
        return val;
      }
    }
    remove() { const c = COLLS.get(this.variableCollectionId); c._vars = c._vars.filter((x) => x !== this.id); VARS.delete(this.id); this.removed = true; }
  }
  const alias = (v) => ({ type: 'VARIABLE_ALIAS', id: v.id });
  function needVar(v, type, what) { if (!(v instanceof Variable) || v.removed) fail(what + ': variable missing or removed'); if (type && v.resolvedType !== type) fail(what + ': needs ' + type + ' variable, got ' + v.resolvedType + ' (' + v.name + ')'); }

  // ------------------------------------------------------------ styles
  const STYLES = new Map();
  class TextStyle {
    constructor() { this.id = 'S:' + (idc++).toString(16) + ','; this.type = 'TEXT'; this.name = 'Text style'; this.description = ''; this._font = { family: 'Inter', style: 'Regular' }; this.fontSize = 12; this.lineHeight = { unit: 'AUTO' }; this.letterSpacing = { unit: 'PIXELS', value: 0 }; this.textCase = 'ORIGINAL'; this._bv = {}; this._spd = {}; STYLES.set(this.id, this); }
    get fontName() { return Object.assign({}, this._font); }
    set fontName(f) { if (!loaded.has(fk(f))) fail('TextStyle.fontName: font ' + fk(f) + ' is not loaded'); this._font = Object.assign({}, f); }
    get boundVariables() { return deep(this._bv); }
    setBoundVariable(field, v) {
      const T = { fontFamily: 'STRING', fontStyle: 'STRING', fontSize: 'FLOAT', lineHeight: 'FLOAT', letterSpacing: 'FLOAT', fontWeight: 'FLOAT', paragraphSpacing: 'FLOAT', paragraphIndent: 'FLOAT' };
      if (!T[field]) fail('TextStyle.setBoundVariable: bad field ' + field); needVar(v, T[field], 'TextStyle.' + field);
      if (field === 'fontFamily') { const fam = v.resolve(); if (!loaded.has(fam + '|' + this._font.style)) fail('TextStyle.fontFamily variable font ' + fam + ' ' + this._font.style + ' not loaded'); this._font.family = fam; }
      if (field === 'fontSize') this.fontSize = v.resolve();
      if (field === 'lineHeight') this.lineHeight = { unit: 'PIXELS', value: v.resolve() };
      this._bv[field] = alias(v);
    }
    remove() { STYLES.delete(this.id); this.removed = true; }
    setPluginData(k, v) { if (typeof v !== 'string') fail('setPluginData value must be a string'); this._spd[k] = v; }
    getPluginData(k) { return this._spd[k] || ''; }
  }
  class EffectStyle {
    constructor() { this.id = 'S:' + (idc++).toString(16) + ','; this.type = 'EFFECT'; this.name = 'Effect style'; this.description = ''; this._effects = []; this._spd = {}; STYLES.set(this.id, this); }
    get effects() { return deep(this._effects); }
    set effects(a) { if (!Array.isArray(a)) fail('effects must be array'); a.forEach(checkEffect); this._effects = deep(a); }
    remove() { STYLES.delete(this.id); this.removed = true; }
    setPluginData(k, v) { if (typeof v !== 'string') fail('setPluginData value must be a string'); this._spd[k] = v; }
    getPluginData(k) { return this._spd[k] || ''; }
  }

  // ------------------------------------------------------------ nodes
  const CONTAINER = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'PAGE', 'DOCUMENT', 'SECTION']);
  const AUTO = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
  const CORNERS = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'RECTANGLE']);
  const MODE_NODES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'PAGE']);
  const BIND = { width: 'FLOAT', height: 'FLOAT', minWidth: 'FLOAT', maxWidth: 'FLOAT', minHeight: 'FLOAT', maxHeight: 'FLOAT', itemSpacing: 'FLOAT', counterAxisSpacing: 'FLOAT', paddingLeft: 'FLOAT', paddingRight: 'FLOAT', paddingTop: 'FLOAT', paddingBottom: 'FLOAT', topLeftRadius: 'FLOAT', topRightRadius: 'FLOAT', bottomLeftRadius: 'FLOAT', bottomRightRadius: 'FLOAT', strokeWeight: 'FLOAT', strokeTopWeight: 'FLOAT', strokeBottomWeight: 'FLOAT', strokeLeftWeight: 'FLOAT', strokeRightWeight: 'FLOAT', opacity: 'FLOAT', visible: 'BOOLEAN', characters: 'STRING' };
  let currentPage = null;

  class BaseNode {
    constructor(type) { this.type = type; this.id = (idc++) + ':' + 1; this._name = type.charAt(0) + type.slice(1).toLowerCase(); this.parent = null; this._pd = {}; this.removed = false; if (CONTAINER.has(type)) this.children = []; byId.set(this.id, this); }
    get name() { return this._name; }
    set name(v) { if (typeof v !== 'string') fail('name must be a string'); this._name = v; }
    setPluginData(k, v) { if (typeof k !== 'string' || typeof v !== 'string') fail('setPluginData(key, value) takes strings'); this._pd[k] = v; }
    getPluginData(k) { return this._pd[k] || ''; }
    instAncestor() { let p = this.parent; while (p) { if (p.type === 'INSTANCE') return p; p = p.parent; } return null; }
    compAncestor() { let p = this.parent; while (p) { if (p.type === 'COMPONENT') return p; if (p.type === 'PAGE') return null; p = p.parent; } return null; }
    page() { let p = this; while (p && p.type !== 'PAGE') p = p.parent; return p; }
    _checkLive() { if (this.removed) fail('The node (' + this.name + ') has been removed'); }
    _kids() { if (this.type === 'PAGE' && !this._loaded) fail('Cannot access children on a page that has not been explicitly loaded. Call loadAsync() or loadAllPagesAsync().'); return this.children; }
    appendChild(c) { return this.insertChild(this.children ? this.children.length : 0, c); }
    insertChild(i, c) {
      this._checkLive(); c._checkLive();
      if (!this.children) fail(this.type + ' cannot have children');
      if (this.type === 'INSTANCE' || this.instAncestor()) fail('Cannot move node. New parent is an instance or is inside of an instance');
      if (c.instAncestor()) fail('Cannot move a node that is inside an instance');
      for (let p = this; p; p = p.parent) if (p === c) fail('Cannot append a node into itself or its descendant');
      if (this.type === 'COMPONENT_SET' && c.type !== 'COMPONENT') fail('Component sets can only contain components');
      if (this.type === 'DOCUMENT' && c.type !== 'PAGE') fail('Only pages can be children of the document');
      if (this.type !== 'DOCUMENT' && c.type === 'PAGE') fail('Pages can only be children of the document');
      if ((c.type === 'COMPONENT' || c.type === 'COMPONENT_SET') && (this.type === 'COMPONENT' || this.compAncestor())) fail('Cannot put a main component inside another component');
      if (c.parent) { if (c.parent.type === 'COMPONENT_SET' && c.parent !== this) fail('Cannot move a variant out of its component set'); const k = c.parent.children; k.splice(k.indexOf(c), 1); }
      this.children.splice(Math.min(i, this.children.length), 0, c); c.parent = this;
      if (c._fillH && !(this._isAuto && this._isAuto())) c._fillH = false;
      if (c._fillV && !(this._isAuto && this._isAuto())) c._fillV = false;
      return c;
    }
    remove() {
      this._checkLive();
      if (this.instAncestor()) fail('Cannot remove a node inside an instance');
      if (this.type === 'PAGE') { if (this === currentPage) fail('Cannot remove the current page'); if (ROOT.children.length <= 1) fail('Cannot remove the last page'); }
      if (this.parent) { const k = this.parent.children; k.splice(k.indexOf(this), 1); }
      const kill = (n) => { n.removed = true; byId.delete(n.id); (n.children || []).forEach(kill); }; kill(this); this.parent = null;
    }
    findAll(cb) { const out = []; const walk = (n) => { (n.type === 'PAGE' ? n._kids() : n.children || []).forEach((c) => { if (!cb || cb(c)) out.push(c); walk(c); }); }; walk(this); return out; }
    findOne(cb) { const r = this.findAll(cb); return r[0] || null; }
    findChildren(cb) { return (this.children || []).filter((c) => !cb || cb(c)); }
  }

  class SceneNode extends BaseNode {
    constructor(type) {
      super(type);
      this._x = 0; this._y = 0; this._w = 100; this._h = 100; this.visible = true; this.locked = false;
      this._fills = []; this._strokes = []; this._effects = []; this._bv = {}; this._refs = null; this._modes = {};
      this.strokeWeight = 1; this._strokeAlign = 'INSIDE'; this.dashPattern = []; this.opacity = 1; this.constraints = { horizontal: 'MIN', vertical: 'MIN' }; this._rot = 0;
      this._layoutPositioning = 'AUTO'; this._fillH = false; this._fillV = false;
      ['strokeTopWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'strokeRightWeight', '_style', '_effectStyle', '_cap', '_join', '_radius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', '_minW', '_minH', '_ovf', '_abb', '_exposed', '_arc', '_ls', '_case', '_dec', '_align', '_src'].forEach((k) => { this[k] = undefined; });
      if (AUTO.has(type)) Object.assign(this, { _layoutMode: 'NONE', _pAxis: 'FIXED', _cAxis: 'FIXED', paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, itemSpacing: 0, _counterAxisSpacing: 0, _wrap: 'NO_WRAP', _pAlign: 'MIN', _cAlign: 'MIN', clipsContent: true });
    }
    _isAuto() { return AUTO.has(this.type) && this.layoutMode !== 'NONE'; }
    _guardInst(what) { /* structural props cannot change inside instances */ if (this.instAncestor() && ['layoutMode', 'layoutWrap'].indexOf(what) >= 0) fail('Cannot change ' + what + ' of a node inside an instance'); }
    get rotation() { return this._rot; } set rotation(v) { if (!isNum(v) || v < -180 || v > 180) fail('rotation must be a number from -180 to 180'); this._rot = v; }
    get x() { return this._x; } set x(v) { if (!isNum(v)) fail('x must be a number'); this._x = v; }
    get y() { return this._y; } set y(v) { if (!isNum(v)) fail('y must be a number'); this._y = v; }
    // --- geometry
    get fills() { return Object.freeze(deep(this._fills)); }
    set fills(a) { if (a === MIXED) fail('Cannot set fills to mixed'); if (!Array.isArray(a)) fail('fills must be an array'); a.forEach(checkPaint); this._fills = deep(a); }
    get strokes() { return Object.freeze(deep(this._strokes)); }
    set strokes(a) { if (!Array.isArray(a)) fail('strokes must be an array'); a.forEach(checkPaint); this._strokes = deep(a); }
    // The mock does not lay out, so a node has no absolute bounds unless a test gives them (node._abb = { x, y, width, height }).
    get absoluteBoundingBox() { return this._abb ? deep(this._abb) : null; }
    // Prototype scrolling: frames, components and instances only.
    get overflowDirection() { return AUTO.has(this.type) ? this._ovf || 'NONE' : undefined; }
    set overflowDirection(v) { if (!AUTO.has(this.type) || this.type === 'COMPONENT_SET') fail('overflowDirection not supported on ' + this.type); if (['NONE', 'HORIZONTAL', 'VERTICAL', 'BOTH'].indexOf(v) < 0) fail('overflowDirection ' + v); this._ovf = v; }
    get strokeAlign() { return this._strokeAlign; }
    set strokeAlign(v) { if (['INSIDE', 'OUTSIDE', 'CENTER'].indexOf(v) < 0) fail('strokeAlign ' + v); this._strokeAlign = v; }
    // A node with an effect style shows the style's effects, so a change to the style reaches every node (as in Figma); setting effects detaches it.
    get effects() { const st = this._effectStyle && STYLES.get(this._effectStyle); return deep(st ? st._effects : this._effects); }
    set effects(a) { if (!Array.isArray(a)) fail('effects must be an array'); a.forEach(checkEffect); this._effects = deep(a); this._effectStyle = undefined; }
    setEffectStyleIdAsync(id) { return Promise.resolve().then(() => { this._checkLive(); const s = STYLES.get(id); if (!s || s.type !== 'EFFECT') fail('No effect style ' + id); this._effectStyle = id; this._effects = s.effects; }); }
    set effectStyleId(v) { fail('Cannot set effectStyleId with documentAccess: dynamic-page. Use setEffectStyleIdAsync'); }
    get cornerRadius() { return this._radius === undefined ? 0 : this._radius; }
    set cornerRadius(v) { if (!CORNERS.has(this.type)) fail('cornerRadius not supported on ' + this.type); if (!isNum(v) || v < 0) fail('cornerRadius'); this._radius = v; this.topLeftRadius = this.topRightRadius = this.bottomLeftRadius = this.bottomRightRadius = v; }
    get strokeCap() { return this._cap || 'NONE'; } set strokeCap(v) { if (['NONE', 'ROUND', 'SQUARE', 'ARROW_LINES', 'ARROW_EQUILATERAL'].indexOf(v) < 0) fail('strokeCap ' + v); this._cap = v; }
    get strokeJoin() { return this._join || 'MITER'; } set strokeJoin(v) { if (['MITER', 'BEVEL', 'ROUND'].indexOf(v) < 0) fail('strokeJoin ' + v); this._join = v; }
    // --- size
    get width() { return this._size('w'); }
    get height() { return this._size('h'); }
    resize(w, h) {
      this._checkLive();
      if (!isNum(w) || !isNum(h) || w < 0.01 || h < 0.01) fail('resize(' + w + ', ' + h + '): width and height must be >= 0.01');
      this._w = w; this._h = h;
      if (this.type === 'TEXT') { if (this._autoResize === 'WIDTH_AND_HEIGHT') this._autoResize = 'NONE'; }
      if (AUTO.has(this.type)) { this._pAxis = 'FIXED'; this._cAxis = 'FIXED'; }
      this._fillH = false; this._fillV = false;
    }
    _size(axis) {
      if (this.type === 'TEXT') return this._textSize(axis);
      if (this._isAuto()) {
        const primary = this._layoutMode === 'HORIZONTAL' ? 'w' : 'h';
        const hug = axis === primary ? this._pAxis === 'AUTO' : this._cAxis === 'AUTO';
        const fill = axis === 'w' ? this._fillH : this._fillV;
        if (hug && !fill) { const h = this._hug(axis, primary); const mn = axis === 'w' ? this._minW : this._minH; return mn ? Math.max(h, mn) : h; } // minWidth / minHeight hold a hugging frame open
      }
      return axis === 'w' ? this._w : this._h;
    }
    _hug(axis, primary) {
      const kids = (this.children || []).filter((c) => c.visible && c._layoutPositioning !== 'ABSOLUTE');
      const pad = axis === 'w' ? this.paddingLeft + this.paddingRight : this.paddingTop + this.paddingBottom;
      if (!kids.length) return Math.max(0.01, pad);
      const sizes = kids.map((c) => (axis === 'w' ? c.width : c.height));
      if (axis === primary) return pad + sizes.reduce((a, b) => a + b, 0) + (this._pAlign === 'SPACE_BETWEEN' ? 0 : this.itemSpacing * (kids.length - 1));
      return pad + Math.max.apply(null, sizes);
    }
    // --- auto layout
    get layoutMode() { return AUTO.has(this.type) ? (this.type === 'INSTANCE' && this._layoutMode === undefined ? 'NONE' : this._layoutMode) : undefined; }
    set layoutMode(v) { if (!AUTO.has(this.type)) fail('layoutMode not supported on ' + this.type); if (this.type === 'INSTANCE') fail('Cannot change layoutMode of an instance'); this._guardInst('layoutMode'); if (['NONE', 'HORIZONTAL', 'VERTICAL'].indexOf(v) < 0) fail('layoutMode ' + v); this._layoutMode = v; }
    get primaryAxisSizingMode() { return this._pAxis; } set primaryAxisSizingMode(v) { if (['FIXED', 'AUTO'].indexOf(v) < 0) fail('primaryAxisSizingMode ' + v); this._pAxis = v; }
    get counterAxisSizingMode() { return this._cAxis; } set counterAxisSizingMode(v) { if (['FIXED', 'AUTO'].indexOf(v) < 0) fail('counterAxisSizingMode ' + v); this._cAxis = v; }
    get primaryAxisAlignItems() { return this._pAlign; } set primaryAxisAlignItems(v) { if (['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN'].indexOf(v) < 0) fail('primaryAxisAlignItems ' + v); this._pAlign = v; }
    get counterAxisAlignItems() { return this._cAlign; } set counterAxisAlignItems(v) { if (['MIN', 'MAX', 'CENTER', 'BASELINE'].indexOf(v) < 0) fail('counterAxisAlignItems ' + v); if (v === 'BASELINE' && this._layoutMode !== 'HORIZONTAL') fail('BASELINE alignment needs a horizontal layout'); this._cAlign = v; }
    get layoutWrap() { return this._wrap; } set layoutWrap(v) { this._guardInst('layoutWrap'); if (v === 'WRAP' && this._layoutMode !== 'HORIZONTAL') fail('layoutWrap WRAP needs a HORIZONTAL layout'); this._wrap = v; }
    get counterAxisSpacing() { return this._counterAxisSpacing; } set counterAxisSpacing(v) { if (this._wrap !== 'WRAP') fail('counterAxisSpacing needs layoutWrap WRAP'); if (!isNum(v)) fail('counterAxisSpacing'); this._counterAxisSpacing = v; }
    get layoutPositioning() { return this._layoutPositioning; }
    set layoutPositioning(v) { if (v === 'ABSOLUTE' && !(this.parent && this.parent._isAuto && this.parent._isAuto())) fail('layoutPositioning ABSOLUTE can only be set on children of auto-layout frames'); this._layoutPositioning = v; }
    get layoutSizingHorizontal() { return this._sizingGet('w'); } set layoutSizingHorizontal(v) { this._sizingSet('w', v); }
    get layoutSizingVertical() { return this._sizingGet('h'); } set layoutSizingVertical(v) { this._sizingSet('h', v); }
    _sizingGet(axis) {
      if (axis === 'w' ? this._fillH : this._fillV) return 'FILL';
      if (this.type === 'TEXT') return (this._autoResize === 'WIDTH_AND_HEIGHT' || (axis === 'h' && this._autoResize === 'HEIGHT')) ? 'HUG' : 'FIXED';
      if (this._isAuto()) { const primary = this._layoutMode === 'HORIZONTAL' ? 'w' : 'h'; return (axis === primary ? this._pAxis : this._cAxis) === 'AUTO' ? 'HUG' : 'FIXED'; }
      return 'FIXED';
    }
    _sizingSet(axis, v) {
      if (['FIXED', 'HUG', 'FILL'].indexOf(v) < 0) fail('layoutSizing ' + v);
      if (v === 'FILL') {
        if (!this.parent || !this.parent._isAuto || !this.parent._isAuto()) fail('FILL can only be set on children of auto-layout frames (' + this.name + ')');
        if (this._layoutPositioning === 'ABSOLUTE') fail('FILL cannot be set on absolutely positioned nodes');
        // give it the parent's inner size on the counter axis as an approximation
        const p = this.parent; const inner = axis === 'w' ? p.width - p.paddingLeft - p.paddingRight : p.height - p.paddingTop - p.paddingBottom;
        if (axis === 'w') { this._fillH = true; if (inner > 0.01) this._w = inner; } else { this._fillV = true; if (inner > 0.01) this._h = inner; }
        return;
      }
      if (v === 'HUG') {
        if (this.type === 'TEXT') { this._autoResize = axis === 'w' ? 'WIDTH_AND_HEIGHT' : (this._autoResize === 'WIDTH_AND_HEIGHT' ? 'WIDTH_AND_HEIGHT' : 'HEIGHT'); }
        else if (!this._isAuto()) fail('HUG can only be set on auto-layout frames and text (' + this.type + ' ' + this.name + ')');
        else { const primary = this._layoutMode === 'HORIZONTAL' ? 'w' : 'h'; if (axis === primary) this._pAxis = 'AUTO'; else this._cAxis = 'AUTO'; }
      } else if (this._isAuto()) { const w = this.width, h = this.height; const primary = this._layoutMode === 'HORIZONTAL' ? 'w' : 'h'; if (axis === primary) this._pAxis = 'FIXED'; else this._cAxis = 'FIXED'; this._w = w; this._h = h; }
      if (axis === 'w') this._fillH = false; else this._fillV = false;
    }
    get minWidth() { return this._minW || null; }
    set minWidth(v) { if (!this._isAuto() && !(this.parent && this.parent._isAuto && this.parent._isAuto())) fail('minWidth needs an auto-layout frame or a child of one'); this._minW = v; }
    get minHeight() { return this._minH || null; }
    set minHeight(v) { if (!this._isAuto() && !(this.parent && this.parent._isAuto && this.parent._isAuto())) fail('minHeight needs an auto-layout frame or a child of one'); if (!isNum(v) || v < 0) fail('minHeight'); this._minH = v; }
    // --- variables
    get boundVariables() { const o = deep(this._bv); if (this._fills.some((p) => p.boundVariables)) o.fills = this._fills.map((p) => (p.boundVariables || {}).color).filter(Boolean); if (this._strokes.some((p) => p.boundVariables)) o.strokes = this._strokes.map((p) => (p.boundVariables || {}).color).filter(Boolean); return o; }
    setBoundVariable(field, v) {
      this._checkLive();
      if (!BIND[field]) fail('setBoundVariable: field ' + field + ' is not bindable');
      if (/Radius$/.test(field) && !CORNERS.has(this.type)) fail(field + ' not supported on ' + this.type);
      if (/^padding|itemSpacing|counterAxisSpacing/.test(field) && !AUTO.has(this.type)) fail(field + ' not supported on ' + this.type);
      if (field === 'characters' && this.type !== 'TEXT') fail('characters only on text');
      if (v === null) { delete this._bv[field]; return; }
      needVar(v, BIND[field], 'setBoundVariable(' + field + ') on ' + this.name);
      const val = v.resolve();
      if (field === 'width') this._w = val; else if (field === 'height') this._h = val; else if (field === 'counterAxisSpacing') this.counterAxisSpacing = val; else this[field] = val;
      this._bv[field] = alias(v);
    }
    setExplicitVariableModeForCollection(coll, modeId) {
      if (!MODE_NODES.has(this.type)) fail('setExplicitVariableModeForCollection is not supported on ' + this.type);
      if (typeof coll === 'string') fail('Pass the collection object, not its id (deprecated)');
      if (!(coll instanceof VariableCollection) || coll.removed) fail('Missing collection');
      if (!coll._modes.some((m) => m.modeId === modeId)) fail('Mode ' + modeId + ' is not in collection ' + coll.name);
      this._modes[coll.id] = modeId;
    }
    get explicitVariableModes() { return Object.assign({}, this._modes); }
    // --- component property references
    get componentPropertyReferences() { return this._refs || (this._src ? this._src.componentPropertyReferences : null); }
    set componentPropertyReferences(refs) {
      if (this.instAncestor()) fail('Cannot set componentPropertyReferences on a node inside an instance (' + this.name + ')');
      const comp = this.type === 'COMPONENT' ? null : this.compAncestor();
      if (!comp) fail('componentPropertyReferences needs a node inside a component');
      const defs = comp.parent && comp.parent.type === 'COMPONENT_SET' ? comp.parent._defs : comp._defs;
      Object.keys(refs || {}).forEach((k) => {
        const want = { visible: 'BOOLEAN', characters: 'TEXT', mainComponent: 'INSTANCE_SWAP' }[k];
        if (!want) fail('Bad componentPropertyReferences key ' + k);
        if (k === 'characters' && this.type !== 'TEXT') fail('characters reference on a non-text node');
        if (k === 'mainComponent' && this.type !== 'INSTANCE') fail('mainComponent reference on a non-instance node');
        const d = defs && defs[refs[k]]; if (!d) fail('Property ' + refs[k] + ' does not exist on ' + comp.name);
        if (d.type !== want) fail('Property ' + refs[k] + ' is ' + d.type + ', expected ' + want);
      });
      this._refs = Object.assign({}, refs);
    }
    clone() {
      this._checkLive();
      const c = cloneNode(this, false);
      const p = this.parent;
      if (p && (p.type === 'INSTANCE' || p.instAncestor())) fail('clone inside instance');
      if (p && p.type !== 'COMPONENT_SET') { p.children.splice(p.children.indexOf(this) + 1, 0, c); c.parent = p; } else { currentPage.children.push(c); c.parent = currentPage; }
      return c;
    }
  }
  function cloneNode(n, intoInstance) {
    let c;
    if (n.type === 'INSTANCE') { c = new InstanceNode(n._main); c._propVals = deep(n._propVals); }
    else if (n.type === 'COMPONENT' && intoInstance) c = new SceneNode('FRAME');
    else c = new (n.constructor)(n.type);
    const skip = { id: 1, parent: 1, children: 1, type: 1, _src: 1, _main: 1, _propVals: 1, removed: 1, _defs: 1 };
    Object.keys(n).forEach((k) => { if (!skip[k]) c[k] = deep(n[k]); });
    if (intoInstance) c._src = n;
    if (n.children) { c.children = []; n.children.forEach((k) => { const kc = cloneNode(k, intoInstance || n.type === 'INSTANCE'); kc.parent = c; c.children.push(kc); }); }
    return seal(c);
  }

  class TextNode extends SceneNode {
    constructor() { super('TEXT'); this._font = { family: 'Inter', style: 'Regular' }; this._chars = ''; this._fontSize = 12; this._lh = { unit: 'AUTO' }; this._autoResize = 'WIDTH_AND_HEIGHT'; this._fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; this.textTruncation = 'DISABLED'; this.maxLines = null; }
    _needFont(what) { if (!loaded.has(fk(this._font))) fail('Cannot write to node with unloaded font "' + this._font.family + ' ' + this._font.style + '" (' + what + '). Please call figma.loadFontAsync'); }
    get fontName() { return Object.assign({}, this._font); }
    set fontName(f) { this._checkLive(); if (!f || !f.family) fail('fontName'); if (!loaded.has(fk(f))) fail('Cannot use unloaded font ' + fk(f)); this._font = { family: f.family, style: f.style }; }
    get characters() { return this._chars; }
    set characters(s) { this._needFont('characters'); if (typeof s !== 'string') fail('characters must be a string'); this._chars = s; }
    get fontSize() { return this._fontSize; } set fontSize(v) { this._needFont('fontSize'); if (!isNum(v) || v < 1) fail('fontSize'); this._fontSize = v; }
    get lineHeight() { return deep(this._lh); } set lineHeight(v) { this._needFont('lineHeight'); checkKeys(v, ['unit', 'value'], 'lineHeight'); this._lh = deep(v); }
    get letterSpacing() { return this._ls || { unit: 'PERCENT', value: 0 }; } set letterSpacing(v) { this._needFont('letterSpacing'); this._ls = v; }
    get textCase() { return this._case || 'ORIGINAL'; } set textCase(v) { this._needFont('textCase'); if (['ORIGINAL', 'UPPER', 'LOWER', 'TITLE'].indexOf(v) < 0) fail('textCase'); this._case = v; }
    get textDecoration() { return this._dec || 'NONE'; } set textDecoration(v) { this._needFont('textDecoration'); this._dec = v; }
    get textAlignHorizontal() { return this._align || 'LEFT'; } set textAlignHorizontal(v) { this._needFont('textAlign'); if (['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'].indexOf(v) < 0) fail('textAlignHorizontal'); this._align = v; }
    get textAutoResize() { return this._autoResize; } set textAutoResize(v) { this._needFont('textAutoResize'); if (['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'].indexOf(v) < 0) fail('textAutoResize ' + v); this._autoResize = v; }
    setTextStyleIdAsync(id) { return Promise.resolve().then(() => { this._checkLive(); const s = STYLES.get(id); if (!s || s.type !== 'TEXT') fail('No text style ' + id); if (!loaded.has(fk(s._font))) fail('Text style font not loaded'); this._style = id; this._font = Object.assign({}, s._font); this._fontSize = s.fontSize; }); }
    set textStyleId(v) { fail('Cannot set textStyleId with documentAccess: dynamic-page. Use setTextStyleIdAsync'); }
    get textStyleId() { for (let x = this; x; x = x._src) if (x._style) return x._style; return ''; }
    _textSize(axis) {
      const lh = this._lh.unit === 'PIXELS' ? this._lh.value : this._fontSize * 1.3;
      const lines0 = this._chars.split('\n');
      const natural = Math.max.apply(null, lines0.map((l) => l.length)) * this._fontSize * 0.55 + 1;
      if (axis === 'w') return this._autoResize === 'WIDTH_AND_HEIGHT' && !this._fillH ? natural : this._w;
      if (this._autoResize === 'NONE' || this._autoResize === 'TRUNCATE') return this._h;
      let lines = this._autoResize === 'WIDTH_AND_HEIGHT' && !this._fillH ? lines0.length : lines0.reduce((a, l) => a + Math.max(1, Math.ceil((l.length * this._fontSize * 0.55) / Math.max(1, this._w))), 0);
      if (this.textTruncation === 'ENDING' && this.maxLines) lines = Math.min(lines, this.maxLines);
      return lines * lh;
    }
  }
  class VectorNode extends SceneNode {
    constructor() { super('VECTOR'); this._paths = []; this._strokeAlign = 'CENTER'; }
    get vectorPaths() { return deep(this._paths); }
    set vectorPaths(a) {
      a.forEach((p) => {
        checkKeys(p, ['windingRule', 'data'], 'VectorPath');
        if (['NONZERO', 'EVENODD', 'NONE'].indexOf(p.windingRule) < 0) fail('windingRule');
        const t = p.data.trim().split(/\s+/); const N = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
        if (t[0] !== 'M') fail('Vector path must start with M: ' + p.data);
        for (let i = 0; i < t.length;) {
          const cmd = t[i]; if (!(cmd in N)) fail('Invalid command "' + cmd + '" in vector path: ' + p.data);
          for (let j = 1; j <= N[cmd]; j++) if (!/^-?\d+(\.\d+)?(e-?\d+)?$/.test(t[i + j] || '')) fail('Invalid number "' + t[i + j] + '" in vector path: ' + p.data);
          i += N[cmd] + 1;
        }
      });
      this._paths = deep(a);
    }
  }
  class EllipseNode extends SceneNode {
    constructor() { super('ELLIPSE'); }
    get arcData() { return this._arc || { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 }; }
    set arcData(a) { checkKeys(a, ['startingAngle', 'endingAngle', 'innerRadius'], 'ArcData'); if (!isNum(a.startingAngle) || !isNum(a.endingAngle) || !isNum(a.innerRadius) || a.innerRadius < 0 || a.innerRadius > 1) fail('arcData'); this._arc = deep(a); }
  }
  class ComponentNode extends SceneNode {
    constructor() { super('COMPONENT'); this.description = ''; this._defs = {}; this._fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; this.clipsContent = false; }
    get variantProperties() { if (!this.parent || this.parent.type !== 'COMPONENT_SET') return null; const o = {}; this.name.split(',').forEach((kv) => { const p = kv.split('='); o[p[0].trim()] = (p[1] || '').trim(); }); return o; }
    get componentPropertyDefinitions() { if (this.parent && this.parent.type === 'COMPONENT_SET') fail('Can not get component property definitions of a component set child'); return deep(this._defs); }
    addComponentProperty(name, type, def) { if (this.parent && this.parent.type === 'COMPONENT_SET') fail('Cannot add component properties to a variant. Add them to the component set.'); return addProp(this, name, type, def); }
    get key() { return 'key:' + this.id; }
    editComponentProperty(name, nv) { if (this.parent && this.parent.type === 'COMPONENT_SET') fail('Cannot edit component properties of a variant. Edit the component set.'); return editProp(this, name, nv); }
    createInstance() {
      this._checkLive();
      if (this.instAncestor()) fail('createInstance on a node inside an instance');
      const i = seal(new InstanceNode(this)); currentPage.children.push(i); i.parent = currentPage; return i;
    }
  }
  // editComponentProperty: only preferredValues of an INSTANCE_SWAP property is emulated (the strict mock rejects anything else).
  function editProp(owner, name, nv) {
    const k = Object.keys(owner._defs).filter((x) => x === name || x.split('#')[0] === name)[0];
    if (!k) fail('Could not find a component property with name: ' + name + ' on ' + owner.name);
    Object.keys(nv || {}).forEach((f) => { if (f !== 'preferredValues') fail('editComponentProperty: the mock emulates preferredValues only, got ' + f); });
    const d = owner._defs[k];
    if (nv.preferredValues !== undefined) {
      if (d.type !== 'INSTANCE_SWAP') fail('preferredValues only apply to INSTANCE_SWAP properties');
      if (!Array.isArray(nv.preferredValues)) fail('preferredValues must be an array');
      nv.preferredValues.forEach((pv) => {
        if (!pv || (pv.type !== 'COMPONENT' && pv.type !== 'COMPONENT_SET') || typeof pv.key !== 'string') fail('Bad preferred value ' + JSON.stringify(pv));
        const n = [...byId.values()].find((x) => (x.type === 'COMPONENT' || x.type === 'COMPONENT_SET') && !x.removed && x.key === pv.key);
        if (!n || n.type !== pv.type) fail('Preferred value ' + pv.key + ' is not a ' + pv.type + ' in this file');
      });
      d.preferredValues = deep(nv.preferredValues);
    }
    return k;
  }
  function addProp(owner, name, type, def) {
    if (['TEXT', 'BOOLEAN', 'INSTANCE_SWAP', 'VARIANT'].indexOf(type) < 0) fail('Bad property type ' + type);
    if (/#/.test(name)) fail('Property names cannot contain #');
    if (Object.keys(owner._defs).some((k) => k.split('#')[0] === name)) fail('Property ' + name + ' already exists');
    if (owner.type === 'COMPONENT_SET' && owner.children.some((c) => name in (c.variantProperties || {}))) fail('Property ' + name + ' clashes with a variant property of ' + owner.name);
    if (type === 'TEXT' && typeof def !== 'string') fail('TEXT default must be a string');
    if (type === 'BOOLEAN' && typeof def !== 'boolean') fail('BOOLEAN default must be a boolean');
    if (type === 'INSTANCE_SWAP') { const n = byId.get(def); if (!n || n.type !== 'COMPONENT') fail('INSTANCE_SWAP default must be a component id'); }
    const key = name + '#' + (idc++) + ':' + 0;
    owner._defs[key] = { type: type, defaultValue: def };
    return key;
  }
  class ComponentSetNode extends SceneNode {
    constructor() { super('COMPONENT_SET'); this.description = ''; this._defs = {}; }
    get componentPropertyDefinitions() {
      const o = deep(this._defs);
      this.children.forEach((c) => { const vp = c.variantProperties; Object.keys(vp).forEach((k) => { o[k] = o[k] || { type: 'VARIANT', defaultValue: vp[k], variantOptions: [] }; if (o[k].variantOptions.indexOf(vp[k]) < 0) o[k].variantOptions.push(vp[k]); }); });
      return o;
    }
    get defaultVariant() { return this.children[0]; }
    addComponentProperty(name, type, def) { return addProp(this, name, type, def); }
    get key() { return 'key:' + this.id; }
    editComponentProperty(name, nv) { return editProp(this, name, nv); }
  }
  class InstanceNode extends SceneNode {
    constructor(main) {
      super('INSTANCE'); this._main = main; this._propVals = {};
      this._adopt(main);
    }
    _adopt(main) {
      const keep = { _x: this._x, _y: this._y, _fillH: this._fillH, _fillV: this._fillV, _layoutPositioning: this._layoutPositioning, _name: this._name, visible: this.visible, _pd: this._pd, _modes: this._modes };
      ['_layoutMode', '_pAxis', '_cAxis', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', '_counterAxisSpacing', '_wrap', '_pAlign', '_cAlign', 'clipsContent', '_w', '_h', '_fills', '_strokes', '_effects', '_bv', 'strokeWeight', '_strokeAlign', '_radius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'opacity', 'dashPattern', '_effectStyle'].forEach((k) => { if (main[k] !== undefined) this[k] = deep(main[k]); });
      (this.children || []).forEach((c) => { c.parent = null; });
      this.children = main.children.map((k) => { const c = cloneNode(k, true); c.parent = this; return c; });
      if (keep._name === 'Instance') keep._name = main.name;
      Object.assign(this, keep);
      if (this._name === 'Instance') this._name = main.name;
    }
    get mainComponent() { fail('Cannot call mainComponent with documentAccess: dynamic-page. Use getMainComponentAsync'); }
    getMainComponentAsync() { return Promise.resolve(this._main); }
    _defs() { const m = this._main; return m.parent && m.parent.type === 'COMPONENT_SET' ? m.parent.componentPropertyDefinitions : m._defs; }
    get componentProperties() {
      const d = this._defs(); const o = {}; const vp = this._main.variantProperties || {};
      Object.keys(d).forEach((k) => { o[k] = { type: d[k].type, value: d[k].type === 'VARIANT' ? vp[k] : (k in this._propVals ? this._propVals[k] : d[k].defaultValue) }; });
      return o;
    }
    set isExposedInstance(v) { if (this.instAncestor() || !this.compAncestor()) fail('Only nested instances directly inside a main component can be exposed'); this._exposed = !!v; }
    get isExposedInstance() { return !!this._exposed; }
    setProperties(props) {
      this._checkLive();
      const d = this._defs(); const variant = {}; const other = {};
      Object.keys(props).forEach((k) => {
        const def = d[k]; if (!def) fail('Could not find a component property with name: \'' + k + '\' on ' + this.name + ' (' + Object.keys(d).join(', ') + ')');
        const v = props[k];
        if (def.type === 'VARIANT') { if (def.variantOptions.indexOf(v) < 0) fail('Variant value ' + v + ' not in ' + def.variantOptions.join('/')); variant[k] = v; }
        else if (def.type === 'TEXT') { if (typeof v !== 'string') fail('TEXT property ' + k + ' needs a string'); other[k] = v; }
        else if (def.type === 'BOOLEAN') { if (typeof v !== 'boolean') fail('BOOLEAN property ' + k + ' needs a boolean, got ' + JSON.stringify(v)); other[k] = v; }
        else if (def.type === 'INSTANCE_SWAP') { const n = byId.get(v); if (!n || n.type !== 'COMPONENT') fail('INSTANCE_SWAP ' + k + ' needs a component id'); other[k] = v; }
      });
      if (Object.keys(variant).length) {
        const set = this._main.parent; const want = Object.assign({}, this._main.variantProperties, variant);
        const next = set.children.find((c) => Object.keys(want).every((k) => c.variantProperties[k] === want[k]));
        if (!next) fail('No variant of ' + set.name + ' matches ' + JSON.stringify(want));
        this._main = next; this._adopt(next); Object.keys(this._propVals).forEach((k) => { if (!(k in other)) other[k] = this._propVals[k]; }); // overrides carry over to the new variant; values set in this call win
      }
      Object.keys(other).forEach((k) => {
        this._propVals[k] = other[k]; const t = d[k].type;
        this.findAll(() => true).forEach((n) => {
          const r = n.componentPropertyReferences; if (!r) return;
          if (t === 'TEXT' && r.characters === k) { n._needFont('setProperties text'); n._chars = other[k]; }
          if (t === 'BOOLEAN' && r.visible === k) n.visible = other[k];
          if (t === 'INSTANCE_SWAP' && r.mainComponent === k) { n._main = byId.get(other[k]); n._adopt(n._main); }
        });
      });
    }
    resetOverrides() {}
  }

  class SectionNode extends SceneNode {
    constructor() { super('SECTION'); this._fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; }
    resize() { fail('node.resize is not a function (sections use resizeWithoutConstraints)'); }
    resizeWithoutConstraints(w, h) { if (!isNum(w) || !isNum(h) || w < 0.01 || h < 0.01) fail('resizeWithoutConstraints'); this._w = w; this._h = h; }
  }
  class PageNode extends BaseNode {
    constructor() { super('PAGE'); this._loaded = true; this.selection = []; this.backgrounds = []; this._modes = {}; }
    loadAsync() { this._loaded = true; return Promise.resolve(); }
    setExplicitVariableModeForCollection(c, m) { this._modes[c.id] = m; }
  }
  const ROOT = new BaseNode('DOCUMENT'); ROOT.name = 'Untitled';
  const p0 = new PageNode(); p0.name = 'Page 1'; ROOT.children.push(p0); p0.parent = ROOT; currentPage = p0;
  if (opts.prefill) { opts.prefill(ROOT); }

  function svgToNode(svg) {
    const head = svg.match(/<svg([^>]*)>/); if (!head) fail('createNodeFromSvg: invalid SVG');
    const attr = (s, k) => { const m = s.match(new RegExp('\\s' + k + '="([^"]*)"')); return m ? m[1] : null; };
    const f = seal(new SceneNode('FRAME')); f.name = 'svg'; f._w = +(attr(head[1], 'width') || 24); f._h = +(attr(head[1], 'height') || 24); f._fills = [];
    const rootFill = attr(head[1], 'fill'); const rootStroke = attr(head[1], 'stroke');
    const els = svg.match(/<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*>/g) || [];
    if (!els.length) fail('createNodeFromSvg: SVG has no shapes');
    els.forEach((e) => {
      const v = seal(new VectorNode()); v.name = 'Vector'; v._w = 10; v._h = 10;
      const fill = attr(e, 'fill') || rootFill; const stroke = attr(e, 'stroke') || rootStroke;
      v._fills = fill && fill !== 'none' ? [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] : [];
      v._strokes = stroke && stroke !== 'none' ? [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] : [];
      f.children.push(v); v.parent = f;
    });
    currentPage.children.push(f); f.parent = currentPage;
    return f;
  }

  const figma = {
    mixed: MIXED,
    get root() { return ROOT; },
    get currentPage() { return currentPage; },
    set currentPage(p) { fail('Cannot set currentPage with documentAccess: dynamic-page. Use figma.setCurrentPageAsync'); },
    setCurrentPageAsync(p) { if (!(p instanceof PageNode) || p.removed) fail('setCurrentPageAsync needs a page'); currentPage = p; p._loaded = true; return Promise.resolve(); },
    loadAllPagesAsync() { ROOT.children.forEach((p) => { p._loaded = true; }); return Promise.resolve(); },
    getNodeById() { fail('Cannot call getNodeById with documentAccess: dynamic-page. Use getNodeByIdAsync'); },
    getNodeByIdAsync(id) { return Promise.resolve(byId.get(id) || null); },
    getStyleById() { fail('Cannot call getStyleById with documentAccess: dynamic-page'); },
    getLocalTextStyles() { fail('Use getLocalTextStylesAsync'); },
    getLocalTextStylesAsync() { return Promise.resolve([...STYLES.values()].filter((s) => s.type === 'TEXT')); },
    getLocalEffectStylesAsync() { return Promise.resolve([...STYLES.values()].filter((s) => s.type === 'EFFECT')); },
    getLocalPaintStylesAsync() { return Promise.resolve([]); },
    loadFontAsync(f) { return new Promise((res, rej) => { setTimeout(() => { if (FONTS.has(fk(f))) { loaded.add(fk(f)); res(); } else rej(new Error('The font "' + f.family + ' ' + f.style + '" could not be loaded')); }, 0); }); },
    createSection() { const x = seal(new SectionNode()); x.name = 'Section'; currentPage.children.push(x); x.parent = currentPage; return x; },
    createPage() { if (ROOT.children.length >= MAX_PAGES) fail('The Starter plan only comes with 3 pages. Upgrade to Professional for unlimited pages.'); const p = new PageNode(); p.name = 'Page ' + (ROOT.children.length + 1); ROOT.children.push(p); p.parent = ROOT; return seal(p); },
    createFrame() { const f = seal(new SceneNode('FRAME')); f.name = 'Frame'; f._fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; currentPage.children.push(f); f.parent = currentPage; return f; },
    createComponent() { const c = seal(new ComponentNode()); c.name = 'Component'; currentPage.children.push(c); c.parent = currentPage; return c; },
    createText() { const t = seal(new TextNode()); t.name = 'Text'; currentPage.children.push(t); t.parent = currentPage; return t; },
    createRectangle() { const r = seal(new SceneNode('RECTANGLE')); r.name = 'Rectangle'; r._fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }]; currentPage.children.push(r); r.parent = currentPage; return r; },
    createEllipse() { const e = seal(new EllipseNode()); e.name = 'Ellipse'; currentPage.children.push(e); e.parent = currentPage; return e; },
    createVector() { const v = seal(new VectorNode()); v.name = 'Vector'; currentPage.children.push(v); v.parent = currentPage; return v; },
    createNodeFromSvg: svgToNode,
    createComponentFromNode(n) {
      n._checkLive();
      if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE' || n.instAncestor() || n.compAncestor()) fail('createComponentFromNode: node cannot be a component, an instance or inside one');
      const c = seal(new ComponentNode()); c.name = n.name; c._w = n._w; c._h = n._h; c._fills = deep(n._fills);
      if (n._layoutMode) { ['_layoutMode', '_pAxis', '_cAxis', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing'].forEach((k) => { c[k] = n[k]; }); }
      const p = n.parent; const idx = p.children.indexOf(n);
      (n.children || []).slice().forEach((k) => { k.parent = c; c.children.push(k); }); n.children = [];
      p.children.splice(idx, 1, c); c.parent = p; n.removed = true; byId.delete(n.id);
      return c;
    },
    combineAsVariants(nodes, parent) {
      if (!nodes.length) fail('combineAsVariants: empty list');
      if (!parent || !parent.children) fail('combineAsVariants: parent required');
      const seen = {}; let keys = null;
      nodes.forEach((n) => {
        if (n.type !== 'COMPONENT') fail('combineAsVariants: only components');
        if (n.parent && n.parent.type === 'COMPONENT_SET') fail('combineAsVariants: component already in a set');
        if (!/^[^=,]+=[^=,]+(, [^=,]+=[^=,]+)*$/.test(n.name)) fail('Variant name must be "Prop=Value, Prop=Value": ' + n.name);
        const ks = n.name.split(', ').map((kv) => kv.split('=')[0]).join('|');
        if (keys === null) keys = ks; else if (keys !== ks) fail('Variants have different property keys: ' + keys + ' vs ' + ks);
        if (seen[n.name]) fail('Duplicate variant ' + n.name); seen[n.name] = 1;
        if (Object.keys(n._defs).length) fail('Variant has its own component properties');
      });
      const s = seal(new ComponentSetNode()); s.name = 'Component set'; s._fills = [];
      parent.children.push(s); s.parent = parent;
      nodes.forEach((n) => { const k = n.parent.children; k.splice(k.indexOf(n), 1); s.children.push(n); n.parent = s; });
      return s;
    },
    createTextStyle() { return new TextStyle(); },
    createEffectStyle() { return new EffectStyle(); },
    viewport: { scrollAndZoomIntoView(n) { if (!Array.isArray(n)) fail('scrollAndZoomIntoView needs an array'); }, center: { x: 0, y: 0 }, zoom: 1 },
    showUI(html, o) { OUT.ui = { html: html, opts: o }; },
    ui: { postMessage(m) { OUT.messages.push(deep(m)); }, onmessage: null, resize() {}, close() {} },
    closePlugin() { OUT.closed = true; },
    notify(m) { OUT.messages.push({ type: 'notify', message: m }); },
    command: '',
    variables: {
      createVariableCollection(name) { return new VariableCollection(name); },
      createVariable(name, coll, type) { return new Variable(name, coll, type); },
      createVariableAlias(v) { needVar(v, null, 'createVariableAlias'); return alias(v); },
      getLocalVariableCollectionsAsync() { return Promise.resolve([...COLLS.values()]); },
      getLocalVariablesAsync(type) { return Promise.resolve([...VARS.values()].filter((v) => !type || v.resolvedType === type)); },
      getVariableByIdAsync(id) { return Promise.resolve(VARS.get(id) || null); },
      getVariableCollectionByIdAsync(id) { return Promise.resolve(COLLS.get(id) || null); },
      getVariableById() { fail('Use getVariableByIdAsync in dynamic-page mode'); },
      setBoundVariableForPaint(p, field, v) {
        if (field !== 'color') fail('setBoundVariableForPaint: field must be color'); if (p.type !== 'SOLID') fail('Only solid paints can bind colour');
        const out = deep(p);
        if (v === null) { delete out.boundVariables; return out; }
        needVar(v, 'COLOR', 'setBoundVariableForPaint'); out.boundVariables = { color: alias(v) };
        delete out.opacity; // like Figma: the bound paint comes back fully opaque
        const val = v.resolve(); out.color = { r: val.r, g: val.g, b: val.b }; return out;
      },
      setBoundVariableForEffect(e, field, v) {
        if (['color', 'radius', 'spread', 'offsetX', 'offsetY'].indexOf(field) < 0) fail('setBoundVariableForEffect field'); needVar(v, field === 'color' ? 'COLOR' : 'FLOAT', 'setBoundVariableForEffect');
        const out = deep(e); out.boundVariables = Object.assign({}, out.boundVariables || {}); out.boundVariables[field] = alias(v);
        // Like Figma: the returned copy has spread 0, whatever the effect had (forum.figma.com/t/setboundvariableforeffect-bug/59788;
        // the owner's file had Focus/Ring and Ring/Urgent at spread 0 after 1.8.3). Writing the copy back with a spread keeps that spread.
        if (out.type === 'DROP_SHADOW' || out.type === 'INNER_SHADOW') out.spread = 0;
        return out;
      },
    },
  };
  return { figma: figma, OUT: OUT, ROOT: ROOT, VARS: VARS, COLLS: COLLS, STYLES: STYLES, byId: byId, setMaxModes: (n) => { MAX_MODES = n; }, setMaxPages: (n) => { MAX_PAGES = n; }, get currentPage() { return currentPage; } };
}
module.exports = { makeFigma: makeFigma };
