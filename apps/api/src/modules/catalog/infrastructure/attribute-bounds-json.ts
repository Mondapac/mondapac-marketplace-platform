import type { AttributeBounds } from '../domain/attribute-definition';

/**
 * The `bounds` object of a revision as it is stored: plain JSON with no undefined member, and a
 * measure's unit list as a mutable array (Prisma's JSON input does not take a readonly one).
 */
export function boundsJson(bounds: AttributeBounds): {
  maxLength?: number;
  min?: number;
  max?: number;
  measure?: { dimension: string; units: string[]; defaultUnit: string; decimals: number };
} {
  return {
    ...(bounds.maxLength === undefined ? {} : { maxLength: bounds.maxLength }),
    ...(bounds.min === undefined ? {} : { min: bounds.min }),
    ...(bounds.max === undefined ? {} : { max: bounds.max }),
    ...(bounds.measure === undefined
      ? {}
      : {
          measure: {
            dimension: bounds.measure.dimension,
            units: [...bounds.measure.units],
            defaultUnit: bounds.measure.defaultUnit,
            decimals: bounds.measure.decimals,
          },
        }),
  };
}
