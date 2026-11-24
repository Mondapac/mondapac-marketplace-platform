import { z } from 'zod';

/**
 * A region code as reporting stores it (`reporting.seller_orders.delivery_state`): 1 to 3 capital
 * letters or digits, the form of an ISO 3166-2 subdivision suffix (AU `QLD`, NZ `AUK`).
 */
export const REPORT_REGION_CODE = /^[A-Z0-9]{1,3}$/u;

/** One bound of a postcode range: 1 to 10 capital letters or digits. */
const postcodeBound = z.string().regex(/^[0-9A-Z]{1,10}$/u, 'must be 1 to 10 letters or digits');

/**
 * The `shipping.postcodeRegions` section (dashboards v2, phase 1): the region (state) each postcode
 * falls in, as closed ranges `[from, to]` per region code. A postcode matches a range when it has
 * the same length as its bounds and sorts between them (character by character, so `0800` to
 * `0999` holds the four-digit postcodes from 0800 to 0999). Two ranges of one length must not
 * overlap: a postcode has at most one region. A postcode in no range has no region (unknown).
 *
 * It is Market configuration, never code: core modules hold no country's postcode table.
 */
export const postcodeRegionsSchema = z
  .record(
    z.string().regex(REPORT_REGION_CODE, 'a region code is 1 to 3 capital letters or digits'),
    z
      .array(
        z
          .tuple([postcodeBound, postcodeBound])
          .refine(
            ([from, to]) => from.length === to.length && from <= to,
            'a range is [from, to] of one length with from <= to',
          ),
      )
      .min(1)
      .max(50),
  )
  .refine((table) => Object.keys(table).length <= 100, 'at most 100 regions')
  .superRefine((table, context) => {
    const ranges = Object.entries(table).flatMap(([region, list]) =>
      list.map(([from, to]) => ({ region, from, to })),
    );
    for (let i = 0; i < ranges.length; i += 1) {
      for (let j = i + 1; j < ranges.length; j += 1) {
        const a = ranges[i]!;
        const b = ranges[j]!;
        if (a.from.length === b.from.length && a.from <= b.to && b.from <= a.to) {
          context.addIssue({
            code: 'custom',
            message: `the ranges ${a.from}-${a.to} (${a.region}) and ${b.from}-${b.to} (${b.region}) overlap`,
          });
          return;
        }
      }
    }
  });

export type PostcodeRegions = Readonly<z.infer<typeof postcodeRegionsSchema>>;

/**
 * The region of `postcode` in `table`, or null when no range holds it (or the Market has no
 * table). The postcode is compared as given: the caller passes one already checked against the
 * Market's postcode pattern.
 */
export function regionOfPostcode(
  table: PostcodeRegions | undefined,
  postcode: string,
): string | null {
  if (table === undefined) return null;
  for (const [region, ranges] of Object.entries(table)) {
    for (const [from, to] of ranges) {
      if (postcode.length === from.length && from <= postcode && postcode <= to) return region;
    }
  }
  return null;
}
