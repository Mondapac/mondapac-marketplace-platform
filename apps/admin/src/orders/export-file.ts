// Downloads the order list as a CSV file through this panel's own relay (same origin only).

export type ExportOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'session' | 'too-large' | 'invalid' | 'unavailable';
      readonly matching?: number;
      readonly max?: number;
    };

/**
 * Asks the relay for the file of the list as filtered (`query` is the export's query string, no
 * leading `?`) and hands it to the browser as a download. A refusal comes back as a reason the
 * page can word; nothing is saved then.
 */
export async function downloadOrders(path: string, query: string): Promise<ExportOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}${query === '' ? '' : `?${query}`}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!response.ok) {
    if (response.status === 401) return { ok: false, reason: 'session' };
    const body = (await response.json().catch((): unknown => null)) as {
      code?: string;
      details?: { max?: number; matching?: number };
    } | null;
    if (response.status === 413 && body?.code === 'batch.too-large') {
      return {
        ok: false,
        reason: 'too-large',
        matching: body.details?.matching,
        max: body.details?.max,
      };
    }
    return { ok: false, reason: response.status === 400 ? 'invalid' : 'unavailable' };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
    `orders-${new Date().toISOString().slice(0, 10)}.csv`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { ok: true };
}
