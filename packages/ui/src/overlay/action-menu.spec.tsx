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
