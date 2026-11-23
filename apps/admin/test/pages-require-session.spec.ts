import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// Every page of the signed-in shell checks the session itself. The (shell) layout only runs on a
// full page load; a client navigation renders the page alone, so a page that relied on the layout
// would render for a visitor whose session ended in another tab (Hassan, PR 1280 review).
//
// A page passes when it, or a file it imports through relative paths, calls requireSession()
// imported from src/server/session.ts; or when it only sends the visitor elsewhere (redirect or
// permanentRedirect, no local imports, nothing returned), so the page it leads to does the check.
// Comments are removed before any check, so a mention in a comment counts for nothing.

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /(?:import|export)\s([^'"]*?)\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
const SESSION_MODULE = `${sep}src${sep}server${sep}session.ts`;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === 'page.tsx' ? [path] : [];
  });
}

/** The source without comments (a URL inside a string may be cut too; that only fails safe). */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
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

function localImports(file: string): { readonly names: string; readonly path: string }[] {
  return [...code(file).matchAll(IMPORT)].flatMap((match) => {
    const path = resolveImport(file, match[2] ?? '');
    return path === null ? [] : [{ names: match[1] ?? '', path }];
  });
}

/** Calls requireSession() and imports that name from the panel's session module. */
function checksSession(file: string): boolean {
  if (!/\brequireSession\s*\(/.test(code(file))) return false;
  return localImports(file).some(
    ({ names, path }) => /\brequireSession\b/.test(names) && path.endsWith(SESSION_MODULE),
  );
}

export function reachesSessionCheck(page: string): boolean {
  const seen = new Set<string>();
  const queue = [page];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || file.endsWith(SESSION_MODULE)) continue;
    seen.add(file);
    if (checksSession(file)) return true;
    queue.push(...localImports(file).map(({ path }) => path));
  }
  return false;
}

export function onlyRedirects(page: string): boolean {
  const source = code(page);
  return (
    localImports(page).length === 0 &&
    /\b(?:permanentR|r)edirect\s*\(/.test(source) &&
    !/\breturn\b/.test(source)
  );
}

describe('pages of the signed-in shell', () => {
  const all = pages(join(APP, 'app', '(shell)'));

  it('finds the pages', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it('each check the session themselves', () => {
    const unchecked = all
      .filter((page) => !reachesSessionCheck(page) && !onlyRedirects(page))
      .map((page) => relative(APP, page).split(sep).join('/'));
    expect(unchecked).toEqual([]);
  });
});

describe('the session check finder', () => {
  const root = mkdtempSync(join(tmpdir(), 'pages-session-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, text: string) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    return full;
  };
  write('src/server/session.ts', 'export async function requireSession() {}\n');
  write(
    'src/helper.ts',
    "import { requireSession } from './server/session.ts';\nexport const load = () => requireSession();\n",
  );

  it('accepts a page that calls it, directly or through a helper', () => {
    const direct = write(
      'app/a/page.tsx',
      "import { requireSession } from '../../src/server/session.ts';\nexport default async function P() {\n  await requireSession();\n}\n",
    );
    const helper = write(
      'app/b/page.tsx',
      "import { load } from '../../src/helper.ts';\nexport default function P() {\n  return load();\n}\n",
    );
    expect(reachesSessionCheck(direct)).toBe(true);
    expect(reachesSessionCheck(helper)).toBe(true);
  });

  it('rejects a page that only mentions it in a comment', () => {
    const page = write(
      'app/c/page.tsx',
      '// requireSession() is done by the layout\n/* requireSession() */\nexport default function P() {\n  return null;\n}\n',
    );
    expect(reachesSessionCheck(page)).toBe(false);
    expect(onlyRedirects(page)).toBe(false);
  });

  it('rejects a call to another function of the same name', () => {
    const page = write(
      'app/d/page.tsx',
      'function requireSession() {}\nexport default function P() {\n  requireSession();\n  return null;\n}\n',
    );
    expect(reachesSessionCheck(page)).toBe(false);
  });

  it('accepts a page that only redirects, not one that redirects in one branch', () => {
    const redirectOnly = write(
      'app/e/page.tsx',
      "import { redirect } from 'next/navigation';\nexport default function P() {\n  redirect('/x');\n}\n",
    );
    const branch = write(
      'app/f/page.tsx',
      "import { redirect } from 'next/navigation';\nexport default function P({ a }: { a: boolean }) {\n  if (a) redirect('/x');\n  return null;\n}\n",
    );
    expect(onlyRedirects(redirectOnly)).toBe(true);
    expect(onlyRedirects(branch)).toBe(false);
  });
});
