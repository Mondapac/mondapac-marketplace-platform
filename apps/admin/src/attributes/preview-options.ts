import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { API_ATTRIBUTES, type AttributeDetail } from './types.ts';

/** How many attribute reads run at once while the preview opens. */
export const MAX_PARALLEL = 3;

export type OptionsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly detail: AttributeDetail };

/** The data types whose preview control needs the attribute read: its choices, or its units. */
export const NEEDS_OPTIONS: ReadonlySet<string> = new Set(['select', 'multi-select', 'measure']);

/**
 * Reads `GET catalog/admin/attributes/:id` for each id once `enabled`, at most MAX_PARALLEL at a
 * time, and keeps the state per id (loading, ready, error). `retry` reads one id again.
 */
export function useAttributeOptions(ids: readonly string[], enabled: boolean) {
  const [states, setStates] = useState<Readonly<Record<string, OptionsState>>>({});
  const asked = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const alive = useRef(true);
  // Counts the times the preview was closed: an answer from an earlier opening is dropped.
  const generation = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pump = useCallback(() => {
    while (alive.current && running.current < MAX_PARALLEL && queue.current.length > 0) {
      const id = queue.current.shift() as string;
      const mine = generation.current;
      running.current += 1;
      void callApi<AttributeDetail>('GET', `${API_ATTRIBUTES}/${encodeURIComponent(id)}`).then(
        (result) => {
          running.current -= 1;
          if (alive.current && mine === generation.current) {
            if (!result.ok && result.failure.status === 401) {
              window.location.assign('/session-ended');
              return;
            }
            setStates((prev) => ({
              ...prev,
              [id]: result.ok ? { kind: 'ready', detail: result.body } : { kind: 'error' },
            }));
          }
          pump();
        },
      );
    }
  }, []);

  const key = ids.join('|');
  useEffect(() => {
    if (!enabled) {
      // Closed: forget what was read, so the next opening reads the choices again.
      generation.current += 1;
      asked.current.clear();
      queue.current = [];
      setStates({});
      return;
    }
    const fresh = ids.filter((id) => !asked.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) asked.current.add(id);
    setStates((prev) => ({
      ...prev,
      ...Object.fromEntries(fresh.map((id) => [id, { kind: 'loading' } as const])),
    }));
    queue.current.push(...fresh);
    pump();
    // `ids` is read through `key`: a new array with the same ids must not read again.
  }, [enabled, key, pump]);

  const retry = useCallback(
    (id: string) => {
      setStates((prev) => ({ ...prev, [id]: { kind: 'loading' } }));
      queue.current.push(id);
      pump();
    },
    [pump],
  );

  return { states, retry };
}
