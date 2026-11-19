import qrcode from 'qrcode-generator';

/** Quiet zone around the symbol, in modules (the QR standard asks for four). */
const QUIET = 4;

/** The dark modules of a text as rows of booleans; null when it cannot be encoded. */
export function qrRows(text: string): boolean[][] | null {
  try {
    const code = qrcode(0, 'M');
    // The library reads one byte per character, so hand it the UTF-8 bytes.
    code.addData(String.fromCharCode(...new TextEncoder().encode(text)), 'Byte');
    code.make();
    const size = code.getModuleCount();
    return Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => code.isDark(r, c)),
    );
  } catch {
    return null;
  }
}

/** The SVG path of the dark modules, with the quiet zone as an offset; and the viewBox size. */
export function qrPath(rows: boolean[][]): { readonly path: string; readonly size: number } {
  const path = rows
    .flatMap((row, r) =>
      row.flatMap((dark, c) => (dark ? [`M${c + QUIET} ${r + QUIET}h1v1h-1z`] : [])),
    )
    .join('');
  return { path, size: rows.length + QUIET * 2 };
}

/**
 * The invite link as a QR code, drawn in the browser as plain SVG (no image request, no third
 * party: the link never leaves the page). Dark modules sit on the QR plate token, which is light
 * in both themes, because scanners need dark on light.
 */
export function InviteQr({
  text,
  label,
  pixels = 192,
}: {
  readonly text: string;
  readonly label: string;
  readonly pixels?: number;
}) {
  const rows = qrRows(text);
  if (rows === null) return null;
  const { path, size } = qrPath(rows);
  return (
    <div
      className="rounded-md p-2"
      style={{ background: 'var(--mp-color-bg-qr)', width: pixels + 16, maxWidth: '100%' }}
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
        width={pixels}
        height={pixels}
        className="aspect-square h-auto w-full"
        data-testid="invite-qr"
      >
        <path d={path} style={{ fill: 'var(--mp-color-bg-auth-showcase-seller)' }} />
      </svg>
    </div>
  );
}

/** The QR as a PNG file (white ground, black modules, 8 pixels a module), saved by the browser. */
export async function downloadQrPng(text: string, filename: string): Promise<boolean> {
  const rows = qrRows(text);
  if (rows === null) return false;
  const { path, size } = qrPath(rows);
  const scale = 8;
  const canvas = document.createElement('canvas');
  canvas.width = size * scale;
  canvas.height = size * scale;
  const context = canvas.getContext('2d');
  if (context === null) return false;
  // The panel's own QR tokens (light plate, dark modules); system colours if the page has none.
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  context.fillStyle = token('--mp-color-bg-qr', 'Canvas');
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = token('--mp-color-bg-auth-showcase-seller', 'CanvasText');
  for (const match of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    context.fillRect(Number(match[1]) * scale, Number(match[2]) * scale, scale, scale);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) return false;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
