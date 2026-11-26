import type { ReactNode } from 'react';
import type { CertificationBadge } from '../storefront/types.ts';

// Seal artwork per badge artwork key. The badge itself (type, label and artwork key) is built
// from certification's evaluateClaim and the type's registry entry; the storefront only draws it.
// The standard: every certificate type shows its own seal, chosen by the artwork key an admin
// picks for the type (halal -> halal seal, vegan -> vegan seal, a new type -> the key it names).
// A badge without a key (sample data) is drawn by its type code; a key without artwork, `text`
// included, falls back to a plain text badge.

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

/** The rosette every seal shares: ribbons and a 24-point star, with the type's mark inside. */
function Rosette({ children }: { readonly children: ReactNode }) {
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
      {children}
    </svg>
  );
}

/** The type's word in Latin letters, fitted to the star's width. */
function Latin({
  text,
  y = 68,
  size = 19,
}: {
  readonly text: string;
  readonly y?: number;
  readonly size?: number;
}) {
  return (
    <text
      x="50"
      y={y}
      textAnchor="middle"
      fontSize={size}
      fontWeight="800"
      fill="var(--sf-white)"
      fontFamily="Arial, Helvetica, sans-serif"
      textLength="64"
      lengthAdjust="spacingAndGlyphs"
    >
      {text}
    </text>
  );
}

/** A seal with the type's word in its own script above the Latin one (halal, kosher). */
function ScriptSeal({
  native,
  latin,
  font,
}: {
  readonly native: string;
  readonly latin: string;
  readonly font: string;
}) {
  return (
    <Rosette>
      <text
        x="50"
        y="45"
        textAnchor="middle"
        fontSize="27"
        fontWeight="700"
        fill="var(--sf-white)"
        fontFamily={font}
      >
        {native}
      </text>
      <Latin text={latin} />
    </Rosette>
  );
}

/** A leaf, centred on (50, cy). */
function Leaf({ cy, scale = 1 }: { readonly cy: number; readonly scale?: number }) {
  return (
    <g transform={`translate(50 ${cy}) scale(${scale})`}>
      <path d="M-13 9 C-15 -6 -4 -15 13 -14 C14 3 4 13 -11 11 Z" fill="var(--sf-white)" />
      <path
        d="M-13 11 L5 -6"
        stroke="var(--sf-certified)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </g>
  );
}

/** A seal with a leaf above the Latin word (vegan, organic). */
function LeafSeal({ latin }: { readonly latin: string }) {
  return (
    <Rosette>
      <Leaf cy={36} />
      <Latin text={latin} y={70} size={17} />
    </Rosette>
  );
}

// One drawing per artwork key of `config/certification-badge-artwork/keys.json` (the keys a type's
// registry entry may name); `text` has none and shows the type's name as a plain badge.
const SEAL_ART: Record<string, () => ReactNode> = {
  halal: () => (
    <ScriptSeal native={'حلال'} latin="HALAL" font="Noto Naskh Arabic, Amiri, Arial, sans-serif" />
  ),
  kosher: () => (
    <ScriptSeal native={'כשר'} latin="KOSHER" font="Noto Sans Hebrew, Arial, sans-serif" />
  ),
  vegan: () => <LeafSeal latin="VEGAN" />,
  organic: () => <LeafSeal latin="ORGANIC" />,
  leaf: () => (
    <Rosette>
      <Leaf cy={49} scale={1.7} />
    </Rosette>
  ),
  seal: () => (
    <Rosette>
      <path
        d="M33 49 L45 61 L68 36"
        stroke="var(--sf-white)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Rosette>
  ),
};

/** The artwork keys the storefront draws (every key but `text`). */
export const SEAL_ARTWORK_KEYS: readonly string[] = Object.keys(SEAL_ART);

/** The seal artwork of an artwork key (or a type code), or null when it has none. */
export function sealArt(key: string): ReactNode {
  return Object.hasOwn(SEAL_ART, key) ? SEAL_ART[key]!() : null;
}

/** The seal on a product tile; a badge without artwork shows its label as a badge. */
export function CertificationSeal({ badge }: { readonly badge: CertificationBadge }) {
  const art = sealArt(badge.artwork ?? badge.type);
  if (!art) return <span className="badge">{badge.label}</span>;
  return (
    <span className="seal" role="img" aria-label={badge.label}>
      {art}
    </span>
  );
}
