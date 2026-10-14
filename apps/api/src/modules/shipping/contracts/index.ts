// Public contracts of the shipping module (ADR-0008): the facade interface and the permission
// keys. Other modules may import only what this file exports, through ../index.ts.
export { SHIPPING_AUDIT_ACTIONS } from '../domain/audit';
export {
  SHIPPING_FLAT_FEE_MANAGE,
  SHIPPING_FLAT_FEE_VIEW,
  SHIPPING_OWN_FEE_VIEW,
  SHIPPING_PERMISSIONS,
} from './permissions';
export {
  SHIPPING_FACADE,
  type FlatFeeMap,
  type ShippingFacade,
  type ShippingFailure,
} from './shipping.facade';
