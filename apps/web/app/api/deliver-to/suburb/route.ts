import { headers } from 'next/headers';
import { answerSuburb, placesDeps } from '../../../../src/delivery/places-server.ts';

export const dynamic = 'force-dynamic';

/** The suburb at the modal's pin or the device location (Mapbox reverse geocoding). */
export async function GET(request: Request) {
  return answerSuburb(placesDeps(), await headers(), new URL(request.url));
}
