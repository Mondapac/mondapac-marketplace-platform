// Fails the server at start-up, not on the first request, when its API configuration is malformed.
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const { cardSetup, storefrontApiConfig } = await import('./src/storefront/config.ts');
    const { sellerSignInUrls } = await import('./src/storefront/seller-sign-in.ts');
    sellerSignInUrls(storefrontApiConfig());
    // Deliver to lookup (MAPBOX_*): a malformed value stops the site here, not on every page.
    const { placesDeps } = await import('./src/delivery/places-server.ts');
    placesDeps();
    // Deliver to map (MAPBOX_MAP_*): a secret or malformed token stops the site here.
    const { mapConfig } = await import('./src/delivery/map-config.ts');
    mapConfig();
    // First-visit area guess (EDGE_GEO_*): a malformed header name stops the site here.
    const { geoGuessConfig } = await import('./src/delivery/geo-guess.ts');
    geoGuessConfig();
    // Stripe stays in test mode: a live key stops the site here, before any page is served.
    cardSetup();
  }
}
