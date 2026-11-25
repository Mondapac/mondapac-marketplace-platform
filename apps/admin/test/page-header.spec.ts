// @vitest-environment node
// Source checks for the one page header and the Help panel (spec: help-panel-build-spec-fa.md):
// every page uses PageHeader, there is no page-info icon or zone sentence, and every route of the
// shell has its Help text. A new page that breaks one of these fails here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bestRoute, resolveHelp, type HelpTextSource } from '@mondapac/ui';
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
const REDIRECT_ONLY = new Set(['/security']);

describe('page header', () => {
  it('puts no line of text under the page title (what a page is for lives in the Help panel)', () => {
    // A line right after the title row, a `subtitle` on a list heading, or a `subtitle` prop on
    // PageHeader brings the subtitle back. A warning is a Banner or the list's `notice`.
    const offenders = sources.filter((file) => {
      const text = source(file).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gmu, '');
      return (
        /<PageHeader\b[\s\S]*?\/>\s*<(p|div)\b[^>]*>\s*\{\s*\w+\(\s*['"`][^'"`]*(intro|subtitle|description|lede)/u.test(
          text,
        ) || /\bheading=\{\{[^}]*\bsubtitle\s*:/u.test(text)
      );
    });
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });

  it('gives PageHeader and the list heading no subtitle prop', () => {
    const kit = ['help/page-header.tsx', 'list/super-list.tsx'].map((name) =>
      source(join(root, '../../packages/ui/src', name)).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gmu, ''),
    );
    expect(kit.filter((text) => /\bsubtitle\b/u.test(text))).toEqual([]);
  });

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

  it('writes no "Times ... in <zone>" sentence on a page: the zone is in the Help panel and the account menu', () => {
    // Field help beside a form field may name the zone (the field's own time); nothing else does.
    const FIELD_HELP = new Set([
      'account-menu.zone',
      'content.slides.placement.zone',
      'content.pages.new.window-help',
      'content.pages.settings.window-help',
    ]);
    const offenders: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'string') {
        if (
          path.split('.')[0] !== 'help' &&
          !FIELD_HELP.has(path) &&
          /\b(Times|Dates)\b[^.]*\b(in|shown in)\b[^.]*\{zone\}/u.test(value)
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

  it('hard-codes no zone sentence in the source either', () => {
    const offenders = sources.filter((file) =>
      /\b(Times|Dates)\b[^.'"`\n]*\b(in|shown in)\b[^.'"`\n]*(\{zone\}|\$\{zone\})/u.test(
        source(file).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gmu, ''),
      ),
    );
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });

  it('has no hand-written h1 in the shared kit either (PageHeader, SettingsTitle and the route states are the ones)', () => {
    const kit = files(join(root, '../../packages/ui/src'), isSource).filter(
      (file) =>
        !file.endsWith('help/page-header.tsx') && !file.endsWith('settings/settings-title.tsx'),
    );
    const offenders = kit.filter((file) =>
      [...source(file).matchAll(/<h1\b[^>]*>/gu)].some((match) => !match[0].includes('sr-only')),
    );
    // Auth screens, the route error states and the no-access page own their own single h1.
    expect(offenders.map((file) => relative(join(root, '../..'), file)).sort()).toEqual([
      'packages/ui/src/auth/auth-layout.tsx',
      'packages/ui/src/settings/no-access.tsx',
      'packages/ui/src/shell/route-states.tsx',
    ]);
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

  // The Related links the page-level entry of help-texts.json gives a page that now has tabs
  // (own routes and tabs left out: the tab strip leads there). A tabbed page must keep them.
  const PAGE_RELATED: Record<string, string[]> = {
    '/security/alerts': ['/account/sessions'],
    '/review': ['/catalog/products', '/catalog/tags/suggestions'],
    '/catalog/categories': [
      '/catalog/categories/import',
      '/catalog/attributes',
      '/catalog/business-activities',
    ],
    '/catalog/attributes': ['/catalog/categories', '/catalog/variants'],
    '/catalog/variants': ['/catalog/attributes'],
    '/catalog/brands': ['/catalog/products'],
    '/invoices': ['/orders', '/settings/tax'],
  };
  const help = messages.help as unknown as {
    pages: Record<string, never>;
    tabbed: Record<string, never>;
  };
  const text: HelpTextSource = {
    page: (slug) => help.pages[slug],
    tabbed: (slug) => help.tabbed[slug],
  };

  it('keeps the page-level Related of every tabbed page that also has a page entry in help-texts', () => {
    const missing = Object.entries(PAGE_RELATED).flatMap(([route, hrefs]) => {
      const got = new Set(
        resolveHelp({ pathname: route, registry: HELP_REGISTRY, text, zone: 'UTC' })?.related?.map(
          (link) => link.href,
        ),
      );
      return hrefs.filter((href) => !got.has(href)).map((href) => `${route} -> ${href}`);
    });
    expect(missing).toEqual([]);
  });

  it("lists no link to a tabbed page's own routes or tabs, and no link twice", () => {
    const bad = HELP_REGISTRY.tabbed.flatMap((entry) => {
      const own = new Set([...entry.routes, ...entry.tabs.flatMap((tab) => tab.route ?? [])]);
      return entry.routes.flatMap((route) =>
        entry.tabs.flatMap((tab) => {
          const related =
            resolveHelp({
              pathname: route,
              registry: HELP_REGISTRY,
              text,
              zone: 'UTC',
              activeTab: tab.label,
            })?.related ?? [];
          const hrefs = related.map((link) => link.href);
          return [
            ...hrefs.filter((href) => own.has(href)).map((href) => `${route}: own ${href}`),
            ...hrefs
              .filter((href, i) => hrefs.indexOf(href) !== i)
              .map((href) => `${route}: twice ${href}`),
          ];
        }),
      );
    });
    expect(bad).toEqual([]);
  });
});
