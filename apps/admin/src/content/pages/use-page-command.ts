'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import type { PageDetail } from './page-types.ts';

export type CommandResult =
  | { readonly ok: true; readonly page: PageDetail }
  | { readonly ok: false; readonly problem: PageProblem };

export interface PageProblem {
  /** The API's code (`validation.failed`, `storefront.page-locked`, ...) or `network`. */
  readonly code: string;
  readonly status: number;
  /** `validation.failed`: the paths and codes of the refused fields. */
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/** The codes that mean the page changed under the editor: the page is read again. */
export const STALE_CODES: ReadonlySet<string> = new Set([
  'storefront.placement-not-found',
  'storefront.slot-not-found',
  'storefront.page-not-found',
]);

/**
 * Runs one change of a page's draft at a time (a second press before the answer is ignored) and
 * keeps the refusal for the caller to word. A change answers the whole page as it is now. `null`:
 * the press was ignored (another change is still running) or the session ended.
 */
export function usePageCommand(csrfToken: string) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<PageProblem | null>(null);

  const run = useCallback(
    async (
      method: 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: Record<string, unknown>,
    ): Promise<CommandResult | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setPending(true);
      setProblem(null);
      try {
        const result = await callApi<PageDetail>(method, path, body, csrfToken);
        if (result.ok) return { ok: true, page: result.body };
        if (result.failure.status === 401) {
          router.replace('/session-ended');
          return null;
        }
        const refused: PageProblem = {
          code: result.failure.code,
          status: result.failure.status,
          fields: result.failure.details?.fields ?? [],
        };
        setProblem(refused);
        return { ok: false, problem: refused };
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [csrfToken, router],
  );

  const reset = useCallback(() => setProblem(null), []);
  return { pending, problem, run, reset };
}

const PROBLEM_KEYS: Readonly<Record<string, string>> = {
  'validation.failed': 'fields',
  'storefront.page-locked': 'locked',
  'storefront.page-archived': 'archived',
  'storefront.slot-full': 'slot-full',
  'storefront.slug-taken': 'slug-taken',
  'storefront.placement-not-found': 'stale',
  'storefront.slot-not-found': 'stale',
  'storefront.page-not-found': 'stale',
  network: 'network',
};

/** The words for a refused change; a code this panel does not know reads as a plain failure. */
export function useProblemText(): (problem: PageProblem) => string {
  const t = useTranslations('content.pages.editor.error');
  return (problem) => t(problem.status === 403 ? 'denied' : (PROBLEM_KEYS[problem.code] ?? 'save'));
}
