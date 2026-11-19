import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionMenu } from './action-menu.tsx';

const items = [{ id: 'activate', label: 'Activate', icon: 'check' as const, onSelect: () => {} }];
const render = (props: Partial<Parameters<typeof ActionMenu>[0]> = {}) =>
  renderToStaticMarkup(
    <ActionMenu label="Bulk action" title="3 products selected" items={items} {...props} />,
  );

describe('ActionMenu', () => {
  it('is one button with the label and a trailing chevron, closed', () => {
    const html = render();
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/Bulk action<svg/);
    expect(html).toContain('m6 9 6 6 6-6');
  });

  it('shows the heading and the items only inside the open menu, never on the button', () => {
    const html = render();
    expect(html).not.toContain('3 products selected');
    expect(html).not.toContain('Activate');
    expect(html).not.toContain('role="menu"');
  });

  it('explains a disabled button to keyboard and screen-reader users, not only on hover', () => {
    const html = render({ disabled: true, hint: 'Tick orders to export them.' });
    // The wrapper takes focus and hover; it names the reason as its title and its description.
    expect(html).toMatch(/<span[^>]*tabindex="0"[^>]*title="Tick orders to export them\."/);
    expect(html).toMatch(/aria-describedby="([^"]+)-hint"/);
    expect(html).toMatch(
      /<span id="[^"]+-hint" class="sr-only">Tick orders to export them\.<\/span>/,
    );
    // An enabled menu, or one with no hint, adds neither.
    expect(render({ hint: 'x' })).not.toContain('tabindex');
    expect(render({ disabled: true })).not.toContain('tabindex');
  });

  it('exposes the hint once and shows a focus ring on the focusable wrapper', () => {
    const html = render({ disabled: true, hint: 'Tick orders to export them.' });
    // Only the wrapper carries the title; the inner button does not repeat it.
    expect(html.match(/title="Tick orders to export them\."/g)).toHaveLength(1);
    expect(html).toMatch(/<button(?![^>]*title=)[^>]*>/);
    expect(html).toMatch(
      /<span[^>]*class="[^"]*focus-visible:outline-2 focus-visible:outline-focus[^"]*"[^>]*tabindex="0"|<span[^>]*tabindex="0"[^>]*class="[^"]*focus-visible:outline-2 focus-visible:outline-focus/,
    );
    // Without the wrapper (enabled), the button keeps its own title as before.
    expect(render({ hint: 'x' })).toMatch(/<button[^>]*title="x"/);
  });

  it('is a disabled button when there is nothing to act on', () => {
    expect(render({ disabled: true })).toContain('disabled=""');
    expect(render()).not.toContain('disabled=""');
  });

  it('is as high as a control (48 px on a phone) and uses tokens only', () => {
    const html = render();
    expect(html).toContain('h-(--mp-size-control)');
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|\[#/i);
  });
});
