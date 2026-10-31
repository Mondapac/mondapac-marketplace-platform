'use client';

import { useCallback, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { brandProblemOf, type BrandProblem } from './brand-errors.ts';

export type Outcome<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly problem: BrandProblem | null };

/**
 * One write of the brand screen at a time. A rejected session sends the page to sign-in; any other
 * refusal is kept as a problem to show; a second call while one runs is ignored.
 */
export function useBrandCall(csrfToken: string) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<BrandProblem | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async <T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<Outcome<T>> => {
      if (busy.current) return { ok: false, problem: null };
      busy.current = true;
      setPending(true);
      setProblem(null);
      const result = await callApi<T>(method, path, body, csrfToken);
      busy.current = false;
      setPending(false);
      if (result.ok) return { ok: true, body: result.body };
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return { ok: false, problem: null };
      }
      const next = brandProblemOf(result.failure);
      setProblem(next);
      return { ok: false, problem: next };
    },
    [csrfToken],
  );

  return { run, pending, problem, clear: useCallback(() => setProblem(null), []) };
}
