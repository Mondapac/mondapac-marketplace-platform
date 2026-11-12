// The CSP build of Mapbox GL JS (ADR-0048) has the same API as the main entry, which carries the
// types. Its worker is set through `workerUrl`, which the published types leave out.
declare module 'mapbox-gl/dist/mapbox-gl-csp.js' {
  import type mapboxgl from 'mapbox-gl';

  const csp: typeof mapboxgl & { workerUrl: string };
  export default csp;
}
