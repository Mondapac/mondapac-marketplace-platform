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

/**
 * An admin revoked the certificate (design 12; CERT-16: "the seller is told"). The Market's plain
 * label of the reason; never the admin's note.
 */
export function revokedMail(input: {
  readonly typeCode: string;
  readonly reasonLabel: string | null;
}): DecisionMail {
  const type = line(input.typeCode);
  return {
    subject: 'Your certificate was revoked',
    text: [
      'Your certificate was revoked',
      '',
      `Your ${type} certificate has been revoked and no longer counts.`,
      ...(input.reasonLabel === null ? [] : ['', `Reason: ${line(input.reasonLabel)}`]),
      '',
      `Your offers no longer show the ${type} certification. You can add a new certificate in your seller panel; the certification comes back once it is approved.`,
      '',
    ].join('\n'),
  };
}

// The answer to a seller's "my issuer is not listed" request (design 12, `issuer-request-answered`).
// Neither mail repeats the issuer's name the seller typed (request text, never a registry value) nor
// names the added issuer: the seller picks it in the form, where the registry shows it.

export function issuerAddedMail(input: { readonly typeCode: string }): DecisionMail {
  const type = line(input.typeCode);
  return {
    subject: 'The issuer you asked about is now listed',
    text: [
      'The issuer you asked about is now listed',
      '',
      `We checked your request for a missing ${type} issuer and added the issuer to the list.`,
      '',
      'Open your seller panel, choose the issuer in your certificate and submit it for review.',
      '',
    ].join('\n'),
  };
}

export function issuerNotAcceptedMail(input: {
  readonly typeCode: string;
  readonly reasonLabel: string | null;
}): DecisionMail {
  const type = line(input.typeCode);
  return {
    subject: 'We could not add the issuer you asked about',
    text: [
      'We could not add the issuer you asked about',
      '',
      `We checked your request for a missing ${type} issuer and could not add it to the list.`,
      ...(input.reasonLabel === null ? [] : ['', `Reason: ${line(input.reasonLabel)}`]),
      '',
      'You can choose another listed issuer in your seller panel, or contact support.',
      '',
    ].join('\n'),
  };
}

// The expiry warning and the expiry notice (design 12; brief s4 c 2): the consequence and the
// date by which a renewal should be submitted. Dates are the seller's local dates as written on
// the certificate (ISO form, YYYY-MM-DD), never an instant. No number, issuer or file is named.

export function expiryWarningMail(input: {
  readonly typeCode: string;
  readonly expiryDate: string;
  /** The renewal submit-by date; null when it is not ahead of the warning (submit now). */
  readonly submitBy: string | null;
}): DecisionMail {
  const type = line(input.typeCode);
  const expiry = line(input.expiryDate);
  return {
    subject: `Your certificate expires on ${expiry}`,
    text: [
      `Your certificate expires on ${expiry}`,
      '',
      `Your ${type} certificate is valid until the end of ${expiry}, your local time.`,
      '',
      `After that, your offers can no longer show the ${type} certification, and offers that rely on it cannot be bought with it, until a renewed certificate is approved.`,
      '',
      input.submitBy === null
        ? 'Please submit your renewed certificate now, so it can be reviewed before it expires.'
        : `Please submit your renewed certificate by ${line(input.submitBy)}, so it can be reviewed before it expires.`,
      '',
      'Open your seller panel to renew it.',
      '',
    ].join('\n'),
  };
}

export function expiredMail(input: {
  readonly typeCode: string;
  readonly expiryDate: string;
}): DecisionMail {
  const type = line(input.typeCode);
  return {
    subject: 'Your certificate has expired',
    text: [
      'Your certificate has expired',
      '',
      `Your ${type} certificate expired at the end of ${line(input.expiryDate)}, your local time.`,
      '',
      `Your offers no longer show the ${type} certification. Submit a renewed certificate in your seller panel; the certification comes back once it is approved.`,
      '',
    ].join('\n'),
  };
}

/**
 * The mail of deactivation form 2 (design 3.5, 12; Q6): the issuer of an approved certificate is
 * no longer recognised. Why and what to do: the certificate stopped counting at once, and a
 * certificate from a recognised issuer brings the certification back. The issuer's public name
 * is registry data (the badge shows it); nothing else about the issuer or the decision is told.
 */
export function issuerDerecognisedMail(input: {
  readonly typeCode: string;
  readonly issuerName: string;
}): DecisionMail {
  const type = line(input.typeCode);
  const issuer = line(input.issuerName);
  return {
    subject: 'Your certificate no longer counts',
    text: [
      'Your certificate no longer counts',
      '',
      `We no longer recognise ${issuer} as an issuer of ${type} certificates. Your ${type} certificate from this issuer stopped counting at once.`,
      '',
      `Your offers no longer show the ${type} certification. To show it again, add a certificate from an issuer we recognise in your seller panel and submit it for review.`,
      '',
    ].join('\n'),
  };
}
