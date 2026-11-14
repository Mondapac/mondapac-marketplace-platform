'use client';

import type { CategoryChoice } from '@mondapac/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';

/** The platform product form's category picker (catalog, categories C5a): levels 3 and 4, hidden ones too. */
export const CATEGORY_PICKER = 'catalog/admin/platform-products/category-picker';

interface PickerBody {
  readonly locale: string;
  readonly choices: readonly CategoryChoice[];
}

export type CategoryChoices =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly choices: readonly CategoryChoice[] };

/**
 * Reads the picker when `load` is first called (the admin opens the Add control), so a form that
 * only saves texts never asks for it. `load` again after a failure reads it once more. A
 * signed-out session goes to sign-in.
 */
export function useCategoryChoices(): { choices: CategoryChoices; load: () => void } {
  const [choices, setChoices] = useState<CategoryChoices>({ state: 'idle' });
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(() => {
    if (started.current) return;
    started.current = true;
    setChoices({ state: 'loading' });
    void callApi<PickerBody>('GET', CATEGORY_PICKER).then((result) => {
      if (result.ok) {
        if (mounted.current) setChoices({ state: 'ready', choices: result.body.choices });
        return;
      }
      started.current = false;
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else if (mounted.current) setChoices({ state: 'failed' });
    });
  }, []);
  return { choices, load };
}
