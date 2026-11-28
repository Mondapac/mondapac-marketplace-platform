import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every permission key the panel checks must be one the API declares. A key the API does not know
// is never in a session's permission list, so the control it guards is hidden from every admin,
// with no error anywhere (BUG-010: the Approve and Reject buttons of a seller request checked
// `seller-access.approve` instead of `identity.seller-access.approve`).
//
// The API's keys are read as text from each module's contracts/permissions.ts (the panel never
// imports API code). The panel's keys are the string values of `*_PERMISSION` constants and the
// literal arguments of `.includes('…')`, the two ways the panel names a key it checks.

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = resolve(APP, '../api/src/modules');
const KEY = String.raw`[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+`;
const DECLARED = new RegExp(`['"\`](${KEY})['"\`]`, 'g');
const CHECKED = new RegExp(`(?:_PERMISSION\\w*\\s*=\\s*|\\.includes\\()['"](${KEY})['"]`, 'g');

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
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(DECLARED)) keys.add(match[1]!);
  }
  return keys;
}

function checkedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of [...sources(join(APP, 'src')), ...sources(join(APP, 'app'))]) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CHECKED)) {
      const key = match[1]!;
      found.set(key, [...(found.get(key) ?? []), relative(APP, file)]);
    }
  }
  return found;
}

describe('admin panel permission keys', () => {
  const declared = declaredKeys();
  const checked = checkedKeys();

  it('reads both sides', () => {
    expect(declared.has('identity.seller-access.approve')).toBe(true);
    expect(checked.size).toBeGreaterThan(50);
  });

  it('checks only keys the API declares', () => {
    const unknown = [...checked]
      .filter(([key]) => !declared.has(key))
      .map(([key, files]) => `${key} (${[...new Set(files)].join(', ')})`);
    expect(unknown).toEqual([]);
  });
});
