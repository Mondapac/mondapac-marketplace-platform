'use client';

import { useCallback, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { requestProblemOf, type RequestProblem } from './errors.ts';

export type RequestOutcome<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly problem: RequestProblem | null };

/** One write of the issuer request page at a time; a rejected session goes to sign-in. */
export function useRequestCall(csrfToken: string) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<RequestProblem | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async <T>(path: string, body: unknown): Promise<RequestOutcome<T>> => {
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
      const next = requestProblemOf(result.failure);
      setProblem(next);
      return { ok: false, problem: next };
    },
    [csrfToken],
  );

  return { run, pending, problem };
}
