import type { ApiFailure } from '../api/client.ts';
import type { ImageKind } from './types.ts';

/** What went wrong with an About save, as message keys under `store-profile.about`. */
export interface AboutProblem {
  /** The banner above the form: a key under `store-profile.about.error`, or null. */
  readonly banner:
    'stale' | 'throttled' | 'denied' | 'csrf' | 'unavailable' | 'not-ready' | 'unknown' | null;
  /** Locale to a rule under `store-profile.about.rule`. */
  readonly fields: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number;
}

const RULES = new Set(['length', 'characters', 'url', 'claim-term']);
const FIELD = /^about\.(.+)$/;

export function aboutProblemOf(failure: ApiFailure): AboutProblem {
  if (failure.code === 'validation.failed') {
    const fields: Record<string, string> = {};
    for (const problem of failure.details?.fields ?? []) {
      const locale = FIELD.exec(problem.path)?.[1];
      if (locale === undefined || locale in fields) continue;
      fields[locale] = RULES.has(problem.code) ? problem.code : 'invalid';
    }
    return { banner: null, fields };
  }
  if (failure.code === 'conflict.stale') return { banner: 'stale', fields: {} };
  if (failure.code === 'request.throttled') {
    const retryAfterSeconds = failure.details?.retryAfterSeconds;
    return {
      banner: 'throttled',
      fields: {},
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  if (failure.code === 'access.denied') return { banner: 'denied', fields: {} };
  if (failure.code === 'request.csrf') return { banner: 'csrf', fields: {} };
  if (failure.code === 'file.not-found') return { banner: 'not-ready', fields: {} };
  if (failure.status === 503 || failure.status === 0) return { banner: 'unavailable', fields: {} };
  return { banner: 'unknown', fields: {} };
}

/** What went wrong with a logo or banner call. */
export interface ImageProblem {
  /** A key under `store-profile.image.error`; the size-specific ones carry the kind. */
  readonly key: string;
  readonly kind?: ImageKind;
  readonly retryAfterSeconds?: number;
}

export function imageProblemOf(failure: ApiFailure, kind: ImageKind): ImageProblem {
  switch (failure.code) {
    case 'file.too-large':
      return { key: 'too-large' };
    case 'file.unsupported-type':
      return { key: 'unsupported' };
    case 'file.too-many-pixels':
      return { key: 'too-many-pixels' };
    case 'file.unreadable':
      return { key: 'unreadable' };
    case 'file.too-small':
      return { key: `too-small.${kind}` };
    case 'request.throttled': {
      const retryAfterSeconds = failure.details?.retryAfterSeconds;
      return {
        key: 'throttled',
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    case 'access.denied':
      return { key: 'denied' };
    case 'request.csrf':
      return { key: 'csrf' };
    case 'file.not-found':
      return { key: 'not-ready' };
    default:
      return { key: failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown' };
  }
}

/** What went wrong with the one store-profile save: the About problem and the refused pictures. */
export interface SaveProblem extends AboutProblem {
  /** The picture the server refused, by kind. */
  readonly pictures: Readonly<Partial<Record<ImageKind, ImageProblem>>>;
}

/**
 * The failure of `PUT sellers/store-profile`. A picture the server refuses is a `file.*` answer
 * with `details.kind`; everything else reads as an About failure.
 */
export function saveProblemOf(failure: ApiFailure): SaveProblem {
  const kind = failure.details?.kind;
  if (failure.code.startsWith('file.') && kind !== undefined) {
    return { banner: null, fields: {}, pictures: { [kind]: imageProblemOf(failure, kind) } };
  }
  return { ...aboutProblemOf(failure), pictures: {} };
}
