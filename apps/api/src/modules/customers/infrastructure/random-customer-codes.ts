import { randomInt } from 'node:crypto';
import { CUSTOMER_CODE_ALPHABET, formatCustomerCode } from '../domain/seller-customers';
import type { CustomerCodes } from '../application/ports/seller-customers.repository';

/** {@link CustomerCodes} from the operating system's random source: 8 symbols, 40 bits. */
export class RandomCustomerCodes implements CustomerCodes {
  next(): string {
    let symbols = '';
    for (let index = 0; index < 8; index += 1) {
      symbols += CUSTOMER_CODE_ALPHABET[randomInt(CUSTOMER_CODE_ALPHABET.length)];
    }
    return formatCustomerCode(symbols);
  }
}
