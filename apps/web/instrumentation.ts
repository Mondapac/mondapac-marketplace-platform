// Fails the server at start-up, not on the first request, when its API configuration is malformed.
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const { storefrontApiConfig } = await import('./src/storefront/config.ts');
    const { sellerSignInUrls } = await import('./src/storefront/seller-sign-in.ts');
    sellerSignInUrls(storefrontApiConfig());
  }
}
