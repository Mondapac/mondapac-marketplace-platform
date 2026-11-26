// The buyer site's /api/deliver-to/area: the outlines of the areas open for delivery, read from the
// API (`GET shipping/delivery-area-map`, anonymous public configuration) and handed to the modal
// when it opens, so the shape is not part of every page. No cookie or session is sent to the API.
import 'server-only';
import { apiGetWith } from '../storefront/api.ts';
import type { StorefrontApiConfig } from '../storefront/config.ts';
import { outlineFromApi, outlineToWire } from './area-outline.ts';

interface Incoming {
  get(name: string): string | null;
}

/** Public configuration that changes with a release: a browser may reuse it for a few minutes. */
const KEEP = { 'cache-control': 'public, max-age=300', vary: 'host' } as const;
const NO_STORE = { 'cache-control': 'no-store' } as const;

function log(fields: Record<string, unknown>) {
  console.warn(JSON.stringify(fields));
}

/** 404 while the API is off (the modal keeps its sample); 502 when the API fails or answers badly. */
export async function answerArea(
  config: StorefrontApiConfig | null,
  incoming: Incoming,
  now: () => number = Date.now,
): Promise<Response> {
  if (config === null) return Response.json({ code: 'off' }, { status: 404, headers: NO_STORE });
  const read = await apiGetWith<unknown>(config, incoming, 'shipping/delivery-area-map', now);
  if (read.kind !== 'ok') {
    log({ event: 'deliver-to.area.failed', status: read.kind === 'failed' ? read.status : null });
    return Response.json({ code: 'unavailable' }, { status: 502, headers: NO_STORE });
  }
  const outline = outlineFromApi(read.body);
  if (outline === undefined) {
    log({ event: 'deliver-to.area.malformed' });
    return Response.json({ code: 'unavailable' }, { status: 502, headers: NO_STORE });
  }
  return Response.json(outlineToWire(outline), { headers: KEEP });
}
