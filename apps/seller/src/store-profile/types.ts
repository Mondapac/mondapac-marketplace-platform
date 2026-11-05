import type { LastChangedValue } from '@mondapac/ui';

export const STORE_PROFILE_VIEW_PERMISSION = 'sellers.store-profile.view';
export const STORE_PROFILE_EDIT_PERMISSION = 'sellers.store-profile.edit';

export type ImageKind = 'logo' | 'banner';

/** A stored logo or banner: its id (for the preview route) and the pixels of its large size. */
export interface StoreImageRef {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** `GET sellers/store-profile` and the answer of every save. */
export interface StoreProfileView {
  /** The newest change, from the audit log; null while it was never changed. */
  readonly lastChanged?: LastChangedValue | null;
  /** Names the version a text save was made against (0: never saved). */
  readonly version: number;
  /** The About text by locale; an empty string where none is written. */
  readonly about: Readonly<Record<string, string>>;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly logo: StoreImageRef | null;
  readonly banner: StoreImageRef | null;
  readonly aboutMaxLength: number;
  readonly imageMaxBytes: number;
}

/** The URL of one size of an image, through this panel's relay. */
export const storeImageUrl = (imageId: string, size: 'small' | 'large'): string =>
  `/api/sellers/store-profile/images/${imageId}/${size}`;
