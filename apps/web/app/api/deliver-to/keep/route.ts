import { headers } from 'next/headers';
import { answerKeep, placesDeps } from '../../../../src/delivery/places-server.ts';

export const dynamic = 'force-dynamic';

/**
 * The street address a buyer saves to their address book, asked from Mapbox as a permanent
 * (storable) answer. Same gates as the search, with a tighter limit of its own.
 */
export async function GET(request: Request) {
  return answerKeep(placesDeps(), await headers(), new URL(request.url));
}
