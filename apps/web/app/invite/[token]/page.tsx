import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { InviteBanner } from '../../../src/invite/invite-ui.tsx';
import { SellerPage } from '../../../src/seller/seller-page.tsx';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import { SELLER_RATINGS_SHOWN } from '../../../src/storefront/features.ts';
import { loadInvitedStoreSlug, loadSeller } from '../../../src/storefront/source.ts';

// A store's invite link (customers management phase 4a): the store page with an invite banner on
// top. A link that does not work leads to the home page with a note and says nothing about the
// store. The page is never indexed and sends no referrer: the address is a credential.

interface Props {
  readonly params: Promise<{ token: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const base = await pageMetadata({
    description: await seoDescription('home'),
    path: '/',
    noindex: true,
  });
  // No canonical or og:url: they would print the token.
  return { ...base, alternates: undefined, openGraph: undefined, referrer: 'no-referrer' };
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const slug = await loadInvitedStoreSlug(token);
  const shop = slug === undefined ? undefined : await loadSeller(slug);
  if (shop === undefined) redirect('/?invite=invalid');
  return (
    <>
      <InviteBanner token={token} storeName={shop.name} />
      <SellerPage shop={shop} ratingsShown={SELLER_RATINGS_SHOWN} />
    </>
  );
}
