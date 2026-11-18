'use client';

import { useCallback, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { typeProblemOf, type TypeProblem } from './errors.ts';

export type TypeOutcome<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly problem: TypeProblem | null };

/**
 * One write of the type screens at a time. A rejected session sends the page to sign-in; any other
 * refusal is kept as a problem to show; a second call while one runs is ignored.
 */
export function useTypeCall(csrfToken: string) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<TypeProblem | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async <T>(path: string, body: unknown): Promise<TypeOutcome<T>> => {
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
      const next = typeProblemOf(result.failure);
      setProblem(next);
      return { ok: false, problem: next };
    },
    [csrfToken],
  );

  return { run, pending, problem };
}
