import type { LeftOut, WriterDetail, WriterLength, WriterTone } from './writer-copy.ts';

/** The shape both panels' `callApi` answer has, so this package needs no panel import. */
export type WriterApiResult<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly failure: {
        readonly status: number;
        readonly code: string;
        readonly details?: object | undefined;
      };
    };

/** A panel's `callApi`, with the abort signal as the fifth argument. */
export type WriterCall = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  csrfToken?: string,
  signal?: AbortSignal,
) => Promise<WriterApiResult<unknown>>;

export interface WriterRequest {
  readonly title: string;
  readonly category: string;
  readonly details: readonly WriterDetail[];
  readonly keywords: readonly string[];
  readonly note: string;
  readonly tone: WriterTone;
  readonly length: WriterLength;
}

export interface WriterStatus {
  /** False: hide "Write with AI". */
  readonly available: boolean;
  /** The Market's IANA zone the daily drafts reset in. */
  readonly resetZone: string;
}

export type WriterOutcome =
  | { readonly kind: 'draft'; readonly text: string; readonly leftOut: LeftOut }
  | { readonly kind: 'withheld'; readonly leftOut: LeftOut }
  | { readonly kind: 'limit'; readonly resetZone: string | null }
  | { readonly kind: 'throttled' }
  | { readonly kind: 'failed' }
  /** 409 ai.writer-off: the button goes away. */
  | { readonly kind: 'off' };

const NO_LEFT_OUT: LeftOut = { certification: 0, other: 0 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function leftOutOf(value: unknown): LeftOut {
  if (!isRecord(value)) return NO_LEFT_OUT;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return { certification: count(value['certification']), other: count(value['other']) };
}

/** Whether the writer is on for this actor. Any failure or a malformed answer means off. */
export async function loadWriterStatus(
  call: WriterCall,
  base: string,
  signal?: AbortSignal,
): Promise<WriterStatus> {
  const off: WriterStatus = { available: false, resetZone: '' };
  let result: Awaited<ReturnType<WriterCall>> | undefined;
  try {
    result = await call('GET', base, undefined, undefined, signal);
  } catch {
    return off;
  }
  // Anything that is not a clean answer means off, so a broken read never shows the button.
  if (!isRecord(result) || result.ok !== true || !isRecord(result.body)) return off;
  const { available, resetZone } = result.body;
  return {
    available: available === true,
    resetZone: typeof resetZone === 'string' ? resetZone : '',
  };
}

/** Asks for a draft and sorts every answer into one outcome the modal has a state for. */
export async function requestDraft(
  call: WriterCall,
  base: string,
  csrfToken: string,
  request: WriterRequest,
  signal: AbortSignal,
): Promise<WriterOutcome> {
  const body = {
    title: request.title,
    category: request.category,
    ...(request.details.length > 0 ? { details: request.details } : {}),
    ...(request.keywords.length > 0 ? { keywords: request.keywords } : {}),
    ...(request.note.trim() === '' ? {} : { note: request.note.trim() }),
    tone: request.tone,
    length: request.length,
  };
  const result = await call('POST', `${base}/drafts`, body, csrfToken, signal);
  if (result.ok) {
    const answer = result.body;
    if (isRecord(answer) && typeof answer['text'] === 'string' && answer['text'].trim() !== '') {
      return { kind: 'draft', text: answer['text'], leftOut: leftOutOf(answer['leftOut']) };
    }
    return { kind: 'failed' };
  }
  const { status, code, details } = result.failure;
  if (status === 409 && code === 'ai.writer-off') return { kind: 'off' };
  if (status === 422 && code === 'ai.draft-withheld') {
    return { kind: 'withheld', leftOut: leftOutOf(isRecord(details) ? details['leftOut'] : null) };
  }
  if (status === 429 && code === 'ai.limit-reached') {
    const zone = isRecord(details) ? details['resetZone'] : null;
    return { kind: 'limit', resetZone: typeof zone === 'string' && zone !== '' ? zone : null };
  }
  if (status === 429) return { kind: 'throttled' };
  return { kind: 'failed' };
}
