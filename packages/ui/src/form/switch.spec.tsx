import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Switch } from './switch.tsx';

describe('Switch', () => {
  it('is a named switch that reports its state', () => {
    const on = renderToStaticMarkup(
      <Switch checked aria-label="Active" onCheckedChange={() => undefined} />,
    );
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('aria-label="Active"');
    expect(on).toContain('type="button"');
    const off = renderToStaticMarkup(
      <Switch checked={false} aria-label="Active" onCheckedChange={() => undefined} />,
    );
    expect(off).toContain('aria-checked="false"');
  });

  it('can be disabled, and places the knob with logical flex edges', () => {
    const html = renderToStaticMarkup(
      <Switch checked disabled aria-label="Active" onCheckedChange={() => undefined} />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('justify-end');
    expect(html).not.toMatch(/\b(left|right|ml|mr|pl|pr)-/);
  });
});
