// Violation (no-market-or-vertical-literal): a certification type is data of certification,
// not a branch in catalog.
export function violation(typeCode: string): boolean {
  return typeCode === 'kosher' || typeCode === `VEGAN`;
}
