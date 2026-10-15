// The texts of the two order emails (Phase 6 package 1, owner decision Q10). Plain text only: the
// mail transport sends no HTML, so user-entered text (product names) cannot become markup. A
// name is still flattened to one line without control or format characters, so it cannot break
// the layout of the message. The label of the customer mail is "Order confirmation", never
// "Tax invoice" (the tax adviser has not confirmed the wording).

export interface MailLine {
  /** The product name as the seller entered it, or null when catalog has none. */
  readonly name: string | null;
  readonly quantity: number;
}

export interface ComposedMail {
  readonly subject: string;
  readonly text: string;
}

const FALLBACK_NAME = 'Item';
const MAX_NAME = 120;

/** One line of plain text from seller-entered text: no control or format characters. */
export function plainLine(value: string | null): string {
  const flat = (value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length === 0) return FALLBACK_NAME;
  return flat.length > MAX_NAME ? `${flat.slice(0, MAX_NAME - 1)}…` : flat;
}

const lineText = (line: MailLine): string => `- ${plainLine(line.name)} x ${line.quantity}`;

/** The customer's "Order confirmation": the reference, the lines and a link that needs sign-in. */
export function orderConfirmationMail(input: {
  readonly orderId: string;
  readonly lines: readonly MailLine[];
  readonly orderUrl: string;
}): ComposedMail {
  return {
    subject: 'Order confirmation',
    text: [
      'Order confirmation',
      '',
      'Thank you. Your payment was received and your order is confirmed.',
      '',
      `Order reference: ${input.orderId}`,
      '',
      'Items:',
      ...input.lines.map(lineText),
      '',
      'View your order (you will be asked to sign in):',
      input.orderUrl,
      '',
    ].join('\n'),
  };
}

/** The seller's "New order": the reference and the seller's own lines. No customer data. */
export function sellerNewOrderMail(input: {
  readonly sellerOrderId: string;
  readonly lines: readonly MailLine[];
}): ComposedMail {
  return {
    subject: 'New order',
    text: [
      'New order',
      '',
      'You have a new paid order to prepare.',
      '',
      `Order reference: ${input.sellerOrderId}`,
      '',
      'Items:',
      ...input.lines.map(lineText),
      '',
      'Open your seller panel to see the order and record the shipment.',
      '',
    ].join('\n'),
  };
}
