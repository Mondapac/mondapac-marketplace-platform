import { ICON_PATHS } from '../icons/icon-paths.tsx';
import { SAMPLE_SELLER_ART } from '../icons/seller-art.tsx';
import '../seller/store-images.css';
import type { StoreImage } from '../storefront/types.ts';

/**
 * A seller's logo tile; a seller without a profile logo gets the store icon on a mist tile. A
 * picture the store uploaded (`image`) fills the tile instead, with its pixels set so the page does
 * not jump; `alt` is the store's name where the tile stands alone and empty where the name is
 * written beside it.
 */
export function SellerLogo({
  logo,
  image,
  alt = '',
}: {
  readonly logo: string | undefined;
  readonly image?: StoreImage | undefined;
  readonly alt?: string;
}) {
  if (image !== undefined) {
    return (
      <span className="lg lg-img">
        <img src={image.src} width={image.width} height={image.height} alt={alt} decoding="async" />
      </span>
    );
  }
  const art = logo === undefined ? undefined : SAMPLE_SELLER_ART[logo];
  return (
    <span className="lg" aria-hidden="true">
      <svg className="lgv" viewBox="0 0 64 64">
        {art ?? (
          <>
            <rect width="64" height="64" rx="16" fill="var(--sf-mist)" />
            <g
              transform="translate(16 16) scale(1.33)"
              fill="none"
              stroke="var(--sf-teal)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {ICON_PATHS.store}
            </g>
          </>
        )}
      </svg>
    </span>
  );
}
