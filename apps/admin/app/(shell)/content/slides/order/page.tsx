import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { ContentNoAccess } from '../../../../../src/content/content-no-access.tsx';
import { ContentTabs } from '../../../../../src/content/content-tabs.tsx';
import { placeFromSearch, orderPageHref } from '../../../../../src/content/slides/slide-order.ts';
import { SlideOrderView } from '../../../../../src/content/slides/slide-order-view.tsx';
import {
  SLIDE_EDIT_PERMISSION,
  SLIDE_READ_PERMISSION,
} from '../../../../../src/content/slides/slide-types.ts';
import { SlidesViewSwitch } from '../../../../../src/content/slides/slides-view-switch.tsx';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';
import { displayZone } from '../../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('slides.order.page-title') };
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The live slides of one position in the order buyers see them, movable with the edit permission. */
export default async function SlideOrderPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone, csrfToken } = gate.session;
  if (!permissionKeys.includes(SLIDE_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  const place = placeFromSearch({
    position: first(query.position),
    scope: first(query.scope),
    scopeId: first(query.scopeId),
  });
  const title = t('content.title');
  return (
    <AdminShell session={gate.session} activeId="content" title={title}>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('content.intro')}</p>
      </div>
      <ContentTabs labels={{ nav: t('content.tabs.label'), slides: t('content.tabs.slides') }} />
      <div className="mb-4">
        <SlidesViewSwitch
          active="order"
          orderHref={orderPageHref(place)}
          labels={{
            nav: t('content.slides.view.label'),
            all: t('content.slides.view.all'),
            order: t('content.slides.view.order'),
          }}
        />
      </div>
      <SlideOrderView
        key={orderPageHref(place)}
        place={place}
        canEdit={permissionKeys.includes(SLIDE_EDIT_PERMISSION)}
        csrfToken={csrfToken}
        zone={displayZone(timezone)}
      />
    </AdminShell>
  );
}
