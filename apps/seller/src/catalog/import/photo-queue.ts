// The photo step after a my-products import (catalog design 14c, "Photos"): the photos the file
// named are sent one request each to `POST catalog/seller/imports/:id/photos`. The server never
// receives a ZIP; the panel sends the pictures. This file holds the parts that need no React: what a
// picked file becomes, and the queue that sends them one at a time and stops on a throttle.

import { callApi, type ApiFailure } from '../../api/client.ts';
import { preparePhoto } from '../photo-prepare.ts';
import { IMPORT_BASE } from './import-types.ts';

/** One picture the seller chose: the name the file lists in its Images column, and the bytes. */
export interface PhotoItem {
  /** The file name as the seller's device gave it (no folder), the label the server matches. */
  readonly name: string;
  readonly file: File;
}

/** What happened to one photo. */
export type PhotoOutcome =
  /** Added to the product the file named. */
  | 'added'
  /** The file does not list this name (design: `import.photo-not-named`). */
  | 'not-named'
  /** A photo with this name was added before. */
  | 'already'
  /** The product already has eight photos (`image.limit-reached`). */
  | 'limit'
  /** The picture was refused: too big, too small, not a readable JPEG, PNG or WebP. */
  | 'refused'
  /** The product is no longer the seller's, or no longer there. */
  | 'product-gone';

export interface PhotoResult {
  readonly name: string;
  readonly outcome: PhotoOutcome;
  /** The API code behind a refusal, for the words next to it. */
  readonly code: string | null;
}

/** Why the queue stopped before the end. */
export type PhotoStop =
  /** Too many photos for now: `retryAfterSeconds` says when to go on. */
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number }
  /** The photo step is over (seven days) or the import is gone. */
  | { readonly kind: 'closed' }
  /** The seller may no longer add photos (access changed, not eligible, session). */
  | { readonly kind: 'access' }
  /** The server or the network did not answer; the rest can be tried again. */
  | { readonly kind: 'unavailable' };

/** Extensions the picker offers; the server decides by the content, not the name. */
export const PHOTO_EXTENSION = /\.(jpe?g|png|webp)$/i;
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
/** The most photos one picking is asked to hold, so a whole drive picked by mistake is refused. */
export const MAX_PICKED_PHOTOS = 2000;
/** The server's own limit is 60 photos a minute per seller; one start a second stays below it. */
export const MIN_INTERVAL_MS = 1000;

export interface PickedPhotos {
  readonly items: readonly PhotoItem[];
  /** Files left out because they are not JPEG, PNG or WebP pictures. */
  readonly notPhotos: number;
  /** Files left out because an earlier file has the same name (matched without case). */
  readonly sameName: number;
  /** Files left out because more than {@link MAX_PICKED_PHOTOS} were picked. */
  readonly overLimit: number;
}

/**
 * A picking as the queue takes it: pictures only, the first of each name (the server matches names
 * without case, so `A.jpg` and `a.JPG` are one name), at most {@link MAX_PICKED_PHOTOS}.
 *
 * ZIP seam: the step takes a `PhotoItem[]` and nothing else. A ZIP is opened in the browser by
 * `unzipPhotos` (photo-zip.ts, no library) and its pictures come here like any picked files.
 */
export function pickPhotos(files: Iterable<File>): PickedPhotos {
  const items: PhotoItem[] = [];
  const seen = new Set<string>();
  let notPhotos = 0;
  let sameName = 0;
  let overLimit = 0;
  for (const file of files) {
    if (!PHOTO_EXTENSION.test(file.name)) {
      notPhotos += 1;
      continue;
    }
    const key = file.name.toLowerCase();
    if (seen.has(key)) {
      sameName += 1;
      continue;
    }
    if (items.length >= MAX_PICKED_PHOTOS) {
      overLimit += 1;
      continue;
    }
    seen.add(key);
    items.push({ name: file.name, file });
  }
  return { items, notPhotos, sameName, overLimit };
}

const REFUSED_CODES: ReadonlySet<string> = new Set([
  'file.too-large',
  'file.unreadable',
  'file.unsupported-type',
  'file.too-many-pixels',
  'file.too-small',
  'validation.failed',
]);

/** Sorts one refused photo call into a result, or into the reason to stop the queue. */
export function classifyPhotoFailure(
  name: string,
  failure: ApiFailure,
): { readonly result: PhotoResult } | { readonly stop: PhotoStop } {
  const result = (outcome: PhotoOutcome): { readonly result: PhotoResult } => ({
    result: { name, outcome, code: failure.code },
  });
  switch (failure.code) {
    case 'import.photo-not-named':
      return result('not-named');
    case 'import.photo-already-added':
      return result('already');
    case 'image.limit-reached':
      return result('limit');
    case 'product.not-found':
      return result('product-gone');
    case 'request.throttled':
      return {
        stop: {
          kind: 'throttled',
          retryAfterSeconds: Math.max(1, Math.ceil(failure.details?.retryAfterSeconds ?? 60)),
        },
      };
    case 'import.photos-closed':
    case 'import.not-found':
      return { stop: { kind: 'closed' } };
    case 'access.denied':
    case 'access.acting-as-refused':
    case 'seller.not-eligible':
    case 'request.csrf':
    case 'session.invalid':
      return { stop: { kind: 'access' } };
    default:
      if (REFUSED_CODES.has(failure.code)) return result('refused');
      return { stop: { kind: 'unavailable' } };
  }
}

export interface QueueEnvironment {
  readonly importId: string;
  readonly csrfToken: string;
  /** Called after each photo with the result; the page counts them. */
  readonly onResult: (result: PhotoResult) => void;
  /** True once the seller pressed Stop; checked between photos. */
  readonly cancelled: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly minIntervalMs?: number;
}

export interface QueueEnd {
  /** The photos not tried (a throttle or another stop leaves them for later). */
  readonly remaining: readonly PhotoItem[];
  readonly stop: PhotoStop | null;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Sends the photos one at a time. A photo the server refuses for its own sake (not named in the
 * file, already added, the product is full, unreadable) is a result and the queue goes on; a
 * throttle, a closed step, a change of access or an unreachable server ends it, with the rest
 * handed back so the seller can go on later without picking again.
 */
export async function runPhotoQueue(
  items: readonly PhotoItem[],
  env: QueueEnvironment,
): Promise<QueueEnd> {
  const now = env.now ?? Date.now;
  const sleep = env.sleep ?? wait;
  const interval = env.minIntervalMs ?? MIN_INTERVAL_MS;
  let lastStart = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (env.cancelled()) return { remaining: items.slice(index), stop: null };
    const rest = interval - (now() - lastStart);
    if (rest > 0) await sleep(rest);
    if (env.cancelled()) return { remaining: items.slice(index), stop: null };
    lastStart = now();
    const prepared = await preparePhoto(item.file);
    if (prepared.kind === 'refused') {
      env.onResult({
        name: item.name,
        outcome: 'refused',
        code: prepared.reason === 'too-large' ? 'file.too-large' : 'file.unreadable',
      });
      continue;
    }
    const sent = await callApi<unknown>(
      'POST',
      `${IMPORT_BASE}/${env.importId}/photos`,
      { name: item.name, data: prepared.data },
      env.csrfToken,
    );
    if (sent.ok) {
      env.onResult({ name: item.name, outcome: 'added', code: null });
      continue;
    }
    const sorted = classifyPhotoFailure(item.name, sent.failure);
    if ('result' in sorted) {
      env.onResult(sorted.result);
      continue;
    }
    return { remaining: items.slice(index), stop: sorted.stop };
  }
  return { remaining: [], stop: null };
}
