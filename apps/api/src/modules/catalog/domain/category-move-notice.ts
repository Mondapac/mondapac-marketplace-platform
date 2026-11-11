// The mail a seller gets when "Move products" changed the category of one of their products (C5a,
// decision 8). Plain text only; the mail transport sends no HTML. Only the product code and the
// category names go in: no reason note, no admin, no id. The final words are Reza's with ux-copy;
// these are working texts, like the certificate expiry notice. The seller panel is English.

export interface CategoryMoveNoticeMail {
  readonly subject: string;
  readonly text: string;
}

/** One line of plain text: no control or format characters. */
function line(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function categoryMoveNoticeMail(input: {
  readonly productCode: string;
  readonly fromName: string;
  readonly toName: string;
}): CategoryMoveNoticeMail {
  const code = line(input.productCode);
  const from = line(input.fromName);
  const to = line(input.toName);
  return {
    subject: `The category of your product ${code} changed`,
    text: [
      `Our team moved your product ${code} from the category "${from}" to "${to}".`,
      'Your product stays on sale. If the new category asks for details your product does not have yet, add them the next time you edit it.',
    ].join('\n\n'),
  };
}
