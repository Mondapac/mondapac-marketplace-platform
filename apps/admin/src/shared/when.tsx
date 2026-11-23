import { useLocale } from 'next-intl';
import { formatInstant, instantInZone } from './format.ts';

/** A date over its time, so a narrow column never breaks inside either. */
export function When({
  iso,
  missing,
  zone,
}: {
  readonly iso: string | null;
  readonly missing: string;
  /** Reads the instant on this IANA zone's clock; without it the UTC rule applies. */
  readonly zone?: string;
}) {
  const locale = useLocale();
  if (iso === null) return <span className="text-fg-muted">{missing}</span>;
  const text = zone === undefined ? formatInstant(iso, locale) : instantInZone(iso, locale, zone);
  const split = text.lastIndexOf(', ');
  if (split < 0) return <span className="whitespace-nowrap">{text}</span>;
  return (
    <span className="block">
      <span className="block whitespace-nowrap">{text.slice(0, split)}</span>
      <span className="block whitespace-nowrap text-xs text-fg-muted">{text.slice(split + 2)}</span>
    </span>
  );
}
