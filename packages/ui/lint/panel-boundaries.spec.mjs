import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../../../scripts/check-panel-boundaries.mjs');
let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

/** Runs the check on a throwaway repo root holding one file; returns exit status and output. */
function check(file, text) {
  dir = mkdtempSync(path.join(tmpdir(), 'panel-boundaries-'));
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
  try {
    const out = execFileSync('node', [script, dir], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, out };
  } catch (error) {
    return { status: error.status, out: String(error.stderr) };
  }
}

describe('check-panel-boundaries', () => {
  it.each([
    ['apps/seller/src/a.ts', "import { x } from '@mondapac/admin';", 'another app'],
    ['apps/seller/src/a.ts', "import { x } from '@mondapac/api';", 'apps/api'],
    ['apps/seller/src/a.ts', "export { x } from '../../admin/src/y';", 'leaves its package'],
    [
      'apps/seller/src/a.ts',
      "import type { ActorContext } from '@mondapac/shared-kernel';",
      'server-side',
    ],
    [
      'apps/seller/src/a.ts',
      "import { X } from '@mondapac/shared-kernel/testing';",
      'main entry only',
    ],
    ['apps/seller/src/a.ts', "import * as k from '@mondapac/shared-kernel';", 'by name'],
    ['apps/seller/src/a.ts', 'await import(name);', 'computed'],
    [
      'packages/ui/src/a.tsx',
      "import { x } from '@mondapac/seller';",
      'packages/ui imports no app',
    ],
  ])('refuses %s: %s', (file, text, why) => {
    const result = check(file, text);
    expect(result.status).toBe(1);
    expect(result.out).toContain(why);
  });

  it.each([
    ['apps/seller/src/a.ts', "import { Money } from '@mondapac/shared-kernel';"],
    ['apps/seller/src/a.ts', "import { Shell } from '@mondapac/ui';"],
    ['apps/seller/src/a.ts', "import { y } from './y.ts';"],
    ['packages/ui/src/a.tsx', "import { useState } from 'react';"],
  ])('allows %s', (file, text) => {
    expect(check(file, text).status).toBe(0);
  });
});
