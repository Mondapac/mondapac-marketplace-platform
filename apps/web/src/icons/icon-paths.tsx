import type { ReactNode } from 'react';

// Line icons of the approved storefront design (v29), drawn on a 24 x 24 grid with currentColor.
export const ICON_PATHS = {
  menu: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </>
  ),
  bag: (
    <>
      <path d="M6 8h12l-1 12H7L6 8z" />
      <path d="M9 8V7a3 3 0 0 1 6 0v1" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  minus: (
    <>
      <path d="M5 12h14" />
    </>
  ),
  chevd: (
    <>
      <path d="M6 9l6 6 6-6" />
    </>
  ),
  chevr: (
    <>
      <path d="M9 6l6 6-6 6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  home: (
    <>
      <path d="M4 11l8-7 8 7v9H4z" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
  leaf: (
    <>
      <path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15" />
      <path d="M5 19c3-5 6-8 10-10" />
    </>
  ),
  meat: (
    <>
      <path d="M5 12c0-4 4-7 8-6 4 1 6 4 5 8-1 4-5 5-8 4-3-1-5-3-5-6z" />
      <circle cx="12" cy="12" r="2.2" />
    </>
  ),
  poultry: (
    <>
      <circle cx="15" cy="9" r="5" />
      <path d="M11.5 12.5L6 18" />
      <circle cx="5" cy="19" r="1.6" />
    </>
  ),
  bakery: (
    <>
      <path d="M4 11a4 4 0 0 1 3-6h10a4 4 0 0 1 3 6v8H4z" />
      <path d="M9 10l1.5 2M13 10l1.5 2" />
    </>
  ),
  pantry: (
    <>
      <rect x="6" y="8" width="12" height="13" rx="2" />
      <rect x="8" y="4" width="8" height="4" rx="1" />
    </>
  ),
  dairy: (
    <>
      <path d="M8 3h8l2 5v13H6V8z" />
      <path d="M6 8h12" />
    </>
  ),
  produce: (
    <>
      <path d="M12 7c-3-2-8 0-8 6 0 4 3 8 5 8 1 0 2-1 3-1s2 1 3 1c2 0 5-4 5-8 0-6-5-8-8-6z" />
      <path d="M12 7c0-2 1-3 3-4" />
    </>
  ),
  spices: (
    <>
      <path d="M9 3h6v3H9z" />
      <path d="M8 6h8l1 15H7z" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12V4h8l9 9-8 8z" />
      <circle cx="7.5" cy="8.5" r="1.2" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  bolt: (
    <>
      <path d="M13 3L5 14h6l-1 7 8-11h-6z" />
    </>
  ),
  store: (
    <>
      <path d="M5 9v11h14V9" />
      <path d="M3 9l1.5-5h15L21 9a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  heart: (
    <>
      <path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z" />
    </>
  ),
  gift: (
    <>
      <rect x="4" y="9" width="16" height="4" />
      <path d="M5 13v7h14v-7M12 9v11" />
      <path d="M12 9C10 5 6 6 7 9c.5 1.5 3 1 5 0zM12 9c2-4 6-3 5 0-.5 1.5-3 1-5 0z" />
    </>
  ),
  book: (
    <>
      <path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
      <path d="M5 17a3 3 0 0 1 3-3h10" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12M18 6L6 18" />
    </>
  ),
  chevl: (
    <>
      <path d="M15 6l-6 6 6 6" />
    </>
  ),
  meals: (
    <>
      <path d="M3 11h18a9 9 0 0 1-18 0z" />
      <path d="M8 7c0-2 2-2 2-4M13 7c0-2 2-2 2-4" />
    </>
  ),
  truck: (
    <>
      <path d="M3 6h11v10H3zM14 9h4l3 3v4h-7z" />
      <circle cx="7.5" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  up: (
    <>
      <path d="M6 14l6-6 6 6" />
    </>
  ),
  note: (
    <>
      <path d="M5 4h14v12l-4 4H5z" />
      <path d="M9 9h6M9 13h4" />
    </>
  ),
  check: (
    <>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  warn: (
    <>
      <path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  share: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  chat: (
    <>
      <path d="M4 5h16v11H9l-5 4z" />
    </>
  ),
  dash: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="1.6" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  out: (
    <>
      <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.2 4M6.5 7.3C3.9 9 2 12 2 12s3.6 6.5 10 6.5c1.5 0 2.9-.4 4.1-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </>
  ),
  send: (
    <>
      <path d="M4 12l16-8-6 16-3-6.5z" />
      <path d="M11 13.5L20 4" />
    </>
  ),
  stop: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </>
  ),
  'thumb-up': (
    <>
      <path d="M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.2 2.6L12.7 9H19a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 18 19H7" />
    </>
  ),
  'thumb-down': (
    <>
      <path d="M7 13V4H4v9zM7 13l4 8c1.5 0 2.5-1 2.2-2.6L12.7 15H19a2 2 0 0 0 2-2.3l-1-6A2 2 0 0 0 18 5H7" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  pen: (
    <>
      <path d="M4 20v-3.5L15.5 5a2.1 2.1 0 0 1 3 3L7 19.5z" />
      <path d="M13.5 7l3.5 3.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICON_PATHS;
