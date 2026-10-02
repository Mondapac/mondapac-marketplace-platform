#!/usr/bin/env python3
"""Build the MondaPac Design System Figma plugin.

Concatenates src/*.js in order and injects the token spec, icons and contrast checks
into code.js (next to manifest.json and ui.html). Run after changing tokens_spec.py, icons.json or any source file:

    python3 tokens_spec.py && python3 build.py && node test/run.js
"""
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE

spec = json.load(open(os.path.join(HERE, 'spec.json')))
icons = json.load(open(os.path.join(HERE, 'icons.json')))
contrast = json.load(open(os.path.join(HERE, 'contrast-report.json')))['checks']

parts = []
for path in sorted(glob.glob(os.path.join(HERE, 'src', '*.js'))):
    parts.append('// ==== %s ====\n' % os.path.basename(path) + open(path, encoding='utf-8').read())
code = '\n'.join(parts)
for key, value in (('__SPEC__', spec), ('__ICONS__', icons), ('__CONTRAST__', contrast)):
    assert code.count(key) == 1, key
    code = code.replace(key, json.dumps(value, ensure_ascii=False, separators=(',', ':')))

open(os.path.join(OUT, 'code.js'), 'w', encoding='utf-8').write(code)
manifest = {
    "name": "MondaPac Design System",
    "id": "mondapac-ds-generator",
    "api": "1.0.0",
    "main": "code.js",
    "ui": "ui.html",
    "editorType": ["figma"],
    "documentAccess": "dynamic-page",
    "networkAccess": {"allowedDomains": ["none"]},
}
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=2)
print('code.js %d KB' % (len(code.encode('utf-8')) // 1024))
