import { loadSellerSignUp } from '../../../src/storefront/source.ts';

/** The footer's "Seller sign in": seller accounts sign in on the seller panel's own host. */
export async function GET(): Promise<Response> {
  const { sellerSignInUrl } = await loadSellerSignUp();
  return new Response(null, { status: 307, headers: { location: sellerSignInUrl } });
}
