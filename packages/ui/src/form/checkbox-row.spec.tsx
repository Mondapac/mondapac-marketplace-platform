import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckboxRow } from './checkbox-row.tsx';

describe('CheckboxRow', () => {
  it('links the label to the box and describes it with the help text', () => {
    const html = renderToStaticMarkup(<CheckboxRow label="Photos match" help="All of them" />);
    const id = /<input id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`<label for="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-help"`);
    expect(html).toContain(`<p id="${id}-help"`);
  });

  it('keeps the desktop layout unless touch is set', () => {
    const html = renderToStaticMarkup(<CheckboxRow label="Photos match" />);
    expect(html).not.toContain('max-lg:py-3.5');
    expect(html).not.toContain('max-lg:mt-[18px]');
  });

  it('pads only the label for touch, so the help text stays outside the target', () => {
    const html = renderToStaticMarkup(
      <CheckboxRow touch label="Photos match" help="All of them" />,
    );
    expect(html).toMatch(/<label [^>]*class="[^"]*max-lg:py-3\.5/);
    expect(html).toMatch(/<input [^>]*class="[^"]*max-lg:mt-\[18px\]/);
    expect(html).not.toMatch(/<p [^>]*class="[^"]*max-lg:py/);
  });
});
