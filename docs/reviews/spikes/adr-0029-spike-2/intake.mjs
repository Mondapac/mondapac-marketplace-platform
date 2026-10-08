// Spike 2 (ADR-0029 decisions 7 and 8): the image path of the intake child. Reads one file,
// prints one JSON line. Run inside bwrap with an address-space limit by run.sh.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
const [,, file] = process.argv;
const t0 = process.hrtime.bigint();
const out = (o) => { console.log(JSON.stringify({ file: process.env.F ?? file, ms: Number((process.hrtime.bigint() - t0) / 1000000n), rssMB: Math.round(process.resourceUsage().maxRSS / 1024), ...o })); };
const buf = readFileSync(file);
const type = buf.subarray(0, 4).toString('latin1') === 'GIF8' ? 'gif' : (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') ? 'webp' : buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'jpeg'
  : buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : null;
if (!type) { out({ result: 'refused', code: 'file.type' }); process.exit(0); }
if (type === 'png' && buf.includes(Buffer.from('acTL'))) { out({ result: 'refused', code: 'file.frames', why: 'apng acTL chunk' }); process.exit(0); }
const end = type === 'gif' || type === 'webp' ? null : type === 'jpeg' ? Buffer.from([0xff, 0xd9]) : Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
if (end && !buf.subarray(buf.length - end.length).equals(end)) { out({ result: 'refused', code: 'file.polyglot' }); process.exit(0); }
try {
  sharp.cache(false); sharp.concurrency(1);
  const meta = await sharp(buf, { limitInputPixels: 40_000_000, sequentialRead: true, failOn: 'error' }).metadata();
  if ((meta.pages ?? 1) > 1) { out({ result: 'refused', code: 'file.frames', pages: meta.pages }); process.exit(0); }
  if (Math.max(meta.width, meta.height) > 12000) { out({ result: 'refused', code: 'file.dimensions', w: meta.width, h: meta.height }); process.exit(0); }
  const res = await sharp(buf, { limitInputPixels: 40_000_000, sequentialRead: true, failOn: 'error' })
    .rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb').jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
  const m2 = await sharp(res.data).metadata();
  out({ result: 'clean', bytes: res.data.length, w: res.info.width, h: res.info.height, hasExif: !!m2.exif, hasIcc: !!m2.icc, hasXmp: !!m2.xmp });
} catch (e) { out({ result: 'refused', code: 'file.decode', error: String(e.message).slice(0, 90) }); }
