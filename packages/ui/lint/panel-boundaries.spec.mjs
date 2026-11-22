import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../../../scripts/check-panel-boundaries.mjs');
let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

/** Runs the check on a throwaway repo root holding the files; returns exit status and output. */
function checkFiles(files) {
  dir = mkdtempSync(path.join(tmpdir(), 'panel-boundaries-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  try {
    const out = execFileSync('node', [script, dir], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, out };
  } catch (error) {
    return { status: error.status, out: String(error.stderr) };
  }
}

/** Runs the check on a throwaway repo root holding one file. */
const check = (file, text) => checkFiles({ [file]: text });

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

  describe('server files and client modules', () => {
    const card = [
      "'use client';",
      'export const cardPath = (id: string): string => `x/${id}`;',
      "export const CARD_PERMISSION = 'x.card.edit';",
      'export interface CardRead { readonly on: boolean }',
      'export function Card() { return null; }',
    ].join('\n');
    const withCard = (file, text) => checkFiles({ 'apps/admin/src/card.tsx': card, [file]: text });

    it.each([
      // The admin seller page crash: calling a client module's helper from a server component.
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "import { cardPath } from '../../../src/card.tsx';",
        'cardPath',
      ],
      // A permission constant from a client module is a reference on the server, not its string.
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "import { CARD_PERMISSION } from '../../../src/card.tsx';",
        'CARD_PERMISSION',
      ],
      ['apps/admin/src/server/load.ts', "import { cardPath } from '../card.tsx';", 'cardPath'],
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "import * as c from '../../../src/card.tsx';",
        '* as c',
      ],
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "export { cardPath } from '../../../src/card.tsx';",
        'cardPath',
      ],
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "import { cardPath } from '../../../src/card.js';",
        'cardPath',
      ],
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "import { cardPath } from '../../../src/card';",
        'cardPath',
      ],
    ])('refuses %s: %s', (file, text, name) => {
      const result = withCard(file, text);
      expect(result.status).toBe(1);
      expect(result.out).toContain(`server file takes '${name}' from a 'use client' module`);
    });

    it.each([
      ['apps/admin/app/(shell)/x/page.tsx', "import { Card } from '../../../src/card.tsx';"],
      ['apps/admin/app/(shell)/x/page.tsx', "import Card from '../../../src/card.tsx';"],
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "export type { CardRead } from '../../../src/card.tsx';",
      ],
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "import type { CardRead } from '../../../src/card.tsx';",
      ],
      [
        'apps/admin/app/(shell)/x/page.tsx',
        "import { Card, type CardRead } from '../../../src/card.tsx';",
      ],
      // A client module may take anything from another client module.
      [
        'apps/admin/app/(shell)/x/view.tsx',
        "'use client';\nimport { cardPath } from '../../../src/card.tsx';",
      ],
      // Tests and files outside app/ and src/server/ are not server components.
      [
        'apps/admin/app/(shell)/x/page.spec.tsx',
        "import { cardPath } from '../../../src/card.tsx';",
      ],
      ['apps/admin/src/other.ts', "import { cardPath } from './card.tsx';"],
    ])('allows %s: %s', (file, text) => {
      expect(withCard(file, text).status).toBe(0);
    });
  });
});
