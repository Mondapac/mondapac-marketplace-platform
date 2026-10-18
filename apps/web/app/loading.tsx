import { getTranslations } from 'next-intl/server';

export default async function Loading() {
  const t = await getTranslations('route');
  return (
    <div role="status" aria-label={t('loading')} className="loading">
      <div className="skel banner" />
      <div className="grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skel card" />
        ))}
      </div>
    </div>
  );
}
