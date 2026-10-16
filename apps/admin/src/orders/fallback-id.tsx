import { shortId } from '../shared/short-id.ts';

/**
 * An id shown where a name is missing (no customer permission, or the API had none): muted
 * monospace so it never reads as a real name. The full id is the tooltip.
 */
export function FallbackId({ id }: { readonly id: string }) {
  return (
    <span className="font-mono text-xs tabular-nums text-fg-muted" title={id}>
      {shortId(id)}
    </span>
  );
}

/** A full id as a value in a detail row: small, muted, breaking anywhere so it wraps tidily. */
export function FullId({ id }: { readonly id: string }) {
  return <span className="font-mono text-xs break-all text-fg-muted">{id}</span>;
}
