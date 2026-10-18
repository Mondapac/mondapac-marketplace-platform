import Link from 'next/link';
import { ICON_PATHS } from '../icons/icon-paths.tsx';

export function Logo({ name, href }: { readonly name: string; readonly href?: string }) {
  const mark = (
    <>
      <i>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {ICON_PATHS.leaf}
        </svg>
      </i>
      {name}
    </>
  );
  return href ? (
    <Link href={href} className="logo">
      {mark}
    </Link>
  ) : (
    <div className="logo">{mark}</div>
  );
}
