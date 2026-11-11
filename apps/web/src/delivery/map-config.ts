// The Deliver to modal's real map (ADR-0048): Mapbox GL JS in the buyer's browser, with a public
// token of its own. The address search keeps its server-only token (MAPBOX_SEARCH_TOKEN); this
// one is sent to every browser that opens the modal, so it must be a public (pk.) token with only
// the styles and tiles scopes, restricted by URL to the site's hosts in the Mapbox account.

type Env = Readonly<Record<string, string | undefined>>;

export interface MapConfig {
  /** Public Mapbox token, restricted by URL. */
  readonly token: string;
  /** Mapbox style URL (mapbox://styles/<owner>/<style>). */
  readonly style: string;
}

export const DEFAULT_MAP_STYLE = 'mapbox://styles/mapbox/streets-v12';
const PUBLIC_TOKEN = /^pk\.[A-Za-z0-9._-]{20,400}$/u;
const STYLE = /^mapbox:\/\/styles\/[a-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/u;

/**
 * MAPBOX_MAP_TOKEN and MAPBOX_MAP_STYLE. No token: null (the modal keeps its drawn stub map). A
 * secret (sk.), malformed or search token, or a style without a token, throws so start-up fails.
 */
export function parseMapConfig(env: Env): MapConfig | null {
  const token = env['MAPBOX_MAP_TOKEN']?.trim() ?? '';
  const style = env['MAPBOX_MAP_STYLE']?.trim() ?? '';
  if (token === '') {
    if (style !== '') throw new Error('MAPBOX_MAP_STYLE needs MAPBOX_MAP_TOKEN');
    return null;
  }
  if (token.startsWith('sk.')) {
    throw new Error('MAPBOX_MAP_TOKEN is sent to browsers: use a public (pk.) token, never sk.');
  }
  if (!PUBLIC_TOKEN.test(token)) throw new Error('MAPBOX_MAP_TOKEN is not a public Mapbox token');
  if (token === env['MAPBOX_SEARCH_TOKEN']?.trim()) {
    throw new Error('MAPBOX_MAP_TOKEN must be its own token, not MAPBOX_SEARCH_TOKEN');
  }
  if (style !== '' && !STYLE.test(style)) {
    throw new Error('MAPBOX_MAP_STYLE must be mapbox://styles/<owner>/<style>');
  }
  return { token, style: style || DEFAULT_MAP_STYLE };
}

let cached: { readonly config: MapConfig | null } | undefined;

/** This process's map configuration, read once; throws when it is malformed. */
export function mapConfig(): MapConfig | null {
  cached ??= { config: parseMapConfig(process.env) };
  return cached.config;
}

/**
 * Whether the map is configured, for the policy: a malformed configuration (start-up already
 * refused it) reads as off, so the Content-Security-Policy stays strict.
 */
export function mapIsOn(): boolean {
  try {
    return mapConfig() !== null;
  } catch {
    return false;
  }
}
