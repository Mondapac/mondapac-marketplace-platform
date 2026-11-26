import { ANTHROPIC_API_ROUTES } from './anthropic';
import { BEDROCK_ROUTES } from './bedrock';
import { IN_HOUSE_ROUTES } from './in-house';
import { RouteCatalogue, type RouteRow } from './route-catalogue';

/**
 * Why a checked-in row is not allowed, or null. Anthropic's own API is called on one host with no
 * region control, so its rows record no region until the adapter sends one and Hassan's check
 * records it as evidence (Hassan, G3 review 1). Test catalogues may give any region.
 */
export function checkedInRowProblem(row: RouteRow): string | null {
  if (row.route === 'anthropic-api' && row.region !== null) {
    return `${row.id}: an anthropic-api row records no region until the adapter pins one`;
  }
  return null;
}

/** The checked-in catalogue, one file per provider route (ADR-0052 decision 2). */
export function checkedInCatalogue(
  rows: readonly RouteRow[] = [...ANTHROPIC_API_ROUTES, ...BEDROCK_ROUTES, ...IN_HOUSE_ROUTES],
): RouteCatalogue {
  for (const row of rows) {
    const problem = checkedInRowProblem(row);
    if (problem !== null) throw new Error(`AI route catalogue: ${problem}`);
  }
  return new RouteCatalogue(rows);
}
