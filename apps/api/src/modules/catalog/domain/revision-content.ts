/**
 * The frozen content of a product revision (catalog design 2.3 M-2, data design 3.7 to 3.10):
 * what a submit validates and writes as rows, and what `contentHash` covers. Provenance, author
 * and timestamps are the revision's record, not its content, so they are not here.
 */
export interface RevisionText {
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
}

export interface RevisionVariantContent {
  readonly variantId: string;
  readonly position: number;
  /** The canonical string of the option values, built by the handler (`size=l;colour=red`). */
  readonly optionKey: string;
  readonly optionValues: Readonly<Record<string, string>>;
  /** Locale to label. */
  readonly labels: Readonly<Record<string, string>>;
}

export interface RevisionContent {
  /** Locale to text; the Market's default locale is required by completeness, not here. */
  readonly texts: Readonly<Record<string, RevisionText>>;
  /** Platform category ids in the order entered. */
  readonly categoryIds: readonly string[];
  readonly taxCategoryCode: string;
  /** Attribute code to value, or to a locale map for a localizable attribute (CA6). */
  readonly attributeValues: Readonly<Record<string, unknown>>;
  readonly variants: readonly RevisionVariantContent[];
  /** Image ids in position order; empty until slice 13. */
  readonly imageIds: readonly string[];
  /** The schema the content was validated against (data design 3.7). */
  readonly schemaRef: {
    readonly familyRevisionId: string;
    readonly definitionRevisionIds: readonly string[];
  };
  readonly contentSchemaVersion: number;
}
