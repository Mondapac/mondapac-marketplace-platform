import { ICON_PATHS } from '../icons/icon-paths.tsx';
import { SAMPLE_SELLER_ART } from '../icons/seller-art.tsx';

/** A seller's logo tile; a seller without a profile logo gets the store icon on a mist tile. */
export function SellerLogo({ logo }: { readonly logo: string | undefined }) {
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
