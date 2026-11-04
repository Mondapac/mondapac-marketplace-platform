// next/font/local is a build-time transform; outside the Next.js compiler the real module throws.
// The stand-in returns the same shape (a class name that sets the CSS variable) so tests can see
// which font variables a page carries. The short name comes from the CSS variable (--font-NAME).
export default function localFont(options: { variable: string }) {
  const name = options.variable.replace(/^--font-/, '');
  return {
    className: `${name}-class`,
    variable: `${name}-var`,
    style: { fontFamily: options.variable },
  };
}
