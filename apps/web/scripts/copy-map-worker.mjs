// Copies Mapbox GL JS's CSP worker into public/vendor/ when server.mjs starts (ADR-0048). The
// map loads its worker from this site, so the Content-Security-Policy keeps `worker-src 'self'`
// and needs no `blob:`. The copy is generated (apps/web/.gitignore) and matches the installed
// mapbox-gl version.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const source = require.resolve('mapbox-gl/dist/mapbox-gl-csp-worker.js');
const target = join(import.meta.dirname, '..', 'public', 'vendor', 'mapbox-gl-csp-worker.js');
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
