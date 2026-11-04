import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SelectBox } from './select-box.tsx';

const render = (props: Partial<Parameters<typeof SelectBox>[0]> = {}) =>
  renderToStaticMarkup(
    <SelectBox label="Select Lamb cutlets" checked={false} onChange={() => {}} {...props} />,
  );

describe('SelectBox', () => {
  it('is a checkbox named by its label, with no visible text', () => {
    const html = render();
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-label="Select Lamb cutlets"');
    expect(html.replace(/<[^>]*>/g, '')).toBe('');
  });

  it('reflects checked and disabled', () => {
    expect(render({ checked: true })).toContain('checked=""');
    expect(render()).not.toContain('checked=""');
    expect(render({ disabled: true })).toContain('disabled=""');
  });

  it('keeps a 40 px click target around the 16 px box without taking layout room', () => {
    const html = render();
    expect(html).toContain('size-4');
    expect(html).toContain('size-10');
    expect(html).toContain('-m-3');
  });
});
