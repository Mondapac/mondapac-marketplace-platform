import { useEffect, useState } from 'react';

const PHONE = '(max-width: 639.98px)';

/** Whether the screen is a phone: the attribute page then shows its sections as accordions. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PHONE);
    setPhone(query.matches);
    const listener = (event: MediaQueryListEvent) => setPhone(event.matches);
    query.addEventListener?.('change', listener);
    return () => query.removeEventListener?.('change', listener);
  }, []);
  return phone;
}
