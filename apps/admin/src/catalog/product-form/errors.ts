import type { ApiFailure } from '../../api/client.ts';

/** What the freeze refused about one tag of the product, or about the whole list (`index` null). */
export interface TopicIssue {
  /** The place of the tag in the draft's `topicIds`; null for the whole list. */
  readonly index: number | null;
  readonly code: 'unknown' | 'archived' | 'duplicate' | 'too-many';
}

export interface FormProblem {
  /** Key under `catalog.productForm.error`. */
  readonly key: string;
  readonly values?: Record<string, string | number>;
  /** `path: code` lines of the draft or text the API refused, shown as plain text. */
  readonly details: readonly string[];
  /** The refusals about the product's tags, told by the field and the banner in words. */
  readonly topicIssues?: readonly TopicIssue[];
  /** The screen is stale: the admin should read the product again. */
  readonly reload: boolean;
}

const BY_CODE: Readonly<Record<string, string>> = {
  'claim-text.refused': 'claim-text',
  'revision.not-ready': 'not-ready',
  'revision.pending-exists': 'stale',
  'revision.base-changed': 'stale',
  'working-copy.invalid-content': 'invalid-content',
  'working-copy.not-found': 'no-draft',
  'conflict.stale': 'stale',
  'product.not-editable': 'not-editable',
  'product.not-a-draft': 'not-editable',
  'product.not-found': 'not-found',
  'product.type-not-offered': 'type-not-offered',
  'variant.id-taken': 'variant',
  'variant.unknown': 'variant',
  'variant.fixed': 'variant',
  'variant.limit-reached': 'variant',
  'variant.not-found': 'variant',
  'variant.not-proposed': 'variant',
  'variant.none': 'variant',
  'access.denied': 'denied',
};

const TOPIC_CODES: ReadonlySet<string> = new Set(['unknown', 'archived', 'duplicate', 'too-many']);

/** The issues at `topicIds` and `topicIds.<n>` as tag problems; other paths are not tag problems. */
export function topicIssuesOf(
  issues: readonly { readonly path: string; readonly code: string }[],
): TopicIssue[] {
  const found: TopicIssue[] = [];
  for (const { path, code } of issues) {
    if (!TOPIC_CODES.has(code)) continue;
    const at = /^topicIds(?:\.(\d{1,3}))?$/.exec(path);
    if (at === null) continue;
    if (at[1] === undefined) {
      if (code === 'too-many') found.push({ index: null, code });
    } else if (code !== 'too-many') {
      found.push({ index: Number(at[1]), code: code as TopicIssue['code'] });
    }
  }
  return found;
}

const RELOAD = new Set(['stale', 'not-editable', 'not-found', 'no-draft']);

export function problemOf(failure: ApiFailure): FormProblem {
  const topicIssues = topicIssuesOf(failure.details?.issues ?? []);
  // A tag refusal is told in words (by the tag field and the banner), not as a raw line.
  const lines = [
    ...(failure.details?.fields ?? []),
    ...(failure.details?.issues ?? []).filter(
      (item) => !(item.path.startsWith('topicIds') && topicIssuesOf([item]).length > 0),
    ),
  ].map((item) => `${item.path}: ${item.code}`);
  const name =
    BY_CODE[failure.code] ??
    (failure.code === 'request.throttled'
      ? 'throttled'
      : failure.code === 'validation.failed'
        ? 'invalid'
        : failure.code === 'request.csrf'
          ? 'csrf'
          : failure.status === 503 || failure.status === 0
            ? 'unavailable'
            : 'unknown');
  const values: Record<string, string | number> = {};
  if (failure.details?.max !== undefined) values['max'] = failure.details.max;
  if (failure.details?.retryAfterSeconds !== undefined) {
    values['seconds'] = failure.details.retryAfterSeconds;
  }
  return {
    key: name,
    ...(Object.keys(values).length > 0 ? { values } : {}),
    details: lines,
    ...(topicIssues.length > 0 ? { topicIssues } : {}),
    reload: RELOAD.has(name),
  };
}
