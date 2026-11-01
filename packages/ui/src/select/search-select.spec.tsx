import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SearchSelect, type SearchSelectOption } from './search-select.tsx';

const grocery: SearchSelectOption = { value: 'g', label: 'Grocery' };
const butcher: SearchSelectOption = { value: 'b', label: 'Butcher' };
const options = [grocery, butcher];
const noop = () => {};

describe('SearchSelect (closed)', () => {
  it('is a labelled combobox that shows the chosen option', () => {
    const html = renderToStaticMarkup(
      <SearchSelect label="Main activity" options={options} value={grocery} onChange={noop} />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    const id = /<label for="([^"]+)"[^>]*>Main activity<\/label>/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('>Grocery<');
    expect(html).not.toContain('role="listbox"');
  });

  it('shows the placeholder when nothing is chosen', () => {
    const html = renderToStaticMarkup(
      <SearchSelect
        label="Main activity"
        options={options}
        value={null}
        placeholder="Choose one"
        onChange={noop}
      />,
    );
    expect(html).toContain('>Choose one<');
  });

  it('shows the picks of a multiple choice as removable chips with named buttons', () => {
    const html = renderToStaticMarkup(
      <SearchSelect
        multiple
        label="Other activities"
        options={options}
        value={[grocery, butcher]}
        onChange={noop}
        name="activities"
      />,
    );
    expect(html).toContain('aria-label="Remove Grocery"');
    expect(html).toContain('aria-label="Remove Butcher"');
    expect(html.match(/type="hidden"/g)).toHaveLength(2);
    expect(html).toContain('name="activities"');
  });

  it('wires help and error text through aria-describedby and marks the field invalid', () => {
    const html = renderToStaticMarkup(
      <SearchSelect
        label="Main activity"
        options={options}
        value={null}
        help="Pick one"
        error="Required"
        required
        onChange={noop}
      />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-required="true"');
    expect(html).toMatch(/aria-describedby="[^"]+-help [^"]+-error"/);
    expect(html).toContain('>Pick one<');
    expect(html).toContain('>Required<');
  });

  it('is disabled as a whole and uses tokens only', () => {
    const html = renderToStaticMarkup(
      <SearchSelect
        multiple
        label="Other activities"
        options={options}
        value={[grocery]}
        disabled
        onChange={noop}
      />,
    );
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|\[#/i);
  });
});
