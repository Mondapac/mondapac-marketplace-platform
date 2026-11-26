/**
 * The route catalogue (ADR-0052 decision 2; docs/design/domain/platform-ai.md section 6): one row
 * per model the platform may call, per hosting route. It is code: a row is added, changed or
 * removed only by PR, with Hassan's review, and his check of the route's contract is recorded in
 * the row itself (`dataTerms`). The router and the server checks read only the rows; the panel
 * (G4, ADR-0053) chooses among them and never types a model id or a price.
 */

/** How a route is reached; each has one adapter in `platform/ai`. */
export const ROUTE_KINDS = ['anthropic-api', 'bedrock-mantle'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

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
  readonly provider: 'anthropic';
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
    for (const row of rows) {
      const problem = routeRowProblem(row);
      if (problem !== null) throw new Error(`AI route catalogue: ${problem}`);
      if (ids.has(row.id)) throw new Error(`AI route catalogue: ${row.id} is listed twice`);
      ids.add(row.id);
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
