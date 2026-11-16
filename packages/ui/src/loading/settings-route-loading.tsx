'use client';

import { LoadError } from '../form/load-error.tsx';
import { RouteLoading } from '../shell/route-states.tsx';
import { SettingsSkeleton, type SkeletonSection } from './settings-skeleton.tsx';
import { useDelayedLoading } from './use-delayed-loading.ts';

export interface SettingsRouteLoadingProps {
  /** The page's loading label ("Loading Delivery settings"). */
  readonly label: string;
  /** The saved sidebar choice, so the frame matches the shell. */
  readonly collapsed?: boolean;
  /**
   * The page sits in the settings layout (the sub-navigation column from 1180 px, "Back to
   * Settings" below it). False for a settings-style page outside /settings.
   */
  readonly subNav?: boolean;
  /** The page's cards and their row counts. */
  readonly sections: readonly SkeletonSection[];
  /** "Still loading…", shown after 10 s. */
  readonly slowLabel: string;
  /** What shows in place of the skeleton after 30 s: a load error with Try again (reloads the page). */
  readonly stalled: {
    readonly title?: string;
    readonly message: string;
    readonly retryLabel: string;
  };
}

/**
 * Panel loading L3: the loading.tsx of a settings route. The shell frame (sidebar, topbar), the
 * settings column layout (the sub-navigation column from 1180 px, the "Back to Settings" line
 * below it) and the page's form skeleton. Nothing but the frame shows for the first 200 ms; at
 * 10 s "Still loading…" is added; at 30 s the skeleton gives way to a load error.
 */
export function SettingsRouteLoading({
  label,
  collapsed = false,
  subNav = true,
  sections,
  slowLabel,
  stalled,
}: SettingsRouteLoadingProps) {
  const loading = useDelayedLoading(true);
  const body = loading.stalled ? (
    <LoadError
      title={stalled.title}
      message={stalled.message}
      retryLabel={stalled.retryLabel}
      className="w-full"
    />
  ) : (
    <SettingsSkeleton
      label={label}
      sections={sections}
      visible={loading.visible}
      slow={loading.slow}
      slowLabel={slowLabel}
    />
  );
  if (!subNav) {
    return (
      <RouteLoading label={label} collapsed={collapsed} busy={!loading.stalled}>
        {body}
      </RouteLoading>
    );
  }
  return (
    <RouteLoading label={label} collapsed={collapsed} busy={!loading.stalled}>
      <div className="grid grid-cols-1 gap-6 min-[1180px]:grid-cols-[13.75rem_minmax(0,1fr)] min-[1180px]:items-start">
        <div aria-hidden="true" className="hidden min-[1180px]:block" data-skeleton="sub-nav">
          {loading.visible && !loading.stalled ? (
            <div className="flex flex-col gap-3 motion-safe:animate-pulse">
              {[4, 3].map((links, group) => (
                <div key={group} className="flex flex-col gap-2.5">
                  <span className="h-3 w-20 rounded-sm bg-muted" />
                  {Array.from({ length: links }, (_, link) => (
                    <span
                      key={link}
                      className={`h-4 rounded-sm bg-muted ${link % 2 === 0 ? 'w-36' : 'w-28'}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="min-w-0">
          <div
            aria-hidden="true"
            className="mb-2 flex h-12 items-center md:h-5 min-[1180px]:hidden"
          >
            {loading.visible && !loading.stalled ? (
              <span className="h-3.5 w-32 rounded-sm bg-muted motion-safe:animate-pulse" />
            ) : null}
          </div>
          {body}
        </div>
      </div>
    </RouteLoading>
  );
}
