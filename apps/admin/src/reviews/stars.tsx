import { useTranslations } from 'next-intl';

/** Stars with a text alternative; colour is never the only signal (the number is in the name). */
export function Stars({ rating }: { readonly rating: number }) {
  const t = useTranslations('reviews-moderation');
  return (
    <span role="img" aria-label={t('stars', { rating })} className="whitespace-nowrap">
      <span aria-hidden="true">
        {'★'.repeat(rating)}
        {'☆'.repeat(5 - rating)}
      </span>
    </span>
  );
}
