import type { ReactNode } from 'react';
import type { CertificationBadge } from '../storefront/types.ts';

// Seal artwork per certification type code. The badge itself (type and label) is built by
// certification from evaluateClaim; the storefront only draws it. A type without artwork falls
// back to a plain text badge.

const STAR = (() => {
  const points: string[] = [];
  const tips = 24;
  for (let k = 0; k < tips * 2; k++) {
    const r = k % 2 ? 42 : 47;
    const a = (Math.PI * k) / tips;
    points.push(`${(50 + r * Math.sin(a)).toFixed(1)},${(48 - r * Math.cos(a)).toFixed(1)}`);
  }
  return points.join(' ');
})();

function RosetteSeal({ native, latin }: { readonly native: string; readonly latin: string }) {
  return (
    <svg viewBox="0 0 100 112" aria-hidden="true">
      <polygon
        points="33,84 24,110 40,102 50,112 52,86"
        fill="var(--sf-certified)"
        stroke="var(--sf-white)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <polygon
        points="67,84 76,110 60,102 50,112 48,86"
        fill="var(--sf-certified)"
        stroke="var(--sf-white)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <polygon
        points={STAR}
        fill="var(--sf-certified)"
        stroke="var(--sf-white)"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <text
        x="50"
        y="45"
        textAnchor="middle"
        fontSize="27"
        fontWeight="700"
        fill="var(--sf-white)"
        fontFamily="Noto Naskh Arabic, Amiri, Arial, sans-serif"
      >
        {native}
      </text>
      <text
        x="50"
        y="68"
        textAnchor="middle"
        fontSize="19"
        fontWeight="800"
        fill="var(--sf-white)"
        fontFamily="Arial, Helvetica, sans-serif"
        textLength="64"
        lengthAdjust="spacingAndGlyphs"
      >
        {latin}
      </text>
    </svg>
  );
}

const SEAL_ART: Record<string, () => ReactNode> = {
  halal: () => <RosetteSeal native={'حلال'} latin="HALAL" />,
};

/** The seal artwork of a certification type, or null when the type has none. */
export function sealArt(type: string): ReactNode {
  return SEAL_ART[type]?.() ?? null;
}

/** The seal on a product tile; a type without artwork shows its label as a badge. */
export function CertificationSeal({ badge }: { readonly badge: CertificationBadge }) {
  const art = sealArt(badge.type);
  if (!art) return <span className="badge">{badge.label}</span>;
  return (
    <span className="seal" role="img" aria-label={badge.label}>
      {art}
    </span>
  );
}
