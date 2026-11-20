export const useRouter = () => ({ push: () => undefined, replace: () => undefined });
export const usePathname = () => '/earnings';
export const useSearchParams = () => new URLSearchParams(globalThis.location.search);
