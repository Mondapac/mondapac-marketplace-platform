'use client';

import { useCallback, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { reviewProblemOf, type ReviewProblem } from './errors.ts';

export type ReviewOutcome<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly problem: ReviewProblem | null };

/**
 * One write of the review page at a time. A rejected session sends the page to sign-in; any other
 * refusal is kept as a problem to show; a second call while one runs is ignored.
 */
export function useReviewCall(csrfToken: string) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ReviewProblem | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async <T>(path: string, body: unknown): Promise<ReviewOutcome<T>> => {
      if (busy.current) return { ok: false, problem: null };
      busy.current = true;
      setPending(true);
      setProblem(null);
      const result = await callApi<T>('POST', path, body, csrfToken);
      busy.current = false;
      setPending(false);
      if (result.ok) return { ok: true, body: result.body };
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return { ok: false, problem: null };
      }
      const next = reviewProblemOf(result.failure);
      setProblem(next);
      return { ok: false, problem: next };
    },
    [csrfToken],
  );

  return { run, pending, problem };
}
