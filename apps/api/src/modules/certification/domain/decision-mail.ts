// The texts of the three mails to a seller's Owner after a review decision (certification design
// 12). Plain text only: the mail transport sends no HTML, so nothing can become markup. The
// reason is the Market's own plain label of the reason code; the reviewer's free text and the
// certificate number never go into a mail. The final words are Reza's with ux-copy; these are the
// working texts, like the order mails.

export interface DecisionMail {
  readonly subject: string;
  readonly text: string;
}

/** One line of plain text: no control or format characters (the code of a type is data). */
function line(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function approvedMail(input: { readonly typeCode: string }): DecisionMail {
  const type = line(input.typeCode);
  return {
    subject: 'Your certificate was approved',
    text: [
      'Your certificate was approved',
      '',
      `Your ${type} certificate was reviewed and approved.`,
      '',
      'Open your seller panel to see its status and the date by which it needs renewing.',
      '',
    ].join('\n'),
  };
}

export function changesRequestedMail(input: {
  readonly typeCode: string;
  readonly reasonLabel: string | null;
}): DecisionMail {
  const type = line(input.typeCode);
  return {
    subject: 'Changes are needed on your certificate',
    text: [
      'Changes are needed on your certificate',
      '',
      `We reviewed your ${type} certificate and need you to change something.`,
      ...(input.reasonLabel === null ? [] : ['', `Reason: ${line(input.reasonLabel)}`]),
      '',
      'Open your seller panel, correct the certificate and submit it again.',
      '',
    ].join('\n'),
  };
}

export function declinedMail(input: {
  readonly typeCode: string;
  readonly reasonLabel: string | null;
}): DecisionMail {
  const type = line(input.typeCode);
  return {
    subject: 'Your certificate was not accepted',
    text: [
      'Your certificate was not accepted',
      '',
      `We reviewed your ${type} certificate and could not accept it.`,
      ...(input.reasonLabel === null ? [] : ['', `Reason: ${line(input.reasonLabel)}`]),
      '',
      'You can add a new certificate in your seller panel.',
      '',
    ].join('\n'),
  };
}
