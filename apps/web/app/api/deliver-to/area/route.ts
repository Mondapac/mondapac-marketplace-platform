import { headers } from 'next/headers';
import { answerArea } from '../../../../src/delivery/area-server.ts';
import { storefrontApiConfig } from '../../../../src/storefront/config.ts';

export const dynamic = 'force-dynamic';

/**
 * The outlines of the areas open for delivery (ServiceArea, FE-098), for the Deliver to map. 404
 * while the API is off: the modal then keeps its sample outline.
 */
export async function GET() {
  return answerArea(storefrontApiConfig(), await headers());
}
