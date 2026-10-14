// Shrinks a photo in the browser before it is sent (catalog slice 13). The server decodes and
// rewrites every upload anyway; this keeps the request small and drops the file's metadata
// (location, camera) on the seller's own device.

/** The longest side sent, in pixels. */
export const PHOTO_MAX_SIDE = 2048;
/** Files larger than this are not even decoded. */
export const PHOTO_MAX_INPUT_BYTES = 25 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

export type PreparedPhoto =
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

/** The photo as base64 JPEG text, at most {@link PHOTO_MAX_SIDE} pixels on its longest side. */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (file.size > PHOTO_MAX_INPUT_BYTES) return { kind: 'refused', reason: 'too-large' };
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
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
