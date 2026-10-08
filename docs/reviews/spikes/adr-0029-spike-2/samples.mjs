/* eslint-disable -- spike script (evidence), see ../README.md */
import sharp from 'sharp';
import { writeFileSync, readFileSync } from 'node:fs';
const base = { create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 30, b: 30 } } };
// normal JPEG with EXIF (GPS) and an embedded ICC-ish profile request
const exif = { IFD0: { Copyright: 'seller-private', Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '27/1 28/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '153/1 1/1 0/1' } };
const jpeg = await sharp(base).jpeg().withExif(exif).toBuffer();
writeFileSync('ok-exif.jpg', jpeg);
// polyglot: JPEG followed by a zip-ish payload; and PNG + trailing bytes
writeFileSync('poly-jpeg-zip.jpg', Buffer.concat([jpeg, Buffer.from('PK\x03\x04 hidden payload')]));
const png = await sharp(base).png().toBuffer();
writeFileSync('ok.png', png);
writeFileSync('poly-png-trailer.png', Buffer.concat([png, Buffer.from('<script>alert(1)</script>')]));
// leading junk before signature
writeFileSync('junk-prefix.jpg', Buffer.concat([Buffer.from('GIF89a'), jpeg]));
// huge-pixel jpeg (49 MP, solid colour compresses small) and 13000-px edge
writeFileSync('big-49mp.jpg', await sharp({ create: { width: 7000, height: 7000, channels: 3, background: '#888' } }).jpeg({ quality: 20 }).toBuffer());
writeFileSync('wide-13000.jpg', await sharp({ create: { width: 13000, height: 100, channels: 3, background: '#888' } }).jpeg().toBuffer());
// multi-frame: animated webp and gif (3 frames)
const frame = (c) => sharp({ create: { width: 64, height: 64, channels: 3, background: c } }).raw().toBuffer();
const frames = Buffer.concat([await frame('#f00'), await frame('#0f0'), await frame('#00f')]);
const anim = { raw: { width: 64, height: 64 * 3, channels: 3 }, pageHeight: 64 };
writeFileSync('anim.webp', await sharp(frames, { raw: { width: 64, height: 192, channels: 3 } }).webp({ loop: 0 }).toBuffer().catch(() => Buffer.alloc(0)));
writeFileSync('anim.gif', await sharp(frames, { raw: { width: 64, height: 192, channels: 3, pageHeight: 64 } }).gif({ loop: 0 }).toBuffer().catch((e) => { console.error('gif gen', e.message); return Buffer.alloc(0); }));
writeFileSync('not-image.jpg', Buffer.from('<html>not an image</html>'));
writeFileSync('truncated.jpg', jpeg.subarray(0, 300));
console.log('samples written');
