import 'server-only';
import { jsonLdText, type JsonLdNode } from './structured-data.ts';

/**
 * The structured data of a page, rendered on the server into the initial HTML. Nothing when
 * there is no node. React writes a script's text as is (no raw HTML injection needed);
 * {@link jsonLdText} has already escaped every character that could leave the script, so the
 * safety never rests on React's own `</script` handling.
 */
export function JsonLd({ data }: { readonly data: JsonLdNode | readonly JsonLdNode[] | null }) {
  if (data === null || (Array.isArray(data) && data.length === 0)) return null;
  return <script type="application/ld+json">{jsonLdText(data)}</script>;
}
