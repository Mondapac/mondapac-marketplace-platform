import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileButton } from './file-button.tsx';
import { ImageSlot } from './image-slot.tsx';

describe('FileButton', () => {
  it('is a labelled file input a keyboard can reach, with a visible label as the button', () => {
    const html = renderToStaticMarkup(
      <FileButton accept="image/png" onFiles={() => undefined}>
        Choose a picture
      </FileButton>,
    );
    const id = /<input[^>]* id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/png"');
    // The input is hidden visually (sr-only), not removed: it stays in the tab order.
    expect(html).toContain('class="peer sr-only"');
    expect(html).not.toContain('tabindex="-1"');
    expect(html).not.toContain('display:none');
    expect(html).toContain(`<label for="${id}"`);
    expect(html).toContain('Choose a picture</label>');
    // The label shows the focus ring when the input is focused.
    expect(html).toContain('peer-focus-visible:outline-focus');
  });

  it('looks and acts disabled when it is', () => {
    const html = renderToStaticMarkup(
      <FileButton disabled onFiles={() => undefined}>
        Choose
      </FileButton>,
    );
    expect(html).toMatch(/<input[^>]* disabled=""/);
    expect(html).toContain('cursor-not-allowed text-fg-muted');
    expect(html).not.toContain('hover:bg-muted');
  });
});

describe('ImageSlot', () => {
  it('centres its text in a dashed frame, a strip for a banner and a tile for a logo', () => {
    const banner = renderToStaticMarkup(<ImageSlot>No banner yet.</ImageSlot>);
    expect(banner).toContain('border-dashed');
    expect(banner).toContain('min-h-24');
    expect(banner).toContain('justify-center');
    expect(banner).toContain('text-center');
    expect(banner).toContain('No banner yet.');
    const logo = renderToStaticMarkup(<ImageSlot shape="square">No logo yet.</ImageSlot>);
    expect(logo).toContain('size-24');
    expect(logo).not.toContain('min-h-24');
  });
});
