import { useSyncExternalStore } from 'react';

// The address is the window's own: `replace` writes it and tells the subscribers.
const EVENT = 'shots:navigate';
const subscribe = (onChange: () => void) => {
  globalThis.addEventListener(EVENT, onChange);
  return () => globalThis.removeEventListener(EVENT, onChange);
};
export const useRouter = () => ({
  push: () => undefined,
  replace: (url: string) => {
    globalThis.history.replaceState(null, '', url);
    globalThis.dispatchEvent(new Event(EVENT));
  },
});
export const usePathname = () => '/products';
export const useSearchParams = () => {
  const text = useSyncExternalStore(subscribe, () => globalThis.location.search);
  return new URLSearchParams(text);
};
