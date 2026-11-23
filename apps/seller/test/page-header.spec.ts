// @vitest-environment node
// Source checks for the one page header and the Help panel (spec: help-panel-build-spec-fa.md):
// every page uses PageHeader, there is no page-info icon or zone sentence, and every route of the
// shell has its Help text. A new page that breaks one of these fails here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bestRoute } from '@mondapac/ui';
import messages from '../messages/en.json';
import { HELP_REGISTRY } from '../src/help/help-registry.ts';

const root = join(__dirname, '..');

function files(dir: string, test: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' || name === '.next' ? [] : files(path, test);
    }
    return test(path) ? [path] : [];
  });
}

const source = (path: string) => readFileSync(path, 'utf8');
const isSource = (path: string) => /\.tsx?$/u.test(path) && !/\.spec\.tsx?$/u.test(path);
const sources = [join(root, 'src'), join(root, 'app')].flatMap((dir) => files(dir, isSource));

/** Pages that only redirect: they show nothing, so they have no Help text. */
const REDIRECT_ONLY = new Set(['/security', '/offer-reviews']);

describe('page header', () => {
  it('has no hand-written h1 (a page uses PageHeader); only a screen-reader-only one is allowed', () => {
    const offenders = sources.filter((file) => {
      const text = source(file);
      return [...text.matchAll(/<h1\b[^>]*>/gu)].some((match) => !match[0].includes('sr-only'));
    });
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });

  it('has no page-info icon and no heading info or note', () => {
    const offenders = sources.filter((file) => {
      const text = source(file);
      return /\bPageInfo\b/u.test(text) || /\bheading\.(info|note)\b/u.test(text);
    });
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });

  it('writes no "Times are in <zone>" sentence on a page: the zone is in the Help panel and the account menu', () => {
    const offenders: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'string') {
        if (
          path.split('.')[0] !== 'help' &&
          // The account menu and the scheduling form's own field help keep their zone line.
          path !== 'account-menu.zone' &&
          path !== 'content.slides.placement.zone' &&
          /^(Times|Dates|Times and days)( are shown| are)? in \{zone\}\./u.test(value)
        ) {
          offenders.push(path);
        }
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          walk(child, path === '' ? key : `${path}.${key}`);
        }
      }
    };
    walk(messages, '');
    expect(offenders).toEqual([]);
  });
});

describe('help registry', () => {
  const shellPages = files(join(root, 'app/(shell)'), (path) => path.endsWith('/page.tsx')).map(
    (path) => {
      const route = `/${relative(join(root, 'app/(shell)'), dirname(path)).split('\\').join('/')}`;
      return route === '/.' ? '/' : route;
    },
  );
  const routes = [
    ...HELP_REGISTRY.pages.map((entry) => entry.route),
    ...HELP_REGISTRY.tabbed.flatMap((entry) => entry.routes),
  ];

  it('has a Help text for every page of the shell', () => {
    const missing = shellPages.filter(
      (route) => !REDIRECT_ONLY.has(route) && bestRoute(routes, route) !== route,
    );
    expect(missing).toEqual([]);
  });

  it('has the text of every entry in the message catalogue', () => {
    const help = messages.help as {
      pages: Record<string, { title: string; about: string }>;
      tabbed: Record<string, { page: string; about: string; tabs: { label: string }[] }>;
    };
    const missingPages = HELP_REGISTRY.pages.filter(
      (entry) => help.pages[entry.slug] === undefined,
    );
    const missingTabbed = HELP_REGISTRY.tabbed.filter(
      (entry) => help.tabbed[entry.slug] === undefined,
    );
    expect(missingPages.map((entry) => entry.slug)).toEqual([]);
    expect(missingTabbed.map((entry) => entry.slug)).toEqual([]);
  });

  it('names every tab of a tabbed page in the text, so the open tab can be found', () => {
    const help = messages.help as { tabbed: Record<string, { tabs: { label: string }[] }> };
    const wrong = HELP_REGISTRY.tabbed.flatMap((entry) => {
      const labels = new Set(help.tabbed[entry.slug]?.tabs.map((tab) => tab.label));
      return entry.tabs
        .filter((tab) => !labels.has(tab.label))
        .map((tab) => `${entry.slug}:${tab.label}`);
    });
    expect(wrong).toEqual([]);
  });
});
