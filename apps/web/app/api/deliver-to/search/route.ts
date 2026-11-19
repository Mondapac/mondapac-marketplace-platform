import { headers } from 'next/headers';
import { answerSearch, placesDeps } from '../../../../src/delivery/places-server.ts';

export const dynamic = 'force-dynamic';

/**
 * The Deliver to modal's address search (Mapbox, server-side token, rate limited per client
 * address). 404 while the lookup is off: the modal then uses its sample places.
 */
export async function GET(request: Request) {
  return answerSearch(placesDeps(), await headers(), new URL(request.url));
}
