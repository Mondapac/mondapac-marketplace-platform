import { useTranslations } from 'next-intl';
import { ISSUER_STATES } from './types.ts';

/** The state filter as links, so the page stays server-rendered and the filter lives in the URL. */
export function StateFilter({ active }: { readonly active: string | null }) {
  const t = useTranslations('certificates.issuers');
  const items = [null, ...ISSUER_STATES];
  return (
    <nav aria-label={t('filter.label')} className="flex flex-wrap gap-2">
      {items.map((state) => {
        const current = state === active;
        return (
          <a
            key={state ?? 'all'}
            href={state === null ? '/certificates/issuers' : `/certificates/issuers?state=${state}`}
            aria-current={current ? 'true' : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${current ? 'border-link font-medium text-link' : 'border-line text-fg-muted'}`}
          >
            {state === null ? t('filter.all') : t(`state.${state}`)}
          </a>
        );
      })}
    </nav>
  );
}
