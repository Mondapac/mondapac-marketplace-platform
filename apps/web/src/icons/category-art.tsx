import type { ReactNode } from 'react';

// Coloured category illustrations of the approved storefront design (v29), on a 64 x 64 grid, keyed by
// department (top-level category) slug. seafood, sweets-and-snacks, drinks, household and the
// `general` fallback were added in the same style (owner chose set A, 26 Nov 2026).
export const CATEGORY_ART: Record<string, ReactNode> = {
  meat: (
    <>
      <path
        d="M9 35c0-13 11-22 26-20 12 2 19 11 18 21-1 12-12 17-24 15C19 49 9 45 9 35z"
        fill="#D94A4A"
      />
      <path
        d="M9 35c0-13 11-22 26-20 12 2 19 11 18 21"
        fill="none"
        stroke="#F6C1B8"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M20 38c6-2 9-8 16-8M30 46c6-1 10-5 15-9"
        stroke="#F6C1B8"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="25" cy="33" r="5" fill="#FBE6D6" />
      <path d="M38 14c4-5 12-6 16-3-3 6-10 8-16 3z" fill="#4C9A52" />
    </>
  ),
  poultry: (
    <>
      <path
        d="M40 11c10 1 17 11 13 21-3 7-11 10-18 7-7-3-10-11-6-18 3-6 7-11 11-10z"
        fill="#E5A04A"
      />
      <path
        d="M40 11c10 1 17 11 13 21"
        fill="none"
        stroke="#C97F2C"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="M33 37L18 51" stroke="#F7EBDD" strokeWidth="5" strokeLinecap="round" />
      <circle cx="14" cy="52" r="4.5" fill="#F7EBDD" />
      <circle cx="19" cy="56" r="4.5" fill="#F7EBDD" />
      <path
        d="M44 18c3 0 6 3 6 6"
        stroke="#F6D49A"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </>
  ),
  bakery: (
    <>
      <path
        d="M8 31c0-10 11-16 24-16s24 6 24 16c0 3-1 5-4 5v17H12V36c-3 0-4-2-4-5z"
        fill="#D9923B"
      />
      <path d="M12 36v17h40V36" fill="#E8B160" />
      <path
        d="M22 22l5 8M32 20l5 9M42 22l5 8"
        stroke="#F6D49A"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </>
  ),
  pantry: (
    <>
      <rect x="19" y="10" width="26" height="8" rx="2.5" fill="#8A5A2B" />
      <path
        d="M17 20h30v6c3 3 4 7 4 12v14c0 3-2 5-5 5H18c-3 0-5-2-5-5V38c0-5 1-9 4-12z"
        fill="#D9ECE6"
      />
      <path d="M13 38h38v14c0 3-2 5-5 5H18c-3 0-5-2-5-5z" fill="#F2A93B" />
      <rect x="21" y="33" width="22" height="13" rx="3" fill="#fff" />
      <path d="M25 39h14M25 43h9" stroke="#0E5A57" strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
  dairy: (
    <>
      <rect x="11" y="14" width="18" height="6" rx="2" fill="#2F6FB8" />
      <path
        d="M12 20h16v5l3 5v22c0 2-1 3-3 3H12c-2 0-3-1-3-3V30l3-5z"
        fill="#F4F7FA"
        stroke="#C9D5E0"
        strokeWidth="1.5"
      />
      <rect x="9" y="34" width="22" height="9" fill="#2F6FB8" opacity=".15" />
      <path d="M33 52V36l22-8v24z" fill="#F4C542" />
      <path d="M33 36l22-8" stroke="#E0A91F" strokeWidth="2" />
      <circle cx="43" cy="42" r="2.6" fill="#E0A91F" />
      <circle cx="50" cy="38" r="1.8" fill="#E0A91F" />
    </>
  ),
  produce: (
    <>
      <path
        d="M32 21c-5-5-18-3-18 12 0 11 8 21 14 21 2 0 3-1 4-1s2 1 4 1c6 0 14-10 14-21 0-15-13-17-18-12z"
        fill="#D9363E"
      />
      <path
        d="M24 29c2-3 5-4 8-4"
        stroke="#F58C8C"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M32 21c0-5 1-9 5-12"
        stroke="#7A4B22"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M37 14c3-5 9-6 13-3-2 5-8 7-13 3z" fill="#4C9A52" />
    </>
  ),
  spices: (
    <>
      <rect x="18" y="12" width="22" height="9" rx="3" fill="#B4462B" />
      <path
        d="M20 21h18l1 5c2 2 3 4 3 7v16c0 3-2 5-5 5H21c-3 0-5-2-5-5V33c0-3 1-5 3-7z"
        fill="#F5E3BE"
      />
      <path d="M16 36h26v13c0 3-2 5-5 5H21c-3 0-5-2-5-5z" fill="#E0873A" />
      <rect x="22" y="38" width="14" height="9" rx="2" fill="#fff" />
      <path d="M42 44c6-2 12 1 12 8-5 0-9-2-12-8z" fill="#D9363E" />
      <path
        d="M54 52c1-2 2-3 4-3"
        stroke="#4C9A52"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </>
  ),
  meals: (
    <>
      <path
        d="M20 20c0-5 4-5 4-10M30 20c0-5 4-5 4-10M40 20c0-5 4-5 4-10"
        stroke="#9AA9A5"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M7 28h50c0 14-9 25-25 25S7 42 7 28z" fill="#0E5A57" />
      <path d="M11 28h42c-1 5-3 8-6 11H17c-3-3-5-6-6-11z" fill="#F2A93B" />
      <path
        d="M18 30c4-4 8 2 12-2s8 2 12-1"
        stroke="#fff"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="26" cy="33" r="2.2" fill="#D9363E" />
      <circle cx="38" cy="34" r="2.2" fill="#4C9A52" />
      <path d="M44 8l12 22" stroke="#8A5A2B" strokeWidth="2.6" strokeLinecap="round" />
    </>
  ),
  seafood: (
    <>
      <path d="M17 32L4 19c3 4 4 9 4 13s-1 9-4 13z" fill="#2F6FB8" />
      <path
        d="M13 32c7-10 18-14 29-12 7 1 13 6 16 12-3 6-9 11-16 12-11 2-22-2-29-12z"
        fill="#3E8FC7"
      />
      <path
        d="M19 36c9 5 21 6 31 1"
        stroke="#BFE0F2"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M28 21c2-6 8-9 13-8-1 5-5 8-10 9z" fill="#2F6FB8" />
      <path
        d="M41 24c-2 5-2 11 0 16"
        stroke="#2F6FB8"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="49" cy="29" r="3.6" fill="#fff" />
      <circle cx="49.5" cy="29" r="2" fill="#14211F" />
      <path
        d="M8 56c4-3 8 3 12 0s8 3 12 0 8 3 12 0 8 3 12 0"
        stroke="#7FC4D9"
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
      />
    </>
  ),
  'sweets-and-snacks': (
    <>
      <ellipse cx="32" cy="48" rx="26" ry="8" fill="#DCEAE6" />
      <ellipse cx="32" cy="47" rx="21" ry="5.5" fill="#F4F7FA" />
      <path d="M22 32l10-14 10 14-10 8z" fill="#E8B160" />
      <path
        d="M22 32l10-14 10 14"
        fill="none"
        stroke="#C97F2C"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M10 44l10-14 10 14-10 7z" fill="#D9923B" />
      <path d="M13 40h14M15 36h10" stroke="#F6D49A" strokeWidth="2" strokeLinecap="round" />
      <path d="M34 44l10-14 10 14-10 7z" fill="#D9923B" />
      <path d="M37 40h14M39 36h10" stroke="#F6D49A" strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="24" r="2.4" fill="#4C9A52" />
      <circle cx="20" cy="33" r="2.4" fill="#4C9A52" />
      <circle cx="44" cy="33" r="2.4" fill="#4C9A52" />
    </>
  ),
  drinks: (
    <>
      <path
        d="M18 12c0-4 4-4 4-8M27 12c0-4 4-4 4-8"
        stroke="#9AA9A5"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M14 16h22c0 9-4 12-4 19 0 6 4 10 4 15H14c0-5 4-9 4-15 0-7-4-10-4-19z"
        fill="#F4F7FA"
        stroke="#C9D5E0"
        strokeWidth="1.5"
      />
      <path d="M16 22h18c-1 5-3 8-3 13 0 6 3 9 3 13H16c0-4 3-7 3-13 0-5-2-8-3-13z" fill="#C9442E" />
      <path
        d="M20 26c0 4 2 6 2 9"
        stroke="#E98B6F"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
      <ellipse cx="25" cy="54" rx="17" ry="4.5" fill="#0E5A57" />
      <rect x="42" y="26" width="15" height="27" rx="3" fill="#F2A93B" />
      <path d="M42 33h15" stroke="#E0873A" strokeWidth="2" />
      <path
        d="M51 26l3-12h5"
        stroke="#4C9A52"
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="49.5" cy="43" r="4" fill="#fff" />
      <circle cx="49.5" cy="43" r="2.2" fill="#F4C542" />
    </>
  ),
  household: (
    <>
      <rect x="16" y="9" width="20" height="9" rx="3" fill="#0E5A57" />
      <path d="M36 11h9v5h-9z" fill="#0E5A57" />
      <path d="M22 18l-4 10" stroke="#0E5A57" strokeWidth="3" strokeLinecap="round" />
      <circle cx="50" cy="10" r="1.8" fill="#7FC4D9" />
      <circle cx="54" cy="15" r="1.6" fill="#7FC4D9" />
      <circle cx="51" cy="19" r="1.3" fill="#7FC4D9" />
      <rect x="21" y="18" width="10" height="6" fill="#9AA9A5" />
      <path d="M18 24h16l4 7v20c0 3-2 5-5 5H19c-3 0-5-2-5-5V31z" fill="#8CC3E3" />
      <rect x="18" y="34" width="16" height="12" rx="2.5" fill="#fff" />
      <path d="M21 39h10M21 43h6" stroke="#0E5A57" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="41" y="44" width="17" height="12" rx="2.5" fill="#F4C542" />
      <path d="M41 47h17" stroke="#4C9A52" strokeWidth="4" />
      <circle cx="47" cy="52" r="1.2" fill="#E0A91F" />
      <circle cx="53" cy="51" r="1.2" fill="#E0A91F" />
    </>
  ),
  general: (
    <>
      <path d="M12 22h40l-3 32c0 2-2 3-4 3H19c-2 0-4-1-4-3z" fill="#0E5A57" />
      <path d="M12 22h40l-1 7H13z" fill="#237A72" />
      <path
        d="M23 26V18a9 9 0 0 1 18 0v8"
        stroke="#F2A93B"
        strokeWidth="3.4"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="23" cy="27" r="2.4" fill="#F2A93B" />
      <circle cx="41" cy="27" r="2.4" fill="#F2A93B" />
      <path
        d="M26 41l5 5 9-10"
        stroke="#fff"
        strokeWidth="3.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
};
