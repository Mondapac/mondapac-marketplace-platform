/** One settings card of the skeleton: how many setting rows it holds, and whether its heading has a description line. */
export interface SkeletonSection {
  readonly fields: number;
  readonly description?: boolean;
}

export interface SettingsSkeletonProps {
  /** The page's loading label for screen readers ("Loading Delivery settings"). */
  readonly label: string;
  /** The page's cards in order, each with its number of rows, so the skeleton has the page's shape. */
  readonly sections: readonly SkeletonSection[];
  /** Draw the title and description bars. False when the real header is already on the page. */
  readonly header?: boolean;
  /**
   * False before the show delay (200 ms): only the status is there, no bars, so a fast page never
   * flashes a skeleton. Drive it with `useDelayedLoading`.
   */
  readonly visible?: boolean;
  /** Loading for more than 10 s: `slowLabel` ("Still loading…") shows under the cards. */
  readonly slow?: boolean;
  readonly slowLabel?: string;
}

// Label and help bars vary a little from row to row, so the skeleton does not read as a grid.
const LABEL_WIDTHS = ['w-32', 'w-40', 'w-28', 'w-36'] as const;
const HELP_WIDTHS = ['w-56', 'w-48', 'w-64', 'w-52'] as const;

/**
 * Panel loading L3: the placeholder of a settings page while its values load. It has the page's
 * shape: a title bar, then one card per section with a heading bar and a label/field pair per
 * setting, laid out like `SettingRow` (the control column of 360 px once the card is 39rem wide,
 * stacked below that). There is no save bar: it appears only once the values are there. One
 * role="status" carries the label; the bars are decoration. With reduced motion they do not pulse.
 */
export function SettingsSkeleton({
  label,
  sections,
  header = true,
  visible = true,
  slow = false,
  slowLabel,
}: SettingsSkeletonProps) {
  return (
    <div className="flex flex-col gap-4" data-testid="settings-skeleton">
      {visible ? (
        <div aria-hidden="true" className="flex flex-col gap-4 motion-safe:animate-pulse">
          {header ? (
            <div className="flex flex-col gap-2" data-skeleton="header">
              <span className="h-8 w-56 max-w-full rounded-sm bg-muted" />
              <span className="h-4 w-full max-w-md rounded-sm bg-muted" />
            </div>
          ) : null}
          {sections.map((section, index) => (
            <div
              key={index}
              data-skeleton="section"
              className="@container min-w-0 rounded-lg border border-line bg-surface"
            >
              {/* Line boxes as tall as the real heading (text-base) and description (text-sm). */}
              <div className="flex flex-col gap-0.5 border-b border-line-row px-5 py-4">
                <span className="flex h-6 items-center">
                  <span className="h-4 w-40 max-w-full rounded-sm bg-muted" />
                </span>
                {section.description ? (
                  <span className="flex h-5 items-center">
                    <span className="h-3.5 w-72 max-w-full rounded-sm bg-muted" />
                  </span>
                ) : null}
              </div>
              {Array.from({ length: section.fields }, (_, row) => (
                <div
                  key={row}
                  data-skeleton="row"
                  className="grid gap-1.5 border-b border-line-row px-5 py-4 last:border-b-0 @[39rem]:grid-cols-[minmax(0,1fr)_22.5rem] @[39rem]:gap-6"
                >
                  {/* Label and help as text-sm line boxes, like SettingRow, so a stacked row keeps its height. */}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex h-5 items-center">
                      <span
                        className={`h-3.5 max-w-full rounded-sm bg-muted ${LABEL_WIDTHS[row % LABEL_WIDTHS.length]}`}
                      />
                    </span>
                    <span className="flex h-5 items-center">
                      <span
                        className={`h-3 max-w-full rounded-sm bg-muted ${HELP_WIDTHS[(row + index) % HELP_WIDTHS.length]}`}
                      />
                    </span>
                  </div>
                  <span className="h-(--mp-size-control) w-full rounded-md bg-muted" />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <div role="status">
        <span className="sr-only">{label}</span>
        {slow && slowLabel ? <p className="text-sm text-fg-muted">{slowLabel}</p> : null}
      </div>
    </div>
  );
}
