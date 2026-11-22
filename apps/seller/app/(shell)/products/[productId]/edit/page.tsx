import { permanentRedirect } from 'next/navigation';

/** The edit page is the product page now; old links and bookmarks land there. */
export default async function EditProductPage({
  params,
}: {
  readonly params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  permanentRedirect(`/products/${encodeURIComponent(productId)}`);
}
