import { ANTHROPIC_API_ROUTES } from './anthropic';
import { BEDROCK_ROUTES } from './bedrock';
import { RouteCatalogue } from './route-catalogue';

/** The checked-in catalogue, one file per provider route (ADR-0052 decision 2). */
export function checkedInCatalogue(): RouteCatalogue {
  return new RouteCatalogue([...ANTHROPIC_API_ROUTES, ...BEDROCK_ROUTES]);
}
