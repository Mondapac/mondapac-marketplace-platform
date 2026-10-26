import { LinkButton, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { ContentNoAccess } from '../../../../src/content/content-no-access.tsx';
import { ContentTabs } from '../../../../src/content/content-tabs.tsx';
import {
  NEW_SLIDE_PATH,
  SLIDE_EDIT_PERMISSION,
  SLIDE_READ_PERMISSION,
} from '../../../../src/content/slides/slide-types.ts';
import { SlidesList } from '../../../../src/content/slides/slides-list.tsx';
import { SlidesViewSwitch } from '../../../../src/content/slides/slides-view-switch.tsx';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import { displayZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('title') };
}

export default async function SlidesPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone, csrfToken } = gate.session;
  if (!permissionKeys.includes(SLIDE_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  const title = t('content.title');
  return (
    <AdminShell session={gate.session} activeId="content" title={title}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-fg-muted">{t('content.intro')}</p>
        </div>
        {permissionKeys.includes(SLIDE_EDIT_PERMISSION) ? (
          <LinkButton href={NEW_SLIDE_PATH}>{t('content.slides.new')}</LinkButton>
        ) : null}
      </div>
      <ContentTabs labels={{ nav: t('content.tabs.label'), slides: t('content.tabs.slides') }} />
      <div className="mb-4">
        <SlidesViewSwitch
          active="all"
          labels={{
            nav: t('content.slides.view.label'),
            all: t('content.slides.view.all'),
            order: t('content.slides.view.order'),
          }}
        />
      </div>
      <SlidesList
        permissionKeys={permissionKeys}
        zone={displayZone(timezone)}
        csrfToken={csrfToken}
      />
    </AdminShell>
  );
}
