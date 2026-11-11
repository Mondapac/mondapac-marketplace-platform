import { Tabs, type TabItem } from '@mondapac/ui';
import { PAGES_PATH, PAGE_READ_PERMISSION } from './pages/page-types.ts';
import { SLIDES_PATH, SLIDE_READ_PERMISSION } from './slides/slide-types.ts';

/**
 * The tabs of Content: Pages and Slides, each shown with its own read permission. The row is
 * ready for Navigation.
 */
export function ContentTabs({
  active,
  permissionKeys,
  labels,
}: {
  readonly active: 'pages' | 'slides';
  readonly permissionKeys: readonly string[];
  readonly labels: {
    readonly nav: string;
    readonly pages: string;
    readonly slides: string;
  };
}) {
  const items: TabItem[] = [];
  if (permissionKeys.includes(PAGE_READ_PERMISSION)) {
    items.push({ id: 'pages', href: PAGES_PATH, label: labels.pages });
  }
  if (permissionKeys.includes(SLIDE_READ_PERMISSION)) {
    items.push({ id: 'slides', href: SLIDES_PATH, label: labels.slides });
  }
  return (
    <div className="mb-4">
      <Tabs label={labels.nav} activeId={active} items={items} />
    </div>
  );
}
