// Shrinks a category image in the browser before it is sent (categories package C3c), as the
// seller panel does for product photos (apps/seller/src/catalog/photo-prepare.ts; the panels share
// no code but packages/ui). The server decodes and rewrites every upload anyway; this keeps the
// request under its 4 MiB cap and drops the file's metadata on the admin's own device.

/** The longest side sent, in pixels. */
export const IMAGE_MAX_SIDE = 2048;
/** Files larger than this are not even decoded. */
export const IMAGE_MAX_INPUT_BYTES = 25 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

export type PreparedImage =
  | { readonly kind: 'ready'; readonly data: string }
  | { readonly kind: 'refused'; readonly reason: 'too-large' | 'unreadable' };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** The picture as base64 JPEG text, at most {@link IMAGE_MAX_SIDE} pixels on its longest side. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > IMAGE_MAX_INPUT_BYTES) return { kind: 'refused', reason: 'too-large' };
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return { kind: 'refused', reason: 'unreadable' };
    // Transparent pixels become white, as the server does.
    context.fillStyle = 'white';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (blob === null) return { kind: 'refused', reason: 'unreadable' };
    return { kind: 'ready', data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
  } catch {
    return { kind: 'refused', reason: 'unreadable' };
  }
}
