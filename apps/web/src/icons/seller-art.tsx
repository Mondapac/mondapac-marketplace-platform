import type { ReactNode } from 'react';

// Sample seller logos of the approved storefront design (v29), on a 64 x 64 grid. Real sellers
// upload their own logo; these stand in until media is served.
export const SAMPLE_SELLER_ART: Record<string, ReactNode> = {
  KH: (
    <>
      <rect width="64" height="64" rx="16" fill="#8E2B2B" />
      <path d="M14 40l22-22c3-3 8-3 11 0l3 3c2 2 2 5 0 7L28 50c-3 2-6 2-8 0l-6-4z" fill="#fff" />
      <circle cx="21" cy="42" r="2.6" fill="#8E2B2B" />
      <path d="M40 20l8 8" stroke="#8E2B2B" strokeWidth="2.4" />
      <path
        d="M44 46c4 0 8-2 10-6"
        stroke="#F2B8A8"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </>
  ),
  PB: (
    <>
      <rect width="64" height="64" rx="16" fill="#E3A12F" />
      <path d="M32 50V24" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M32 22c-5-1-7-5-6-9 5 0 8 3 6 9zM32 22c5-1 7-5 6-9-5 0-8 3-6 9zM32 32c-6 0-9-4-9-8 6 0 9 3 9 8zM32 32c6 0 9-4 9-8-6 0-9 3-9 8zM32 42c-6 0-9-4-9-8 6 0 9 3 9 8zM32 42c6 0 9-4 9-8-6 0-9 3-9 8z"
        fill="#fff"
      />
    </>
  ),
  SP: (
    <>
      <rect width="64" height="64" rx="16" fill="#14786F" />
      <rect x="22" y="13" width="20" height="7" rx="2" fill="#F2A93B" />
      <path
        d="M20 22h24v4c3 2 4 5 4 9v13c0 2-2 4-4 4H20c-2 0-4-2-4-4V35c0-4 1-7 4-9z"
        fill="#fff"
      />
      <rect x="22" y="33" width="20" height="11" rx="3" fill="#14786F" />
      <path d="M26 38h12M26 41h7" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  IS: (
    <>
      <rect width="64" height="64" rx="16" fill="#C65A2E" />
      <path d="M32 12l5 15 15 0-12 9 5 15-13-9-13 9 5-15-12-9 15 0z" fill="#fff" opacity=".95" />
      <circle cx="32" cy="32" r="5" fill="#C65A2E" />
      <circle cx="32" cy="32" r="2" fill="#F2A93B" />
    </>
  ),
  MD: (
    <>
      <rect width="64" height="64" rx="16" fill="#2F7FC1" />
      <path d="M32 10C24 22 17 29 17 38a15 15 0 0 0 30 0c0-9-7-16-15-28z" fill="#fff" />
      <path
        d="M24 40a8 8 0 0 0 8 8"
        stroke="#2F7FC1"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="38" cy="33" r="2.6" fill="#BFDDF2" />
    </>
  ),
  MG: (
    <>
      <rect width="64" height="64" rx="16" fill="#3E8B3F" />
      <circle cx="44" cy="19" r="6" fill="#F7D154" />
      <path d="M8 52l17-26 10 14 6-8 15 20z" fill="#fff" />
      <path d="M25 26l5 8-5-2-4 3z" fill="#BFE3BE" />
      <path d="M14 52c4-5 10-6 15-3" stroke="#3E8B3F" strokeWidth="2.4" fill="none" />
    </>
  ),
};
