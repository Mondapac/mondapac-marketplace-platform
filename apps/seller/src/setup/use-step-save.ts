'use client';

import { useRef, useState } from 'react';
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
    else setProblem(problemOf(result.failure));
    return result;
  }

  return { pending, problem, saved, setSaved, save };
}
