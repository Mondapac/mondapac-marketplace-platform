import type { RouteRow } from './route-catalogue';

/**
 * Anthropic's models through Anthropic's own API (ADR-0052 decision 5: the first route). Prices
 * are the list prices of the provider's price page (US dollars per million tokens, prompts up to
 * the first price step). Changed only by PR with Hassan's review.
 *
 * `region` is null: this route's processing region has not been recorded against a Market's
 * residency value, so no row is usable in AU (`in-market-region`) until Hassan records one
 * (ADR-0052 decision 4). `dataTerms` is null until Hassan records the no-retention and
 * no-training check of the contract (ADR-0052 decision 3, verification log empty).
 */
export const ANTHROPIC_API_ROUTES: readonly RouteRow[] = [
  {
    id: 'anthropic-api/claude-haiku-5-5',
    provider: 'anthropic',
    route: 'anthropic-api',
    family: 'claude-haiku-5-5',
    model: 'claude-haiku-5-5',
    region: null,
    dataTerms: null,
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    retiresOn: null,
  },
  {
    id: 'anthropic-api/claude-haiku-4-5',
    provider: 'anthropic',
    route: 'anthropic-api',
    family: 'claude-haiku-4-5',
    model: 'claude-haiku-4-5',
    region: null,
    dataTerms: null,
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    retiresOn: null,
  },
  {
    id: 'anthropic-api/claude-sonnet-5-5',
    provider: 'anthropic',
    route: 'anthropic-api',
    family: 'claude-sonnet-5-5',
    model: 'claude-sonnet-5-5',
    region: null,
    dataTerms: null,
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    retiresOn: null,
  },
  {
    id: 'anthropic-api/claude-opus-5-5',
    provider: 'anthropic',
    route: 'anthropic-api',
    family: 'claude-opus-5-5',
    model: 'claude-opus-5-5',
    region: null,
    dataTerms: null,
    inputUsdPerMTok: 4,
    outputUsdPerMTok: 20,
    retiresOn: null,
  },
];
