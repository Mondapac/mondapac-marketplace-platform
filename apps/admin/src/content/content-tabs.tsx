import { Tabs } from '@mondapac/ui';
import { SLIDES_PATH } from './slides/slide-types.ts';

/** The tabs of Content. Only Slides has shipped; the row is ready for the other tabs. */
export function ContentTabs({
  labels,
}: {
  readonly labels: { readonly nav: string; readonly slides: string };
}) {
  return (
    <div className="mb-4">
      <Tabs
        label={labels.nav}
        activeId="slides"
        items={[{ id: 'slides', href: SLIDES_PATH, label: labels.slides }]}
      />
    </div>
  );
}
