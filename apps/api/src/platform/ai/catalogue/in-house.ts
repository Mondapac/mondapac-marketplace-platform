import type { RouteRow } from './route-catalogue';

/**
 * The in-house model (Mondapac Intelligence, ADR-0052 decision 6) through the versioned HTTP
 * contract `mondapac-model/1` (`docs/design/domain/platform-ai-in-house-contract-v1.md`; AI
 * Gateway G6a). Empty until the partner team serves a model version: a row is added only by PR,
 * with its endpoint (`https://`, in the Market's region), the exact model version id, the price
 * the platform counts it at, and `dataTerms` null until Hassan approves the endpoint and logs his
 * check in ADR-0052. A `mondapac` row is never an external choice: only the in-house stages (G6)
 * route to it, and only once that version has a recorded evaluation pass.
 */
export const IN_HOUSE_ROUTES: readonly RouteRow[] = [];
