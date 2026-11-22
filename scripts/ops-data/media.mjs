// Pictures the loader uploads through the API: store logos (initials on the store's colour), the
// scan of a sample certificate, and the storefront's placeholder product photos
// (apps/web/public/placeholders; the same photos the sample data showed). Drawn with the API's own
// `sharp` package, so the loader adds no dependency. Every upload is base64 text, as the panels send.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ROOT } from './guard.mjs';

const sharp = createRequire(resolve(ROOT, 'apps/api/package.json'))('sharp');

const escape = (text) =>
  text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const png = async (svg) => (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');

/** A 512 px square logo: the store's initials in white on its colour. */
export function logo(storeName, colour) {
  const initials = storeName
    .split(/\s+/)
    .filter((word) => /^[A-Z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0])
    .join('');
  return png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">` +
      `<rect width="512" height="512" rx="96" fill="${colour}"/>` +
      `<text x="256" y="300" font-family="sans-serif" font-size="200" font-weight="700" ` +
      `fill="#ffffff" text-anchor="middle">${escape(initials)}</text></svg>`,
  );
}

/** A plain A4-shaped scan of a sample certificate (marked SAMPLE; local test data only). */
export function certificateScan({ holder, number, issuer, issueDate, expiryDate }) {
  const lines = [
    ['SAMPLE CERTIFICATE (test data)', 44, 700],
    [issuer, 32, 600],
    [`Certificate holder: ${holder}`, 26, 400],
    [`Certificate number: ${number}`, 26, 400],
    [`Issued: ${issueDate}   Valid until: ${expiryDate}`, 26, 400],
  ];
  const text = lines
    .map(
      ([line, size, weight], index) =>
        `<text x="120" y="${260 + index * 110}" font-family="sans-serif" font-size="${size}" ` +
        `font-weight="${weight}" fill="#111827">${escape(line)}</text>`,
    )
    .join('');
  return png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754">` +
      `<rect width="1240" height="1754" fill="#ffffff"/>` +
      `<rect x="60" y="60" width="1120" height="1634" fill="none" stroke="#0f766e" stroke-width="8"/>` +
      `${text}</svg>`,
  );
}

/** A placeholder photo of the storefront, by name (apple, bread, meat, ...). */
export function placeholder(name) {
  return readFileSync(resolve(ROOT, 'apps/web/public/placeholders', `${name}.jpg`)).toString(
    'base64',
  );
}

/**
 * A 1600 x 600 slide picture: a placeholder photo on the right of a soft band of its own colours.
 * The slide's text carries the message, so the picture is decorative.
 */
export async function banner(name) {
  const photo = await sharp(resolve(ROOT, 'apps/web/public/placeholders', `${name}.jpg`))
    .resize(600, 600, { fit: 'cover' })
    .toBuffer();
  const { dominant } = await sharp(photo).stats();
  const tint = `rgb(${dominant.r},${dominant.g},${dominant.b})`;
  const band =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600">` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#ffffff"/>` +
    `<stop offset="1" stop-color="${tint}"/></linearGradient></defs>` +
    `<rect width="1600" height="600" fill="url(#g)"/></svg>`;
  const picture = await sharp(Buffer.from(band))
    .composite([{ input: photo, left: 1000, top: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
  return picture.toString('base64');
}
