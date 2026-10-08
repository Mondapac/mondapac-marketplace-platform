'use client';

import { useMemo, useRef, useState } from 'react';
import { callApi, type ApiResult } from '../api/client.ts';
import { problemOf, type SaveProblem } from './errors.ts';

/**
 * Save state shared by the setup forms: one request at a time, the problem of the last attempt
 * (form-level and per field) and whether the last save went through.
 */
export function useStepSave(csrfToken: string) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);

  async function save<T>(path: string, body: unknown): Promise<ApiResult<T> | null> {
    if (busy.current) return null;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setSaved(false);
    const result = await callApi<T>('PUT', path, body, csrfToken);
    busy.current = false;
    setPending(false);
    if (result.ok) setSaved(true);
    else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(problemOf(result.failure));
    return result;
  }

  // What the focus hook watches: the invalid fields, or the form-level message when none is.
  const focusKeys = useMemo<Record<string, string>>(
    () =>
      problem === null
        ? {}
        : { ...problem.fields, ...(problem.form ? { '#form': problem.form.key } : {}) },
    [problem],
  );

  return { pending, problem, saved, setSaved, save, focusKeys };
}
