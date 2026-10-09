// Public contracts of the inventory module (ADR-0008): event types, the permission catalogue and
// the facade interface. Other modules may import only what this file exports, through ../index.ts.
export {
  INVENTORY_PERMISSIONS,
  INVENTORY_SOURCE_EDIT,
  INVENTORY_STOCK_EDIT,
  INVENTORY_STOCK_VIEW,
} from './permissions';
export {
  INVENTORY_FACADE,
  MAX_AVAILABILITY_BATCH,
  sellUnitKeyOf,
  type AvailabilityMap,
  type InventoryBatchTooLarge,
  type InventoryFacade,
  type InventoryValidationFailed,
  type SellUnitAvailability,
  type SellUnitKey,
} from './inventory.facade';
