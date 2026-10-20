'use client';

import { useCallback, useState } from 'react';
import { useStore } from '../shell/store-context.tsx';

/**
 * Try again of the offline page and banner: "Checking..." while the connection is checked, then
 * the polite "Still offline" status when it is still down. `onBack` runs when it answers.
 */
export function useRetry(onBack: () => void) {
  const { checkConnection } = useStore();
  const [checking, setChecking] = useState(false);
  const [stillOffline, setStillOffline] = useState(false);
  const retry = useCallback(async () => {
    setChecking(true);
    setStillOffline(false);
    const ok = await checkConnection();
    setChecking(false);
    if (ok) onBack();
    else setStillOffline(true);
  }, [checkConnection, onBack]);
  return { checking, stillOffline, retry };
}
