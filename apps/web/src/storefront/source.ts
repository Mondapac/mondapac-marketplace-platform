import 'server-only';
import { SAMPLE_CONTENT } from './sample-home.ts';
import type { StorefrontContent } from './types.ts';

/**
 * The storefront's one read of the home content. Sample data for now; it calls the
 * pages-and-content and catalog APIs once PR #401 and storefront package 2 are on main.
 */
export async function loadStorefrontContent(): Promise<StorefrontContent> {
  return Promise.resolve(SAMPLE_CONTENT);
}
