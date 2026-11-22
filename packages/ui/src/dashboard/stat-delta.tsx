export interface StatDeltaProps {
  /** The change, already formatted and signed ("+12.4%", "-3 pts"). "n/a" when the base is zero or tiny. */
  readonly value: string;
  readonly direction: 'up' | 'down' | 'flat';
  /**
   * Whether the change is better or worse for the business. The colour follows this, not the
   * direction: more refunds point up and are bad.
   */
  readonly sentiment: 'good' | 'bad' | 'neutral';
  /** What it is compared with ("vs previous 30 days"), also read to screen readers. */
  readonly comparedWith: string;
}

const COLOUR = {
  good: 'text-success-fg',
  bad: 'text-critical-fg',
  neutral: 'text-fg-muted',
} as const;
const ARROW = { up: '▲', down: '▼', flat: '–' } as const;
const WORD = { good: 'better', bad: 'worse', neutral: 'no judgement' } as const;

/**
 * The change line of a stat card. Never colour alone: the arrow and the signed value say the
 * direction, and a screen reader hears whether it is better or worse.
 */
export function StatDelta({ value, direction, sentiment, comparedWith }: StatDeltaProps) {
  return (
    <span
      className={`flex flex-wrap items-center gap-x-1.5 text-xs font-medium ${COLOUR[sentiment]}`}
    >
      <span aria-hidden="true">{value === 'n/a' ? '' : ARROW[direction]}</span>
      <span>{value}</span>
      <span className="sr-only">
        {value === 'n/a' ? comparedWith : `${WORD[sentiment]}, ${comparedWith}`}
      </span>
      <span aria-hidden="true" className="font-normal text-fg-muted">
        {comparedWith}
      </span>
    </span>
  );
}
