// @vitest-environment node
// This is a source check only; the layout evidence is the screenshots in frontend/orphaned-sellers.
// The responsive standard of the admin panel: a source check that no table can widen the page,
// and that the buttons and links of the sellers-without-an-owner page are 48px tall (min-h-12).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' || name === '.next' ? [] : sourceFiles(path);
    }
    return path.endsWith('.tsx') && !path.endsWith('.spec.tsx') ? [path] : [];
  });
}

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('admin tables', () => {
  it('sit inside a scroll container, so a wide table never widens the page', () => {
    const roots = [join(__dirname, '../src'), join(__dirname, '../app')];
    const offenders = roots.flatMap(sourceFiles).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('<table') && !text.includes('overflow-x-auto');
    });
    expect(offenders).toEqual([]);
  });
});

describe('sellers without an owner', () => {
  const files = [
    'app/(shell)/sellers/without-owner/page.tsx',
    'src/sellers/orphaned-list.tsx',
    'src/sellers/orphaned-table.tsx',
    'src/sellers/invite-owner-dialog.tsx',
  ];

  it('keeps the table in its own scroll box and uses no fixed pixel width', () => {
    const table = read('src/sellers/orphaned-table.tsx');
    expect(table).toContain('overflow-x-auto');
    expect(table).toContain('min-w-120');
    for (const file of files) {
      expect(read(file), file).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]|width:\s*\d+px/);
    }
  });

  it('gives every button and link a 48px touch target', () => {
    // The shared Button is 48px high (--mp-size-control); a text link needs min-h-12 itself.
    for (const file of files) {
      const text = read(file);
      for (const link of text.match(/<a\b[^>]*>/gs) ?? []) {
        expect(link, `${file}: ${link}`).toContain('min-h-12');
      }
    }
    // The header link on the sellers page.
    const header = read('app/(shell)/sellers/page.tsx');
    const entry = header.match(/<a\b[^>]*href="\/sellers\/without-owner"[^>]*>/s);
    expect(entry?.[0]).toContain('min-h-12');
    for (const file of ['src/sellers/orphaned-table.tsx', 'src/sellers/invite-owner-dialog.tsx']) {
      for (const button of read(file).match(/<Button\b[^>]*>/gs) ?? []) {
        expect(button, `${file}: ${button}`).toContain('min-h-12');
      }
    }
  });

  it('puts the dialog actions on shared Dialog, which stacks them on phones', () => {
    expect(read('src/sellers/invite-owner-dialog.tsx')).toContain('<Dialog');
    const dialog = readFileSync(
      join(__dirname, '../../../packages/ui/src/overlay/dialog.tsx'),
      'utf8',
    );
    expect(dialog).toContain('flex-col-reverse');
  });
});

describe('settings navigation', () => {
  const shell = read('src/server/settings-shell.tsx');

  it('shows the sub-navigation column from 1180px and the back link only below it', () => {
    expect(shell).toContain('min-[1180px]:grid-cols-[12.5rem_minmax(0,1fr)]');
    expect(shell).toMatch(/hidden[^"]*min-\[1180px\]:block/);
    expect(shell).toMatch(/min-\[1180px\]:hidden[^]*<BackLink href="\/settings"/);
  });

  it('lets the content column shrink, so a wide table never widens the page', () => {
    expect(shell).toContain('min-w-0');
  });

  it('keeps every hub and sub-navigation link tall enough to touch', () => {
    expect(read('../../packages/ui/src/settings/settings-hub.tsx')).toContain('min-h-12');
    expect(read('src/settings/settings-sub-nav.tsx')).toContain('min-h-10');
  });

  it('puts the hub cards on one column on phones and two from 640px, never three', () => {
    const hub = read('../../packages/ui/src/settings/settings-hub.tsx');
    expect(hub).toContain('grid-cols-1');
    expect(hub).toContain('sm:grid-cols-2');
    expect(hub).not.toContain('grid-cols-3');
  });
});
