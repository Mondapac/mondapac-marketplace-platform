// Public contracts of the pricing module (ADR-0008): event types, the permission catalogue and
// the audited actions. Other modules may import only what this file exports, through ../index.ts.
// Event definitions are declared in domain/events/ and re-exported here (ADR-0006 decision 6);
// audited actions in domain/audit/ (docs/design/domain/platform-audit.md 3.2). No Cost type is
// reachable from this file (pricing design 6.5). The facade arrives with slice 2.
export {
  EffectivePriceChanged,
  PriceHoldDecided,
  PriceHoldOpened,
  PRICING_EVENTS,
} from '../domain/events';
export { PRICING_AUDIT_ACTIONS } from '../domain/audit';
export {
  PRICING_COST_VIEW,
  PRICING_PERMISSIONS,
  PRICING_PRICE_EDIT,
  PRICING_PRICE_VIEW,
} from './permissions';
