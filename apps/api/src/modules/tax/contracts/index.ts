// Public contracts of the tax module (ADR-0008): the facade interface and the permission keys.
// Other modules may import only what this file exports, through ../index.ts.
export { TAX_AUDIT_ACTIONS } from '../domain/audit';
export { TAX_PERMISSIONS, TAX_STRATEGY_MANAGE, TAX_STRATEGY_VIEW } from './permissions';
export {
  TAX_FACADE,
  type TaxAnswer,
  type TaxFacade,
  type RefundChargeInput,
  type RefundLineInput,
  type RefundTaxAnswer,
  type TaxFailure,
  type TaxLineAnswer,
  type TaxLineInput,
} from './tax.facade';
