import { useId, type ReactNode } from 'react';

export interface SettingsSectionProps {
  readonly title: string;
  /** One line under the heading. */
  readonly description?: string;
  /**
   * A "Danger zone": critical-toned heading and edge. Its actions confirm for themselves and are
   * not part of the page's save bar.
   */
  readonly variant?: 'default' | 'danger';
  /** `SettingRow`s. */
  readonly children: ReactNode;
}

/**
 * A card of settings: a heading (h2), one line of description, then rows. It is the size
 * container its rows lay out against.
 */
export function SettingsSection({
  title,
  description,
  variant = 'default',
  children,
}: SettingsSectionProps) {
  const headingId = useId();
  const danger = variant === 'danger';
  return (
    <section
      aria-labelledby={headingId}
      data-variant={variant}
      className={`@container min-w-0 rounded-lg border bg-surface ${danger ? 'border-critical-border' : 'border-line'}`}
    >
      <header className="border-b border-line-row px-5 py-4">
        <h2
          id={headingId}
          className={`text-base font-semibold ${danger ? 'text-critical-fg' : 'text-fg'}`}
        >
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-fg-muted">{description}</p> : null}
      </header>
      <div>{children}</div>
    </section>
  );
}
