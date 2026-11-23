export interface ChartStateProps {
  /** The height of the chart this stands in for, so the card does not jump. */
  readonly height?: number;
}

/** A chart whose period holds no data. Said in words ("All clear" style), never an empty axis. */
export function ChartEmpty({
  message,
  hint,
  height = 240,
}: ChartStateProps & { readonly message: string; readonly hint?: string }) {
  return (
    <div
      style={{ minHeight: height }}
      className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line p-3 text-center text-sm text-fg-muted"
    >
      <p>{message}</p>
      {hint === undefined ? null : <p className="text-xs">{hint}</p>}
    </div>
  );
}

/** A chart whose read failed: the error is in the card, in place of the chart, never a zero line. */
export function ChartError({
  message,
  retryLabel,
  onRetry,
  height = 240,
}: ChartStateProps & {
  readonly message: string;
  readonly retryLabel?: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      style={{ minHeight: height }}
      className="flex flex-col items-center justify-center gap-2 rounded-md border border-line text-sm text-critical-fg"
    >
      <p>{message}</p>
      {onRetry === undefined || retryLabel === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-11 items-center font-medium text-link underline lg:min-h-0"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** The placeholder of a chart while it loads: same height, with grid lines like the chart's. */
export function ChartSkeleton({ height = 240 }: ChartStateProps) {
  return (
    <div
      aria-hidden="true"
      data-skeleton="chart"
      style={{ height }}
      className="flex flex-col justify-between rounded-md motion-safe:animate-pulse"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="block h-px w-full bg-chart-grid" />
      ))}
    </div>
  );
}
