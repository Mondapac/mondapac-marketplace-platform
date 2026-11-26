import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

describe('cart stepper count', () => {
  it('stays centred in the drawer line, where `.dn .num` aligns numbers to the end', () => {
    expect(css).toMatch(/\.dn \.qs output \{\s*text-align: center;/);
  });
});
