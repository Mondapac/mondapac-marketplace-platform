import type { ApiFailure } from '../../api/client.ts';
import type { Finding } from './types.ts';

/** A message key under `blog.editor.error` for a refused call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'blog.slug-taken': 'slug-taken',
  'blog.wrong-state': 'wrong-state',
  'blog.post-archived': 'archived',
  'blog.post-not-found': 'gone',
  'blog.version-limit': 'version-limit',
  'blog.checks-failed': 'checks-failed',
  'blog.unavailable': 'unavailable',
  'conflict.stale': 'stale',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
  'request.too-large': 'too-large',
  'request.csrf': 'csrf',
  'blog.self-approval-refused': 'self-approval',
  'blog.access-off': 'access-off',
  'blog.seller-owned': 'seller-owned',
  'blog.quota-used': 'quota-used',
  'second-factor.enrolment-required': 'enrolment',
};

export interface EditorProblem {
  /** Full message key. */
  readonly key: string;
  /** The post changed or vanished meanwhile: the editor reads it again. */
  readonly reload: boolean;
  /** Paths the API refused (`validation.failed`), like `content.title` or `slug`. */
  readonly fields: readonly { readonly path: string; readonly code: string }[];
  /** The findings of a refused submit (`blog.checks-failed`). */
  readonly findings: readonly Finding[];
}

export function editorProblemOf(failure: ApiFailure): EditorProblem {
  const named = BY_CODE[failure.code];
  const key = named ?? (failure.status === 0 || failure.status >= 500 ? 'unreachable' : 'unknown');
  const findings = (failure.details as { readonly findings?: readonly Finding[] } | undefined)
    ?.findings;
  return {
    key: `blog.editor.error.${key}`,
    reload: key === 'stale' || key === 'gone' || key === 'wrong-state',
    fields: failure.details?.fields ?? [],
    findings: Array.isArray(findings) ? findings : [],
  };
}

/** The first refused path that starts with `path`, as its reason code. */
export function reasonFor(problem: EditorProblem | null, path: string): string | undefined {
  return problem?.fields.find((f) => f.path === path || f.path.startsWith(`${path}.`))?.code;
}
