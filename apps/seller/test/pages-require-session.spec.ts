import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every page of the signed-in shell checks the session itself. The (shell) layout only runs on a
// full page load; a client navigation renders the page alone, so a page that relied on the layout
// would render for a visitor whose session ended in another tab (Hassan, PR 1280 review).
//
// A page passes when it, or a file it imports through relative paths, calls requireSession(), or
// when it only sends the visitor elsewhere (redirect or permanentRedirect, no local imports), so
// the page it leads to does the check.

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(APP, 'app', '(shell)');
const IMPORT = /(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === 'page.tsx' ? [path] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this extension.
    }
  }
  return null;
}

function localImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT)]
    .map((match) => resolveImport(file, match[1] ?? ''))
    .filter((path): path is string => path !== null);
}

function reachesSessionCheck(page: string): boolean {
  const seen = new Set<string>();
  const queue = [page];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    // The definition itself does not count as a check.
    if (file.endsWith(join('src', 'server', 'session.ts'))) continue;
    if (/\brequireSession\s*\(/.test(readFileSync(file, 'utf8'))) return true;
    queue.push(...localImports(file));
  }
  return false;
}

function onlyRedirects(page: string): boolean {
  const source = readFileSync(page, 'utf8');
  return localImports(page).length === 0 && /\b(?:permanentR|r)edirect\s*\(/.test(source);
}

describe('pages of the signed-in shell', () => {
  const all = pages(SHELL);

  it('finds the pages', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it('each check the session themselves', () => {
    const unchecked = all
      .filter((page) => !reachesSessionCheck(page) && !onlyRedirects(page))
      .map((page) => relative(APP, page));
    expect(unchecked).toEqual([]);
  });
});
