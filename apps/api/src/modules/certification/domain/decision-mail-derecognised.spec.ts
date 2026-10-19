import { issuerDerecognisedMail } from './decision-mail';

// The derecognition mail of certification slice 12 (design 12; Q6): plain text, one line per
// value, the type and the issuer's public name only.

describe('issuerDerecognisedMail', () => {
  it('says why and what to do, for any type code (AU and ZZ types alike)', () => {
    for (const typeCode of ['halal', 'qorvane']) {
      const mail = issuerDerecognisedMail({ typeCode, issuerName: 'Example Authority' });
      expect(mail.subject).toBe('Your certificate no longer counts');
      expect(mail.text).toContain(
        `We no longer recognise Example Authority as an issuer of ${typeCode} certificates.`,
      );
      expect(mail.text).toContain('add a certificate from an issuer we recognise');
    }
  });

  it('keeps every value on one line: control and format characters become spaces', () => {
    const mail = issuerDerecognisedMail({
      typeCode: 'halal',
      issuerName: 'Evil\r\nBcc: x@example.com‮',
    });
    expect(mail.text).toContain('We no longer recognise Evil Bcc: x@example.com as an issuer');
    expect(mail.text.split('\n')).toHaveLength(6);
  });
});
