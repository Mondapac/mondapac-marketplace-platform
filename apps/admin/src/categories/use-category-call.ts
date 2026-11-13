'use client';

import { useCallback, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import {
  categoryProblemOf,
  restructureProblemOf,
  type CategoryProblem,
} from './category-errors.ts';

export type Outcome<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly problem: CategoryProblem | null };

/**
 * One write of the category editor at a time. A rejected session sends the page to sign-in; any
 * other refusal is kept as a problem to show; a second call while one runs is ignored.
 */
export function useCategoryCall(csrfToken: string, restructure = false) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<CategoryProblem | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async <T>(
      method: 'POST' | 'PUT' | 'PATCH',
      path: string,
      body: unknown,
      options: { readonly namesCategoryVersion?: boolean } = {},
    ): Promise<Outcome<T>> => {
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
      const next = restructure
        ? restructureProblemOf(result.failure)
        : categoryProblemOf(
            result.failure,
            method,
            options.namesCategoryVersion ?? method !== 'POST',
          );
      setProblem(next);
      return { ok: false, problem: next };
    },
    [csrfToken, restructure],
  );

  return { run, pending, problem, clear: () => setProblem(null) };
}
