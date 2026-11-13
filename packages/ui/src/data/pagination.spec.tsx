import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Pagination, PrevNext, pageWindow } from './pagination.tsx';

const labels = {
  nav: 'Pages',
  previous: 'Previous',
  next: 'Next',
  page: (n: number) => `Page ${n}`,
};
const noop = () => undefined;
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('pageWindow', () => {
  it('shows every page of a short list', () => {
    expect(pageWindow(2, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(1, 1)).toEqual([1]);
  });

  it('keeps the first, the last and the neighbours of the current page', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 'gap', 20]);
    expect(pageWindow(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
    expect(pageWindow(20, 20)).toEqual([1, 'gap', 19, 20]);
  });

  it('shows the number instead of a gap that would hide one page', () => {
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageWindow(17, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
  });

  it('clamps a page outside the list', () => {
    expect(pageWindow(99, 5)).toEqual([1, 'gap', 4, 5]);
    expect(pageWindow(-3, 5)).toEqual([1, 2, 'gap', 5]);
  });
});

describe('Pagination', () => {
  it('marks the current page and names every page button', () => {
    const out = html(<Pagination page={3} pageCount={10} onPage={noop} labels={labels} />);

    expect(out).toContain('aria-label="Pages"');
    expect(out).toMatch(/aria-label="Page 3"[^>]*aria-current="page"/);
    expect(out).not.toMatch(/aria-label="Page 4"[^>]*aria-current/);
    expect(out).toContain('aria-label="Page 10"');
  });

  it('disables Previous on the first page and Next on the last', () => {
    const first = html(<Pagination page={1} pageCount={3} onPage={noop} labels={labels} />);
    const last = html(<Pagination page={3} pageCount={3} onPage={noop} labels={labels} />);

    expect(first).toMatch(/<button[^>]*disabled=""[^>]*>Previous</);
    expect(first).not.toMatch(/<button[^>]*disabled=""[^>]*>Next</);
    expect(last).toMatch(/<button[^>]*disabled=""[^>]*>Next</);
  });

  it('disables every button while a page loads', () => {
    const out = html(<Pagination page={2} pageCount={3} onPage={noop} labels={labels} disabled />);
    expect(out.match(/<button/g)).toHaveLength(out.match(/disabled=""/g)?.length ?? -1);
  });

  it('shows nothing for a single page', () => {
    expect(html(<Pagination page={1} pageCount={1} onPage={noop} labels={labels} />)).toBe('');
  });
});

describe('PrevNext', () => {
  it('follows what the list can do', () => {
    const out = html(
      <PrevNext hasPrevious={false} hasNext onPrevious={noop} onNext={noop} labels={labels} />,
    );
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Previous</);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Next</);
  });

  it('shows nothing when there is neither', () => {
    expect(
      html(
        <PrevNext
          hasPrevious={false}
          hasNext={false}
          onPrevious={noop}
          onNext={noop}
          labels={labels}
        />,
      ),
    ).toBe('');
  });
});
