import type { RouteRow } from './route-catalogue';

/**
 * The same Anthropic models through Amazon Bedrock in Sydney (`ap-southeast-2`), the fallback route
 * (ADR-0052 decision 5, owner decision Q1): same model, so the evaluation and the prompt stay
 * valid. Reached through Bedrock's Messages API endpoint, model ids with the `anthropic.` prefix.
 *
 * Prices are counted at the first-party list price until Kazem records the Bedrock price for the
 * region (Bedrock prices separately); the estimate is taken at the most expensive row of the route
 * plan, so a lower real price never voids a cap. `dataTerms` is null until Hassan records the
 * check of the AWS terms for the account (ADR-0052 decision 3); until then no row is usable.
 */
export const BEDROCK_ROUTES: readonly RouteRow[] = [
  {
    id: 'bedrock-mantle/anthropic.claude-haiku-5-5',
    provider: 'anthropic',
    route: 'bedrock-mantle',
    family: 'claude-haiku-5-5',
    model: 'anthropic.claude-haiku-5-5',
    region: 'ap-southeast-2',
    dataTerms: null,
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    retiresOn: null,
  },
  {
    id: 'bedrock-mantle/anthropic.claude-sonnet-5-5',
    provider: 'anthropic',
    route: 'bedrock-mantle',
    family: 'claude-sonnet-5-5',
    model: 'anthropic.claude-sonnet-5-5',
    region: 'ap-southeast-2',
    dataTerms: null,
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    retiresOn: null,
  },
];
