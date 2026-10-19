import { CATEGORY_ART } from './category-art.tsx';
import { Icon, categoryIcon } from './icon.tsx';

/** A category's colour illustration, or its line icon when it has none. */
export function CategoryArt({ code }: { readonly code: string }) {
  const art = CATEGORY_ART[code];
  return art ? (
    <svg className="vec" viewBox="0 0 64 64" aria-hidden="true">
      {art}
    </svg>
  ) : (
    <Icon name={categoryIcon(code)} />
  );
}
