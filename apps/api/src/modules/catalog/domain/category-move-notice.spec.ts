import { categoryMoveNoticeMail } from './category-move-notice';

describe('categoryMoveNoticeMail', () => {
  it('names the product and both categories and nothing else', () => {
    const mail = categoryMoveNoticeMail({
      productCode: 'P00000042',
      fromName: 'Dates',
      toName: 'Fresh dates',
    });
    expect(mail.subject).toBe('The category of your product P00000042 changed');
    expect(mail.text).toContain('from the category "Dates" to "Fresh dates"');
  });
  it('makes every name one line and strips control and format characters', () => {
    const mail = categoryMoveNoticeMail({
      productCode: 'P1\n',
      fromName: 'A‮B\r\nC',
      toName: '​D',
    });
    expect(mail.subject).not.toMatch(/[\n\r‮]/u);
    expect(mail.text).toContain('"A B C"');
    expect(mail.text).toContain('"D"');
  });
});
