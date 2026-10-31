import { mapColumns, templateRows } from './columns';

describe('mapColumns', () => {
  const required = ['Title', 'Main category', 'Product type'];

  it('maps the template headers and ignores the rest', () => {
    const result = mapColumns([...required, 'Description', 'Brand', 'Internal note']);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.map.title).toBe(0);
    expect(result.value.map.brand).toBe(4);
    expect(result.value.ignored).toEqual([{ header: 'Internal note', certification: false }]);
  });

  it('lists certification-like headers as ignored and flagged, never mapped', () => {
    const result = mapColumns([...required, 'Halal certificate', 'Vegan', 'Handling', 'Status']);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.ignored.map((column) => column.certification)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(Object.keys(result.value.map).sort()).toEqual(['category', 'title', 'type']);
  });

  it('refuses a file without the required columns', () => {
    const result = mapColumns(['Title', 'Brand']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('columns.missing');
  });

  it('refuses a column named twice', () => {
    const result = mapColumns([...required, 'Title']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('columns.duplicate');
  });

  it('builds a template with the header and one example row of the same width', () => {
    const rows = templateRows('simple');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(rows[1]!.length);
  });
});
