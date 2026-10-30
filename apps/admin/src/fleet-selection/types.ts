// Answers of the admin fleet-selection routes (apps/api fleet-selection.controller.ts).

export const FLEET_VIEW_PERMISSION = 'shipping.fleet-selection.view';
export const FLEET_MANAGE_PERMISSION = 'shipping.fleet-selection.manage';
export const FLEET_SELECTION_PATH = 'shipping/admin/fleet-selection';

export const FLEET_CODES = [
  'mondapac_drive',
  'uber_direct',
  'zoom2u',
  'doordash_drive',
  'auspost',
  'fake_test',
] as const;
export type FleetCode = (typeof FLEET_CODES)[number];

export const METHODS = ['instant', 'same_day', 'scheduled'] as const;
export type Method = (typeof METHODS)[number];

export const KINDS = ['cheapest', 'weighted', 'fixed_priority'] as const;
export type Kind = (typeof KINDS)[number];

export interface Weights {
  readonly price: number;
  readonly eta: number;
  readonly reliability: number;
}

export interface Rule {
  readonly kind: Kind;
  readonly weights?: Weights;
  readonly order?: readonly FleetCode[];
}

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly rule: Rule;
  /** Rises with each edit; sent back as `expectedVersion`. */
  readonly version: number;
}

export interface FleetRow {
  readonly fleet: FleetCode;
  readonly displayName: string;
  /** False when no adapter is installed or the Market has the fleet off. */
  readonly enabled: boolean;
  readonly methods: readonly Method[];
  /** The admin-set score, or null while none is set. */
  readonly reliability: number | null;
  /** The score the router uses: the admin-set one, else the neutral default. */
  readonly effectiveReliability: number;
}

export interface Selection {
  readonly models: readonly Model[];
  readonly active: Readonly<Record<Method, string | null>>;
  readonly defaultOrder: readonly FleetCode[];
  readonly fleets: readonly FleetRow[];
}
