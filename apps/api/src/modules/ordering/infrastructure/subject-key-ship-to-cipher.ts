import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { ShipToCipher } from '../application/ports/ship-to-cipher';
import type { ShipTo } from '../domain/order';

/** The label the sealed address of an order is bound to (platform subject keys, PF 4 row 3). */
export const SHIP_TO_LABEL = fieldLabel('ordering.order.ship-to');

const FIELDS = [
  'recipientFirstName',
  'recipientLastName',
  'phone',
  'line1',
  'line2',
  'suburb',
  'region',
  'postcode',
  'deliveryNotes',
  'countryCode',
] as const satisfies readonly (keyof ShipTo)[];
const NULLABLE: ReadonlySet<string> = new Set(['line2', 'region', 'deliveryNotes']);

/**
 * The canonical JSON that is sealed: the fields in a fixed order, then the seller notes when
 * there are any (an order without notes seals exactly what it sealed before notes existed).
 */
export const shipToJson = (shipTo: ShipTo): string => {
  const fields: [string, unknown][] = FIELDS.map((key) => [key, shipTo[key]]);
  const notes = shipTo.sellerNotes ?? {};
  if (Object.keys(notes).length > 0) fields.push(['sellerNotes', notes]);
  return JSON.stringify(Object.fromEntries(fields));
};

/** Reads back a sealed address. Only checkout writes it: a bad shape means damage, so it throws. */
export function shipToFromJson(json: string): ShipTo {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // A parse error quotes the text it read: never let a fragment of an address reach a log.
    throw new Error('ordering.stored-ship-to-invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ordering.stored-ship-to-invalid');
  }
  const record = value as Record<string, unknown>;
  for (const key of FIELDS) {
    const field = record[key];
    if (!(typeof field === 'string' || (NULLABLE.has(key) && field === null))) {
      throw new Error('ordering.stored-ship-to-invalid');
    }
  }
  const address = Object.fromEntries(FIELDS.map((key) => [key, record[key]])) as unknown as ShipTo;
  const notes = record.sellerNotes;
  if (notes === undefined) return address;
  if (
    typeof notes !== 'object' ||
    notes === null ||
    Array.isArray(notes) ||
    Object.values(notes).some((note) => typeof note !== 'string')
  ) {
    throw new Error('ordering.stored-ship-to-invalid');
  }
  return { ...address, sellerNotes: { ...(notes as Record<string, string>) } };
}

/**
 * {@link ShipToCipher} on the platform `SubjectKeyService` (PF 4): the subject is the customer
 * account, whose key `identity` created with the account; `ordering` never calls `createKey`.
 */
export class SubjectKeyShipToCipher implements ShipToCipher {
  constructor(private readonly keys: SubjectKeyService) {}

  seal(market: MarketContext, accountId: Id<'Account'>, shipTo: ShipTo) {
    return this.keys.encrypt(market, accountId, SHIP_TO_LABEL, shipToJson(shipTo));
  }

  async open(market: MarketContext, accountId: Id<'Account'>, sealed: string) {
    const opened = await this.keys.decrypt(market, accountId, SHIP_TO_LABEL, sealed);
    return opened.ok ? ok(shipToFromJson(opened.value)) : err(opened.error);
  }
}
