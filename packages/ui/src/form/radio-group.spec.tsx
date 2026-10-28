import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RadioGroup } from './radio-group.tsx';

const options = [
  { value: 'seller', label: 'The seller repays' },
  { value: 'platform', label: 'MondaPac bears it', help: 'No ledger row' },
];
const render = (props: Partial<Parameters<typeof RadioGroup>[0]> = {}) =>
  renderToStaticMarkup(
    <RadioGroup
      legend="Who bears the loss"
      name="bearer"
      value=""
      options={options}
      onChange={() => {}}
      {...props}
    />,
  );

describe('RadioGroup', () => {
  it('is a fieldset with a legend and one labelled radio per option', () => {
    const html = render();
    expect(html).toContain('<fieldset');
    expect(html).toContain('>Who bears the loss</legend>');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/name="bearer"/g)).toHaveLength(2);
    for (const label of ['The seller repays', 'MondaPac bears it']) {
      const id = new RegExp(`<label for="([^"]+)"[^>]*>${label}</label>`).exec(html)?.[1];
      expect(id).toBeDefined();
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('has rows at least 44px high and uses tokens only', () => {
    const html = render();
    expect(html).toContain('min-h-(--mp-size-control-sm)');
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|\[#/i);
  });

  it('checks the chosen value only', () => {
    const html = render({ value: 'platform' });
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(/value="platform"[^>]*checked=""|checked=""[^>]*value="platform"/.test(html)).toBe(true);
  });

  it('disables one option, or the whole group', () => {
    const one = render({ options: [{ ...options[0]!, disabled: true }, options[1]!] });
    expect(one.match(/disabled=""/g)).toHaveLength(1);
    expect(render({ disabled: true }).match(/disabled=""/g)).toHaveLength(2);
  });

  it('ties the option help and the note to the radio and the group by aria-describedby', () => {
    const html = render({ note: 'Nothing left to recover' });
    const helpId = /aria-describedby="([^"]+-help)"/.exec(html)?.[1];
    expect(helpId).toBeDefined();
    expect(html).toContain(`<p id="${helpId}"`);
    const noteId = /<fieldset[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${noteId}"`);
    expect(html).toContain('Nothing left to recover');
    expect(render()).not.toMatch(/<fieldset[^>]*aria-describedby/);
  });
});
