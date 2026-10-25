import { isRecord, unknownFields, type FieldProblem } from './my-file.body';

/** The body of `PUT store-profile/about` as the use case takes it. */
export interface SaveAboutBody {
  readonly expectedVersion: number;
  readonly about: Readonly<Record<string, string>>;
}

/** The body of `PUT store-profile/logo` and `/banner`: the picture as base64 text. */
export interface SaveImageBody {
  readonly data: string;
}

/** What a JSON body read as raw bytes is; anything that is not JSON stays `undefined`. */
export function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Shape only (sellers design 3.7): `expectedVersion` a JSON integer, `about` an object of strings
 * keyed by locale. Which locales the Market offers and what a text may contain is the use case's.
 * A value is never echoed.
 */
export function parseSaveAboutBody(body: unknown): SaveAboutBody | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, ['expectedVersion', 'about']);
  const version = body.expectedVersion;
  if (version === undefined) problems.push({ path: 'expectedVersion', code: 'required' });
  else if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    problems.push({ path: 'expectedVersion', code: 'type' });
  }
  const about = body.about;
  // No prototype: a client key such as `__proto__` stays an own key the use case refuses.
  const texts = Object.create(null) as Record<string, string>;
  if (about === undefined) problems.push({ path: 'about', code: 'required' });
  else if (!isRecord(about)) problems.push({ path: 'about', code: 'type' });
  else {
    for (const [locale, text] of Object.entries(about)) {
      if (typeof text !== 'string') {
        problems.push({ path: 'about', code: 'type' });
        break;
      }
      texts[locale] = text;
    }
  }
  return problems.length > 0 ? problems : { expectedVersion: version as number, about: texts };
}

/** Shape only: a closed `{ data }` with a string. The use case checks the text and the picture. */
export function parseSaveImageBody(body: unknown): SaveImageBody | readonly FieldProblem[] {
  if (!isRecord(body)) return [{ path: '', code: 'type' }];
  const problems = unknownFields(body, ['data']);
  const data = body.data;
  if (data === undefined) problems.push({ path: 'data', code: 'required' });
  else if (typeof data !== 'string') problems.push({ path: 'data', code: 'type' });
  return problems.length > 0 ? problems : { data: data as string };
}
