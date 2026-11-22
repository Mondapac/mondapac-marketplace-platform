import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageInfo } from './page-info.tsx';
import { Popover } from './popover.tsx';

describe('PageInfo', () => {
  const html = renderToStaticMarkup(<PageInfo page="Brands">Brands group products.</PageInfo>);

  it('is one closed button named "About <page>" that opens a dialog', () => {
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('aria-label="About Brands"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it('is borderless and shows the info icon at 16 px', () => {
    expect(html).not.toContain('border');
    expect(html).toContain('size-4!');
    expect(html).toContain('text-icon-muted');
  });

  it('lets a screen reader hear the text without opening the panel', () => {
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`<span id="${id}" class="sr-only">Brands group products.</span>`);
  });
});

describe('Popover control variant', () => {
  it('keeps the bordered toolbar button and has no description by default', () => {
    const control = renderToStaticMarkup(
      <Popover label="Sort" icon="info">
        {() => null}
      </Popover>,
    );
    expect(control).toContain('border-line-control');
    expect(control).not.toContain('aria-describedby');
  });
});
