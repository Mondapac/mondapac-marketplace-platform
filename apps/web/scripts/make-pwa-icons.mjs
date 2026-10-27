// Generates the placeholder PWA icons in public/icons from the storefront's own leaf mark
// (src/icons/icon-paths.tsx) on the default palette's teal. Run once, by hand; the PNGs are
// committed. `sharp` is not a dependency of apps/web, so point NODE_PATH at an install of it:
//   NODE_PATH=<path to a node_modules containing sharp> node apps/web/scripts/make-pwa-icons.mjs
// The real brand icon replaces these when the owner chooses the brand name.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const TEAL = '#0e5a57';
const out = new URL('../public/icons/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

// The leaf is drawn on a 24-unit grid; `scale` sets how much of the canvas it fills, centred.
function svg(size, scale) {
  const s = (size * scale) / 24;
  const o = (size - 24 * s) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<rect width="${size}" height="${size}" fill="${TEAL}"/>` +
      `<g transform="translate(${o} ${o}) scale(${s})" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19c3-5 6-8 10-10"/></g></svg>`,
  );
}

const files = [
  ['icon-192.png', 192, 0.62],
  ['icon-512.png', 512, 0.62],
  // Maskable: the mark stays inside the central 80% safe zone.
  ['icon-512-maskable.png', 512, 0.5],
  ['apple-touch-icon.png', 180, 0.62],
];
for (const [name, size, scale] of files) {
  await sharp(svg(size, scale))
    .png()
    .toFile(out + name);
  console.log('wrote', name);
}
