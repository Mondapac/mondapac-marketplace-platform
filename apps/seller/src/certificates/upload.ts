import type { ApiFailure, ApiResult } from '../api/client.ts';

// A certificate file goes to the panel's own relay as base64 in a JSON body (the API's upload
// contract), on XMLHttpRequest rather than fetch so the page can show how far the upload is.
// The file never touches browser storage; the typed name of the file stays on the page only.

/** The file as base64 text, read in the browser; null when it cannot be read. */
export function readAsBase64(file: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const comma = text.indexOf(',');
      resolve(comma < 0 ? null : text.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * POSTs a JSON body to the relay and reports the share of the body sent (0 to 1). Once the body
 * is sent the server checks the file, so `onSent` tells the page to show "Checking this file…".
 */
export function postWithProgress<T>(
  path: string,
  body: unknown,
  csrfToken: string,
  onProgress: (share: number) => void,
  onSent: () => void,
): Promise<ApiResult<T>> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/${path}`);
    request.setRequestHeader('accept', 'application/json');
    request.setRequestHeader('content-type', 'application/json');
    request.setRequestHeader('x-csrf-token', csrfToken);
    request.withCredentials = true;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.upload.onload = () => onSent();
    request.onerror = () => resolve({ ok: false, failure: { status: 0, code: 'network' } });
    request.onabort = () => resolve({ ok: false, failure: { status: 0, code: 'network' } });
    request.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.responseText) as unknown;
      } catch {
        parsed = null;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve({ ok: true, status: request.status, body: parsed as T });
        return;
      }
      const failure = parsed as Partial<ApiFailure> | null;
      resolve({
        ok: false,
        failure: {
          status: request.status,
          code: typeof failure?.code === 'string' ? failure.code : 'unknown',
          ...(failure?.details === undefined ? {} : { details: failure.details }),
        },
      });
    };
    request.send(JSON.stringify(body));
  });
}

/** Bytes as "1.4 MB" (binary megabytes, as the API counts them) in the page's language. */
export function sizeText(bytes: number, locale: string): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'kilobyte',
      maximumFractionDigits: 0,
    }).format(Math.max(1, Math.round(bytes / 1024)));
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 1,
  }).format(mb);
}

/** The short kind of a media type for a file row ("PDF", "JPEG", "PNG"). */
export function mediaLabel(mediaType: string): string {
  switch (mediaType) {
    case 'application/pdf':
      return 'PDF';
    case 'image/jpeg':
      return 'JPEG';
    case 'image/png':
      return 'PNG';
    default:
      return mediaType.split('/').pop()?.toUpperCase() ?? mediaType;
  }
}

/** The kinds a limits list names, joined in the page's language ("JPEG, PNG or PDF"). */
export function mediaList(mediaTypes: readonly string[], locale: string): string {
  const labels = [...new Set(mediaTypes.map(mediaLabel))];
  return new Intl.ListFormat(locale, { type: 'disjunction' }).format(labels);
}
