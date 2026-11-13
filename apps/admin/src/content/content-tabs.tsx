import { Tabs, type TabItem } from '@mondapac/ui';
import { NAVIGATION_PATH } from './navigation/nav-form.ts';
import { PAGES_PATH, PAGE_READ_PERMISSION } from './pages/page-types.ts';
import { SLIDES_PATH, SLIDE_READ_PERMISSION } from './slides/slide-types.ts';

/**
 * The tabs of Content: Pages, Navigation and Slides. Pages and Navigation are read with the page
 * read permission, Slides with its own.
 */
export function ContentTabs({
  active,
  permissionKeys,
  labels,
}: {
  readonly active: 'pages' | 'navigation' | 'slides';
  readonly permissionKeys: readonly string[];
  readonly labels: {
    readonly nav: string;
    readonly pages: string;
    readonly navigation: string;
    readonly slides: string;
  };
}) {
  const items: TabItem[] = [];
  if (permissionKeys.includes(PAGE_READ_PERMISSION)) {
    items.push({ id: 'pages', href: PAGES_PATH, label: labels.pages });
    items.push({ id: 'navigation', href: NAVIGATION_PATH, label: labels.navigation });
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
