// The buyer site's server (ADR-0037 decision 9), the same wrapper as the panels. `pnpm dev` and
// `pnpm start` both run this file, never `next dev` or the standalone `server.js`: it cleans
// every request before Next.js sees it and sets `x-mp-client-address` from the socket peer or,
// behind a trusted edge, from the one header the edge is configured to set. The API reads sign
// that address (src/storefront/api.ts). Node 24 strips the types of the workspace TypeScript.
import next from 'next';
import {
  createPanelServer,
  parseClientAddressSource,
  withEdgeOnlyHeaders,
} from '@mondapac/panel-server/wrapper';

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT ?? 3003);

// `next` loads .env.local itself, but this file needs CLIENT_ADDRESS_SOURCE before Next starts.
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// The CDN location headers of the first-visit area guess (src/delivery/geo-guess.ts) count only
// when the trusted edge sent them; from any other peer they are removed here.
const geoHeaders = ['EDGE_GEO_CITY_HEADER', 'EDGE_GEO_POSTCODE_HEADER', 'EDGE_GEO_COUNTRY_HEADER']
  .map((name) => process.env[name]?.trim().toLowerCase() ?? '')
  .filter((name) => name !== '');
const source = withEdgeOnlyHeaders(parseClientAddressSource(process.env), geoHeaders);
// `next dev` sets TURBOPACK for its server process; the programmatic API needs to be told.
if (dev) process.env.TURBOPACK = '1';
const app = next({ dir: import.meta.dirname, dev, port, hostname: dev ? 'localhost' : undefined });
await app.prepare();

const server = createPanelServer({
  source,
  handle: app.getRequestHandler(),
  handleUpgrade: dev ? app.getUpgradeHandler() : undefined,
});
server.listen(port, () => {
  console.log(
    JSON.stringify({ msg: 'storefront.listening', port, dev, clientAddressSource: source.mode }),
  );
});
