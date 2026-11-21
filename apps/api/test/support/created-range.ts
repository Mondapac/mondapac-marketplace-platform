import { Temporal } from '@mondapac/shared-kernel';

/** The created range of a list filter, as the stores take it: `createdFrom` inclusive, `createdTo` exclusive. */
export interface CreatedRange {
  readonly createdFrom?: Temporal.Instant | null;
  readonly createdTo?: Temporal.Instant | null;
}

/** Whether a row created at `createdAt` is inside the range of the filter. */
export function inCreatedRange(createdAt: Temporal.Instant, filter: CreatedRange): boolean {
  return (
    (filter.createdFrom == null || Temporal.Instant.compare(createdAt, filter.createdFrom) >= 0) &&
    (filter.createdTo == null || Temporal.Instant.compare(createdAt, filter.createdTo) < 0)
  );
}
