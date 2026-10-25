import { ICON_PATHS, type IconName } from './icon-paths.tsx';

/** One line icon of the storefront set. Decorative: the control around it carries the name. */
export function Icon({
  name,
  className,
}: {
  readonly name: IconName;
  readonly className?: string;
}) {
  // Chevrons point along the reading direction: the sheet mirrors them in right-to-left pages.
  const flip = name === 'chevl' || name === 'chevr' ? ' ico-flip' : '';
  return (
    <svg
      className={`ico${flip}${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** Category icon: unknown category codes fall back to the generic grid icon. */
export function categoryIcon(code: string): IconName {
  return code in ICON_PATHS ? (code as IconName) : 'grid';
}
