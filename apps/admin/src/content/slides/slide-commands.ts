import type { ApiFailure } from '../../api/client.ts';
import type { SlidePlacement } from './slide-types.ts';

// How the panel reads a refused slide command (submit, approve, pause, resume, archive, restore):
// one message id per answer of the API (apps/api storefront `http-answers.ts`). The panel never
// guesses from the text of an error; it reads the code.

export type CommandMessage =
  | 'network'
  | 'denied'
  | 'not-found'
  | 'version-not-found'
  | 'archived'
  | 'version-limit'
  | 'no-draft'
  | 'draft-changed'
  | 'not-submitted'
  | 'ended'
  | 'not-live'
  | 'not-paused'
  | 'position-full'
  | 'link-invalid'
  | 'invalid'
  | 'generic';

const BY_CODE: Readonly<Record<string, CommandMessage>> = {
  'storefront.slide-not-found': 'not-found',
  'storefront.slide-version-not-found': 'version-not-found',
  'storefront.slide-archived': 'archived',
  'storefront.slide-version-limit': 'version-limit',
  'storefront.slide-no-draft': 'no-draft',
  'storefront.slide-draft-changed': 'draft-changed',
  'storefront.slide-not-submitted': 'not-submitted',
  'storefront.slide-ended': 'ended',
  'storefront.slide-not-live': 'not-live',
  'storefront.slide-not-paused': 'not-paused',
  'storefront.slide-position-full': 'position-full',
  'storefront.slide-link-invalid': 'link-invalid',
  'validation.failed': 'invalid',
};

export function messageOf(failure: ApiFailure): CommandMessage {
  if (failure.code === 'network') return 'network';
  const known = BY_CODE[failure.code];
  if (known !== undefined) return known;
  if (failure.status === 403) return 'denied';
  return 'generic';
}

/**
 * The slide changed while the admin looked at it (someone else sent, approved, paused or
 * archived it): the dialog says so and the page is read again.
 */
const STALE: ReadonlySet<CommandMessage> = new Set([
  'not-found',
  'archived',
  'no-draft',
  'draft-changed',
  'not-submitted',
  'ended',
  'not-live',
  'not-paused',
]);
export const isStale = (message: CommandMessage): boolean => STALE.has(message);

/** One thing the system found wrong when it checked a draft or a resume. */
export interface Finding {
  readonly kind: 'link' | 'scope' | 'full';
  /** The placement it concerns, when it concerns one. */
  readonly placement: SlidePlacement | null;
}

const PLACEMENT_PATH = /^placements\[(\d+)\]\.(position|scopeId)$/;

/**
 * The fields of a `slide-link-invalid` or `slide-position-full` answer, as findings. A path is the
 * index into the placements of the version that was checked (`placements`).
 */
export function findingsOf(
  failure: ApiFailure,
  placements: readonly SlidePlacement[],
): readonly Finding[] {
  const fields = failure.details?.fields ?? [];
  const found: Finding[] = [];
  for (const field of fields) {
    if (field.path === 'content.link') {
      found.push({ kind: 'link', placement: null });
      continue;
    }
    const match = PLACEMENT_PATH.exec(field.path);
    if (match === null) continue;
    const placement = placements[Number(match[1])] ?? null;
    found.push({ kind: match[2] === 'position' ? 'full' : 'scope', placement });
  }
  return found;
}
