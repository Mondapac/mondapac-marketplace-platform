/**
 * The route catalogue (ADR-0052 decision 2; docs/design/domain/platform-ai.md section 6): one row
 * per model the platform may call, per hosting route. It is code: a row is added, changed or
 * removed only by PR, with Hassan's review, and his check of the route's contract is recorded in
 * the row itself (`dataTerms`). The router and the server checks read only the rows; the panel
 * (G4, ADR-0053) chooses among them and never types a model id or a price.
 */

/**
 * How a route is reached; each has one adapter in `platform/ai`. `in-house-http` is the in-house
 * model (Mondapac Intelligence, ADR-0052 decision 6) through the versioned HTTP contract
 * (`docs/design/domain/platform-ai-in-house-contract-v1.md`); it is last, so a family of the
 * in-house model never sorts before an external route.
 */
export const ROUTE_KINDS = ['anthropic-api', 'bedrock-mantle', 'in-house-http'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/**
 * The model's maker: `anthropic` for the external models, `mondapac` for the in-house model.
 * A `mondapac` row is never offered on the External models tab nor taken into a Market's
 * external list; only the in-house stages (G6) route to it.
 */
export const MODEL_PROVIDERS = ['anthropic', 'mondapac'] as const;
export type ModelProviderId = (typeof MODEL_PROVIDERS)[number];

/** Hassan's check of a route's contract (ADR-0052 decision 3); absent, the row is not usable. */
export interface DataTermsCheck {
  /** No retention of request or answer, provider logs and abuse-monitoring copies included. */
  readonly noRetention: true;
  readonly noTraining: true;
  /** The day of the check, `YYYY-MM-DD`. */
  readonly checkedOn: string;
  /** Where the evidence is: the contract, the provider setting, the PR that recorded it. */
  readonly reference: string;
  readonly reviewer: string;
}

export interface RouteRow {
  /** `<route>/<model>`, unique. */
  readonly id: string;
  /** The model's maker, the evaluation is bound to it (ADR-0019 decision 9). */
  readonly provider: ModelProviderId;
  readonly route: RouteKind;
  /**
   * The model, the same on every route (`claude-haiku-5-5`): an evaluation pass and a priority list
   * name it, and the router expands it to its routes (owner decision Q1).
   */
  readonly family: string;
  /** The exact model version id sent on this route. */
  readonly model: string;
  /** The processing region; null is never usable (ADR-0052 decision 3). */
  readonly region: string | null;
  /** Hassan's check of no retention and no training, or null while it is not done. */
  readonly dataTerms: DataTermsCheck | null;
  /** List price in US dollars per million tokens, from the provider's price page. */
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** The last day the model may be called, `YYYY-MM-DD`, or null when none is announced. */
  readonly retiresOn: string | null;
  /**
   * The in-house endpoint (ADR-0052 decision 6): the base `https://` address the HTTP contract is
   * served under, set only on an `in-house-http` row and changed only by PR. External routes have
   * fixed hosts in their adapter and carry none.
   */
  readonly endpoint?: string;
}

/** The price a row is counted at: pico US dollars per token (1e-12 USD). */
export interface ModelTokenPrice {
  readonly inputPicoUsd: number;
  readonly outputPicoUsd: number;
}

/** US dollars per million tokens is pico US dollars per token times one million. */
export function priceOf(row: RouteRow): ModelTokenPrice {
  return {
    inputPicoUsd: Math.round(row.inputUsdPerMTok * 1_000_000),
    outputPicoUsd: Math.round(row.outputUsdPerMTok * 1_000_000),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** At most 20 characters, so a Market's list of 3 fits one setting value (G4b, Mohammad 1). */
const FAMILY = /^[a-z0-9][a-z0-9.-]{0,19}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
/**
 * A Bedrock model id processed in the called region only: the in-region id, or Australia's
 * inference profile. A cross-region profile (`global.`, `apac.`, `us.` …) may process the data
 * outside the host's region, so it is refused (Hassan, G3 review 1).
 */
const BEDROCK_MODEL = /^(?:au\.)?anthropic\./;

/** Top-level names that never reach a public partner host (RFC 6761, RFC 6762, RFC 8375, RFC 7686). */
const SPECIAL_USE_TLDS = new Set([
  'localhost',
  'local',
  'internal',
  'test',
  'invalid',
  'example',
  'arpa',
  'onion',
  'lan',
  'home',
  'corp',
]);
/** DNS services that answer any embedded IP address, so a name of theirs can point anywhere. */
const WILDCARD_IP_SUFFIXES = [
  'nip.io',
  'sslip.io',
  'xip.io',
  'traefik.me',
  'localtest.me',
  'lvh.me',
];
const ENDPOINT_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ENDPOINT_PATH = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\/?$/;

/**
 * Why an in-house endpoint is not allowed, or null (Hassan, G6a review 2 and 3). The address is code,
 * so it is checked as strictly as a fixed host, and the text in the row must be exactly what is
 * called: `https://`, a lowercase ASCII DNS host name (no IP literal, no `xn--` label, no special-use
 * or wildcard-IP name), no user, port, query or fragment, a path of plain segments, and nothing a URL
 * parser would quietly rewrite (spaces, tabs, Unicode, `%` escapes, `..`, a default port).
 */
export function inHouseEndpointProblem(endpoint: string): string | null {
  if (endpoint.length > 200) return 'longer than 200 characters';
  if (!/^[\x21-\x7e]+$/.test(endpoint)) return 'has other than printable ASCII';
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  if (url.username !== '' || url.password !== '') return 'carries a user';
  if (url.port !== '') return 'carries a port';
  if (url.search !== '' || url.hash !== '' || endpoint.includes('?') || endpoint.includes('#')) {
    return 'carries a query or fragment';
  }
  const host = url.hostname;
  if (!ENDPOINT_HOST.test(host)) return 'the host is not a DNS name';
  // A default port (`:443`) is dropped by the parser, so it is looked for in the text.
  if (/^https:\/\/[^/]*:/.test(endpoint)) return 'carries a port';
  const labels = host.split('.');
  if (labels.some((label) => label.startsWith('xn--'))) return 'the host has an IDN label';
  if (SPECIAL_USE_TLDS.has(labels[labels.length - 1]!)) return 'the host is a special-use name';
  if (WILDCARD_IP_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return 'the host is a wildcard-IP name';
  }
  if (!ENDPOINT_PATH.test(url.pathname) || endpoint.includes('%')) {
    return 'the path has other than plain segments';
  }
  if (
    endpoint !== `${url.origin}${url.pathname}` &&
    endpoint !== `${url.origin}${url.pathname}`.replace(/\/$/, '')
  ) {
    return 'is not written in its canonical form';
  }
  return null;
}

/** The call address of a valid in-house endpoint, built from its parsed form (contract path `/v1/messages`). */
export function inHouseCallUrl(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname.replace(/\/$/, '')}/v1/messages`;
}

/** Why a row is invalid, or null. Checked once, when the catalogue is loaded. */
export function routeRowProblem(row: RouteRow): string | null {
  if (row.id !== `${row.route}/${row.model}`) return `${row.id}: the id is "<route>/<model>"`;
  if (!(ROUTE_KINDS as readonly string[]).includes(row.route)) return `${row.id}: unknown route`;
  if (!FAMILY.test(row.family)) return `${row.id}: the family is lowercase a-z 0-9 . -`;
  if (!MODEL.test(row.model)) return `${row.id}: invalid model id`;
  if (row.route === 'bedrock-mantle' && !BEDROCK_MODEL.test(row.model)) {
    return `${row.id}: a Bedrock model id is "anthropic." or "au.anthropic." (no cross-region profile)`;
  }
  if (row.region !== null && !REGION.test(row.region)) return `${row.id}: invalid region`;
  if (!(MODEL_PROVIDERS as readonly string[]).includes(row.provider)) {
    return `${row.id}: unknown provider`;
  }
  if ((row.route === 'in-house-http') !== (row.provider === 'mondapac')) {
    return `${row.id}: the in-house route serves the mondapac provider only, and only it`;
  }
  if (row.route === 'in-house-http') {
    if (row.endpoint === undefined) return `${row.id}: an in-house row names its endpoint`;
    const endpointProblem = inHouseEndpointProblem(row.endpoint);
    if (endpointProblem !== null) return `${row.id}: the endpoint ${endpointProblem}`;
  } else if (row.endpoint !== undefined) {
    return `${row.id}: only an in-house row names an endpoint`;
  }
  for (const price of [row.inputUsdPerMTok, row.outputUsdPerMTok]) {
    if (!Number.isFinite(price) || price <= 0 || price > 1000) {
      return `${row.id}: a price is above 0 and at most 1000 US dollars per million tokens`;
    }
  }
  if (row.retiresOn !== null && !DAY.test(row.retiresOn)) return `${row.id}: retiresOn is a day`;
  const terms = row.dataTerms;
  if (terms !== null) {
    if (terms.noRetention !== true || terms.noTraining !== true) {
      return `${row.id}: a recorded check is no retention and no training`;
    }
    if (!DAY.test(terms.checkedOn)) return `${row.id}: checkedOn is a day`;
    if (terms.reference.trim() === '' || terms.reviewer.trim() === '') {
      return `${row.id}: a check names its reference and reviewer`;
    }
  }
  return null;
}

/** The checked-in rows, read-only and validated; the router's only source of routes. */
export class RouteCatalogue {
  readonly #rows: readonly RouteRow[];

  constructor(rows: readonly RouteRow[]) {
    const ids = new Set<string>();
    const makers = new Map<string, string>();
    let inHouseOrigin: string | null = null;
    for (const row of rows) {
      const problem = routeRowProblem(row);
      if (problem !== null) throw new Error(`AI route catalogue: ${problem}`);
      if (ids.has(row.id)) throw new Error(`AI route catalogue: ${row.id} is listed twice`);
      ids.add(row.id);
      const maker = makers.get(row.family);
      if (maker !== undefined && maker !== row.provider) {
        throw new Error(`AI route catalogue: the family ${row.family} has two providers`);
      }
      makers.set(row.family, row.provider);
      if (row.route === 'in-house-http' && row.endpoint !== undefined) {
        // One key per Market goes to the in-house endpoint, so every in-house row has the same
        // origin: a second host (a staging server, say) never receives the key (Hassan, G6a 4).
        const origin = new URL(row.endpoint).origin;
        if (inHouseOrigin !== null && inHouseOrigin !== origin) {
          throw new Error(`AI route catalogue: ${row.id} has another in-house origin`);
        }
        inHouseOrigin = origin;
      }
    }
    this.#rows = Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }

  rows(): readonly RouteRow[] {
    return this.#rows;
  }

  /** Every model family of the catalogue, sorted. */
  families(): string[] {
    return [...new Set(this.#rows.map((row) => row.family))].sort();
  }

  /** The families of the external models, sorted: the External models tab's choices. */
  externalFamilies(): string[] {
    return [
      ...new Set(this.#rows.filter((row) => row.provider !== 'mondapac').map((row) => row.family)),
    ].sort();
  }

  /** Whether a family is the in-house model's (G6): never in an external list. */
  isInHouse(family: string): boolean {
    return this.#rows.some((row) => row.family === family && row.provider === 'mondapac');
  }

  /** Whether a model family is in the catalogue. */
  hasFamily(family: string): boolean {
    return this.#rows.some((row) => row.family === family);
  }

  /**
   * The family a model name means: a family, or the exact model id of one of its rows (the
   * real-model evaluation's `ASSISTANT_EVAL_FAMILY`). Null when the catalogue has neither.
   */
  familyOf(name: string): string | null {
    if (this.hasFamily(name)) return name;
    return this.#rows.find((row) => row.model === name)?.family ?? null;
  }

  /** The rows of a family, in route order: the provider's own API first, the fallback route next. */
  routesOf(family: string): RouteRow[] {
    return this.#rows
      .filter((row) => row.family === family)
      .sort((a, b) => ROUTE_KINDS.indexOf(a.route) - ROUTE_KINDS.indexOf(b.route));
  }
}

/** Nest token of the {@link RouteCatalogue}; tests bind one with verified rows. */
export const AI_ROUTE_CATALOGUE = Symbol('AI_ROUTE_CATALOGUE');
