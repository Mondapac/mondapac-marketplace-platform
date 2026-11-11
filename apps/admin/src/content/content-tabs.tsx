import { Tabs } from '@mondapac/ui';
import { BLOG_PATH, BLOG_READ_PERMISSION } from '../blog/types.ts';
import { SLIDE_READ_PERMISSION, SLIDES_PATH } from './slides/slide-types.ts';

/**
 * The tabs of Content: Slides and Blog, each shown to a role that can read it. The Slides pages
 * pass no `permissionKeys` (their page already needs the Slides key) and see the Blog tab only
 * when they say what the role holds.
 */
export function ContentTabs({
  labels,
  active = 'slides',
  permissionKeys,
}: {
  readonly labels: { readonly nav: string; readonly slides: string; readonly blog?: string };
  readonly active?: 'slides' | 'blog';
  readonly permissionKeys?: readonly string[];
}) {
  const keys = new Set(permissionKeys ?? []);
  const items = [
    ...(permissionKeys === undefined || keys.has(SLIDE_READ_PERMISSION)
      ? [{ id: 'slides', href: SLIDES_PATH, label: labels.slides }]
      : []),
    ...(labels.blog !== undefined && keys.has(BLOG_READ_PERMISSION)
      ? [{ id: 'blog', href: BLOG_PATH, label: labels.blog }]
      : []),
  ];
  return (
    <div className="mb-4">
      <Tabs label={labels.nav} activeId={active} items={items} />
    </div>
  );
}
