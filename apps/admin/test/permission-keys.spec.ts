import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every permission key the panel checks must be one the API declares. A key the API does not know
// is never in a session's permission list, so the control it guards is hidden from every admin,
// with no error anywhere (BUG-010: the Approve and Reject buttons of a seller request checked
// `seller-access.approve` instead of `identity.seller-access.approve`).
//
// The API's keys are read as text from each module's contracts/permissions.ts (the panel never
// imports API code): the `key:` of a definePermission call and the first argument of identity's
// `platform(…)` / `seller(…)` helpers, so a key that is only mentioned in a comment does not count.
// The panel's keys are every place it names a key it checks: `*_PERMISSION` constants and other
// upper-case constants whose value starts with a module's prefix, `.includes('…')`, and the values
// of `anyOf`, `allOf` and `requires` (nav, settings nav, work queues).

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = resolve(APP, '../api/src/modules');
const KEY = String.raw`[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+`;
const DECLARED = new RegExp(
  String.raw`(?:\bkey:\s*|\b(?:platform|seller)\(\s*)['"](${KEY})['"]`,
  'g',
);
const CHECKED = new RegExp(String.raw`(?:_PERMISSION\w*\s*=\s*|\.includes\()['"](${KEY})['"]`, 'g');
const CONSTANT = new RegExp(
  String.raw`\bconst (?![A-Z0-9_]*_KEYS?\b)[A-Z][A-Z0-9_]*\s*=\s*['"](${KEY})['"]`,
  'g',
);
const RULE = /\b(?:anyOf|allOf|requires):\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g;
const STRING = new RegExp(`['"](${KEY})['"]`, 'g');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
  });
}

function declaredKeys(): Set<string> {
  const keys = new Set<string>();
  for (const module of readdirSync(MODULES)) {
    const file = join(MODULES, module, 'contracts', 'permissions.ts');
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(DECLARED)) keys.add(match[1]!);
  }
  return keys;
}

function checkedKeys(prefixes: ReadonlySet<string>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (key: string, file: string) =>
    found.set(key, [...(found.get(key) ?? []), relative(APP, file)]);
  for (const file of [...sources(join(APP, 'src')), ...sources(join(APP, 'app'))]) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CHECKED)) add(match[1]!, file);
    for (const match of text.matchAll(RULE)) {
      for (const inner of match[1]!.matchAll(STRING)) add(inner[1]!, file);
    }
    // Other constants (CATEGORY_VIEW, GROUPS_MANAGE): a three-part value under a module's prefix.
    // `*_KEY` constants are step-up action keys, not permissions, and are left out.
    for (const match of text.matchAll(CONSTANT)) {
      const key = match[1]!;
      const parts = key.split('.');
      if (parts.length === 3 && prefixes.has(parts[0]!)) add(key, file);
    }
  }
  return found;
}

describe('admin panel permission keys', () => {
  const declared = declaredKeys();
  const checked = checkedKeys(new Set([...declared].map((key) => key.split('.')[0]!)));

  it('reads both sides', () => {
    expect(declared.has('identity.seller-access.approve')).toBe(true);
    expect(declared.has('catalog.product.view')).toBe(true);
    expect(declared.size).toBeGreaterThan(200);
    expect(checked.size).toBeGreaterThan(100);
    // The nav's anyOf lists and the work queues' requires are read too.
    expect(checked.get('security.centre.view')).toEqual(
      expect.arrayContaining(['src/work-queue/queues.ts']),
    );
  });

  it('checks only keys the API declares', () => {
    const unknown = [...checked]
      .filter(([key]) => !declared.has(key))
      .map(([key, files]) => `${key} (${[...new Set(files)].join(', ')})`);
    expect(unknown).toEqual([]);
  });
});
