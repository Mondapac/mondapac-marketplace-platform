import type { HelpContent, HelpLink } from './help-panel.tsx';

/** A page with one text block, keyed by the route pattern its panel serves (`/sellers/[sellerId]`). */
export interface HelpPageEntry {
  readonly route: string;
  readonly slug: string;
}

/** A page with section tabs: one About text, and a text per tab. */
export interface HelpTabbedEntry {
  readonly slug: string;
  /** Route patterns that show this page (a tab with its own route, or the page itself). */
  readonly routes: readonly string[];
  /** In order. A tab with a `route` is the open one when the path matches it. */
  readonly tabs: readonly { readonly label: string; readonly route?: string }[];
}

export interface HelpRegistry {
  readonly pages: readonly HelpPageEntry[];
  readonly tabbed: readonly HelpTabbedEntry[];
}

/** The text of a plain page, from the message catalogue. */
export interface HelpPageText {
  readonly title: string;
  readonly about: string;
  readonly good: readonly string[];
  readonly related: readonly HelpLink[];
}

/** The text of a tabbed page, from the message catalogue. */
export interface HelpTabbedText {
  readonly page: string;
  readonly about: string;
  readonly good: readonly string[];
  /** The page's own Related links, shown on every tab, before the open tab's. */
  readonly related?: readonly HelpLink[];
  readonly tabs: readonly {
    readonly label: string;
    readonly text: string;
    readonly points: readonly string[];
    readonly related: readonly HelpLink[];
  }[];
}

export interface HelpTextSource {
  readonly page: (slug: string) => HelpPageText | undefined;
  readonly tabbed: (slug: string) => HelpTabbedText | undefined;
}

function segments(route: string): string[] {
  return route.split('/').filter((part) => part !== '');
}

const isParam = (part: string) => part.startsWith('[') && part.endsWith(']');

/**
 * How well a route pattern fits a path: -1 when it does not, otherwise the number of static
 * segments it matches, so `/sellers/needs-a-look` beats `/sellers/[sellerId]` for that path.
 */
export function routeScore(pattern: string, pathname: string): number {
  const want = segments(pattern);
  const have = segments(pathname);
  if (want.length !== have.length) return -1;
  let score = 0;
  for (const [index, part] of want.entries()) {
    if (isParam(part)) continue;
    if (part !== have[index]) return -1;
    score += 1;
  }
  return score;
}

/** The route pattern in `routes` that fits the path best, or undefined. Ties go to the first. */
export function bestRoute(routes: readonly string[], pathname: string): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const route of routes) {
    const score = routeScore(route, pathname);
    if (score > bestScore) {
      best = route;
      bestScore = score;
    }
  }
  return best;
}

function fill(line: string, zone: string): string {
  return line.replaceAll('{zone}', zone);
}

export interface ResolveHelpInput {
  readonly pathname: string;
  readonly registry: HelpRegistry;
  readonly text: HelpTextSource;
  /** The user's time zone, put into `{zone}` in the page's lines. */
  readonly zone: string;
  /** The open tab's label, for a tabbed page whose tabs have no route of their own. */
  readonly activeTab?: string | undefined;
}

/**
 * The Help panel's content for a path: the best-fitting page or tabbed page of the registry, with
 * the open tab's own part when the page has tabs. Null when no entry fits, or when its text is
 * missing from the catalogue (the Help button is then not shown).
 */
export function resolveHelp({
  pathname,
  registry,
  text,
  zone,
  activeTab,
}: ResolveHelpInput): HelpContent | null {
  const candidates: { readonly route: string; readonly pick: () => HelpContent | null }[] = [];
  for (const entry of registry.pages) {
    candidates.push({
      route: entry.route,
      pick: () => {
        const body = text.page(entry.slug);
        if (body === undefined) return null;
        return {
          page: body.title,
          about: body.about,
          goodToKnow: body.good.map((line) => fill(line, zone)),
          related: body.related,
        };
      },
    });
  }
  for (const entry of registry.tabbed) {
    for (const route of entry.routes) {
      candidates.push({
        route,
        pick: () => {
          const body = text.tabbed(entry.slug);
          if (body === undefined) return null;
          const fromRoute = entry.tabs.find(
            (tab) => tab.route !== undefined && routeScore(tab.route, pathname) >= 0,
          );
          const label = fromRoute?.label ?? activeTab;
          const open = body.tabs.find((tab) => tab.label === label);
          const tabRoutes = new Set(
            entry.tabs.flatMap((tab) => (tab.route === undefined ? [] : [tab.route])),
          );
          // The page's Related and the open tab's, once each, and never a link to one of the page's
          // own routes or tabs (the tab strip is how the user gets there).
          const own = new Set([...entry.routes, ...tabRoutes]);
          const seen = new Set<string>();
          const related = [...(body.related ?? []), ...(open?.related ?? [])].filter((link) => {
            if (own.has(link.href) || seen.has(link.href)) return false;
            seen.add(link.href);
            return true;
          });
          return {
            page: body.page,
            about: body.about,
            ...(open === undefined
              ? {}
              : {
                  tab: {
                    name: open.label,
                    text: open.text,
                    points: open.points.map((line) => fill(line, zone)),
                  },
                }),
            goodToKnow: body.good.map((line) => fill(line, zone)),
            related,
          };
        },
      });
    }
  }
  const route = bestRoute(
    candidates.map((candidate) => candidate.route),
    pathname,
  );
  if (route === undefined) return null;
  return candidates.find((candidate) => candidate.route === route)?.pick() ?? null;
}
