import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnsavedBar } from './unsaved-bar.tsx';

const labels = { region: 'Unsaved changes', discardLabel: 'Discard', saveLabel: 'Save draft' };

describe('UnsavedBar', () => {
  it('announces the label politely and keeps Save a live submit button', () => {
    const html = renderToStaticMarkup(
      <UnsavedBar {...labels} label="Unsaved changes" onDiscard={() => undefined} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('>Unsaved changes<');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('md:top-(--mp-size-topbar)');
  });

  it('in the error state is an alert and disables Save', () => {
    const html = renderToStaticMarkup(
      <UnsavedBar {...labels} label="2 fields need fixing" error onDiscard={() => undefined} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save draft/);
  });
});
