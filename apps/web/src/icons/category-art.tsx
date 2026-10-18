import type { ReactNode } from 'react';

// Coloured category illustrations of the approved storefront design (v29), on a 64 x 64 grid.
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
};
