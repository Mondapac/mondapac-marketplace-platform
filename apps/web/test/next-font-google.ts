// next/font/google is a build-time transform; outside the Next.js compiler the real module throws.
// The stand-in returns the same shape (a class name that sets the CSS variable) so tests can see
// which font variables a page carries.
const font = (name: string) => (options: { variable: string }) => ({
  className: `${name}-class`,
  variable: `${name}-var`,
  style: { fontFamily: options.variable },
});

export const Figtree = font('figtree');
export const Plus_Jakarta_Sans = font('jakarta');
export const Vazirmatn = font('vazirmatn');
export const Noto_Sans_Arabic = font('noto-arabic');
