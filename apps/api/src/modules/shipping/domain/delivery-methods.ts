// The delivery methods a buyer can choose per seller order, as shipping sees them. `ordering`
// owns the same list for the order itself (modules do not import each other's domain); the
// values are the wire values, so the two lists are kept equal by `ordering`'s adapter test.

export const DELIVERY_METHODS = ['pickup', 'instant', 'same_day', 'scheduled'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const isDeliveryMethod = (value: unknown): value is DeliveryMethod =>
  typeof value === 'string' && (DELIVERY_METHODS as readonly string[]).includes(value);
