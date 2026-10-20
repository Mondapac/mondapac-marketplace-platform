import 'server-only';
import { SAMPLE_DATA } from '../storefront/source.ts';

/**
 * Whether search engines may index the buyer site. `STOREFRONT_INDEXING=on` lets them in; a
 * missing or any other value keeps them out. Read at request time, never at build.
 *
 * The env is the first step: the switch moves to a per-Market setting (ADR-0026) when Market
 * settings reach the storefront.
 */
export const STOREFRONT_INDEXING_ENV = 'STOREFRONT_INDEXING';

/** The response header that keeps every page and file out of the index while indexing is off. */
export const NOINDEX_HEADER = { name: 'X-Robots-Tag', value: 'noindex, nofollow' } as const;

/** On only when the env says `on` and the storefront no longer runs on sample data. */
export function indexingOn(): boolean {
  return process.env[STOREFRONT_INDEXING_ENV] === 'on' && !SAMPLE_DATA;
}
