import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TextAreaField } from './text-area-field.tsx';

const idOf = (html: string, attribute: string): string | undefined =>
  new RegExp(`${attribute}="([^"]+)"`).exec(html)?.[1];

describe('TextAreaField', () => {
  it('labels the text area through for/id', () => {
    const html = renderToStaticMarkup(<TextAreaField label="About" defaultValue="Hello" />);
    const id = idOf(html, ' id');
    expect(html).toContain(`<label for="${id}"`);
    expect(html).toContain('>About</label>');
    expect(html).toContain('<textarea');
    expect(html).toContain('rows="6"');
    expect(html).toContain('>Hello</textarea>');
  });

  it('has no description and is not invalid without help, counter or error', () => {
    const html = renderToStaticMarkup(<TextAreaField label="About" />);
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('role="alert"');
  });

  it('marks the field invalid and announces the error, tied by aria-describedby', () => {
    const html = renderToStaticMarkup(<TextAreaField label="About" error="Too long" />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('border-critical-solid');
    const described = idOf(html, 'aria-describedby');
    expect(html).toContain(`<p id="${described}" role="alert"`);
    expect(html).toContain('>Too long</p>');
  });

  it('describes the field by the help, the counter and the error, in that order', () => {
    const html = renderToStaticMarkup(
      <TextAreaField label="About" help="Plain text" counter="3 of 10" error="Nope" />,
    );
    const ids = (idOf(html, 'aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/-help$/);
    expect(ids[1]).toMatch(/-counter$/);
    expect(ids[2]).toMatch(/-error$/);
    expect(html).toContain(`<p id="${ids[0]}"`);
    expect(html).toContain(`<div id="${ids[1]}"`);
    expect(html).toContain('3 of 10');
    expect(html).toContain(`<p id="${ids[2]}"`);
  });

  it('shows the optional word beside the label, and passes other props through', () => {
    const html = renderToStaticMarkup(
      <TextAreaField label="About" optionalLabel="optional" readOnly lang="ja-JP" rows={3} />,
    );
    expect(html).toContain('(optional)');
    expect(html).toContain('readOnly=""');
    expect(html).toContain('lang="ja-JP"');
    expect(html).toContain('rows="3"');
  });
});
