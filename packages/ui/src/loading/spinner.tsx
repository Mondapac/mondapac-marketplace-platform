/**
 * Panel loading L1: the 14 px spinner of a busy button (and of an icon button, in place of its
 * icon). It is decoration: the button carries `aria-busy` and its in-progress label. With reduced
 * motion it stands still as a ring with a gap, so it still reads as "busy".
 */
export function Spinner({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-testid="spinner"
      className={`size-3.5 shrink-0 motion-safe:animate-spin ${className ?? ''}`}
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
