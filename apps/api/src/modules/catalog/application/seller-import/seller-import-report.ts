import { csvLine, CSV_BOM } from '../products/products-csv';
import { SELLER_COLUMNS, type SellerImportMode } from '../../domain/seller-import/columns';
import { issueHeaderOf } from '../../domain/seller-import/row-check';
import type {
  SellerImportJob,
  SellerRowRecord,
} from '../../domain/seller-import/seller-import-job';

// The two reports of a seller import (catalog design 14c): the error report of the check and the
// full report of a run. English text, because a file is data, not a page. Every cell goes through
// the export's `csvCell`, which writes a leading quote before a cell that starts with = + - @ tab
// or carriage return, so a spreadsheet never runs a value from the uploaded file as a formula.
// The reports hold the cleaned cells of the check and the codes of the run: never a cell of an
// ignored column (certification, price, cost, stock) and never the file name.

/** The reason of a row's issue or failed run, in words (the page has its own copy for the same codes). */
export function sellerProblemText(code: string, column: string, otherRow?: number): string {
  const header = issueHeaderOf(column);
  switch (code) {
    case 'required':
      return `${header} is required`;
    case 'too-long':
      return `${header} is too long`;
    case 'sku.invalid':
      return 'The Seller SKU has a character that is not allowed';
    case 'condition.unknown':
      return 'No condition with this name in this market';
    case 'category.unknown':
      return 'No category with this name';
    case 'category.ambiguous':
      return 'More than one category has this name';
    case 'product-type.unknown':
      return 'No product type with this name';
    case 'type.not-allowed':
      return 'Your account is not set up to sell this product type';
    case 'gtin.invalid':
      return 'Not a valid barcode';
    case 'gtin.duplicate':
      return 'Another product already has this barcode';
    case 'image-url.not-fetched':
      return 'Image links are not fetched: add the photo in the photo step';
    case 'tax-category.unknown':
      return 'No tax category with this code';
    case 'tax-category.default-used':
      return 'No tax category given: the market default is used';
    case 'attribute.required':
      return `${header} is required for this product type`;
    case 'attribute.type':
    case 'attribute.option-unknown':
      return `${header} is not valid`;
    case 'column.not-stored':
      return 'Checked, not stored: this catalogue has no attribute for it';
    case 'import.group-mismatch':
      return 'A cell of this product differs from the first row of the same Seller SKU';
    case 'import.group-split':
      return otherRow === undefined
        ? 'Rows of one Seller SKU must be together'
        : `Rows of this Seller SKU must be together, as from row ${otherRow}`;
    case 'import.group-error':
      return 'Another row of this product has an error, so none of its rows is imported';
    case 'import.duplicate-row':
      return otherRow === undefined
        ? 'Same options as another row of this product'
        : `Same options as row ${otherRow}`;
    case 'import.option-missing':
      return 'Fill the same option columns on every row of this product';
    case 'import.option-not-allowed':
      return 'This product has no options: leave the option cells empty';
    case 'import.option-unknown':
      return 'No option with this name';
    case 'import.type-locked':
      return 'The product type of an existing product cannot be changed';
    case 'import.key-conflict':
      return 'This Seller SKU is already used by another product of yours';
    case 'import.wrong-mode':
      return 'This row belongs to the other kind of import';
    case 'offer.exists-for-product':
      return 'You already sell this product';
    case 'product.not-found':
      return 'No product with this code can be sold from the catalogue';
    case 'duplicate-in-file':
      return otherRow === undefined
        ? 'Same value as another row of the file'
        : `Same value as row ${otherRow}`;
    case 'variant.limit-reached':
      return 'This product would have more variants than the market allows';
    case 'text.invalid-characters':
      return 'Contains a character that can’t be stored';
    // Run reasons.
    case 'claim-text.refused':
    case 'claim-text.found':
      return 'The text mentions a certification. Certification belongs to an offer you tag, not to the text';
    case 'text.blocked-term':
      return 'The text holds a word the platform does not allow';
    case 'claim-text.check-unavailable':
      return 'The certification-wording check was unavailable';
    case 'row.changed':
      return 'The row no longer passes the check';
    case 'seller.not-eligible':
    case 'seller-not-eligible':
      return 'Your account can no longer sell';
    case 'offer.sku-taken':
      return 'This Seller SKU was taken meanwhile';
    case 'setting.product-creation-off':
    case 'setting.sell-from-catalogue-off':
      return 'This kind of import is switched off in this market';
    case 'access.denied':
      return 'You no longer have access to import products';
    default:
      return 'The row could not be imported';
  }
}

/** The check's error report: one line per problem of a row with errors. */
export function sellerErrorReportCsv(rows: readonly SellerRowRecord[]): string {
  let out = CSV_BOM + csvLine(['Row', 'Column', 'Value in the file', 'Problem']);
  for (const row of rows) {
    if (row.checkState !== 'error') continue;
    for (const issue of row.issues) {
      if (issue.severity !== 'error') continue;
      out += csvLine([
        row.rowNumber,
        issueHeaderOf(issue.column),
        issue.value,
        sellerProblemText(issue.code, issue.column, issue.otherRow),
      ]);
    }
  }
  return out;
}

export function sellerResultOf(job: Pick<SellerImportJob, 'state'>, row: SellerRowRecord): string {
  switch (row.runState) {
    case 'created':
      return 'Created';
    case 'updated':
      return 'Updated';
    case 'unchanged':
      return 'Unchanged';
    case 'failed':
      return 'Not imported';
    case 'skipped':
      return 'Skipped at check';
    default:
      return job.state === 'stopped' ? 'Not tried' : 'Pending';
  }
}

/** The full report of a run: every row, what happened to it and why. */
export function sellerFullReportCsv(
  job: Pick<SellerImportJob, 'state'>,
  rows: readonly SellerRowRecord[],
): string {
  let out = CSV_BOM + csvLine(['Row', 'Seller SKU', 'Title', 'Result', 'Product code', 'Details']);
  for (const row of rows) {
    const details: string[] = [];
    if (row.runState === 'failed' && row.runCode !== null) {
      details.push(sellerProblemText(row.runCode, 'row'));
    }
    for (const issue of row.issues) {
      details.push(
        `${issueHeaderOf(issue.column)}: ${sellerProblemText(issue.code, issue.column, issue.otherRow)}`,
      );
    }
    out += csvLine([
      row.rowNumber,
      row.summary.sku,
      row.summary.title,
      sellerResultOf(job, row),
      row.productCode ?? (row.summary.productCode === '' ? null : row.summary.productCode),
      details.join('; '),
    ]);
  }
  return out;
}

/** The template rows of a mode: the header of the columns the mode reads and one example row. */
export function sellerTemplateRows(
  mode: SellerImportMode,
  typeExample: string,
): readonly (readonly string[])[] {
  const columns = SELLER_COLUMNS.filter((column) => column.modes.includes(mode));
  const example: Record<string, string> = {
    sku: 'LAMB-1KG',
    condition: 'New',
    offerDescription: 'Fresh, cut to order',
    productCode: 'P-000123',
    title: 'Lamb shoulder 1 kg',
    category: 'Meat',
    type: typeExample,
    shortDescription: 'Bone-in lamb shoulder',
    description: '',
    brand: 'Example Farms',
    taxCategory: '',
    images: 'lamb-shoulder.jpg',
    gtin: '',
    weight: '1000',
    length: '',
    width: '',
    height: '',
  };
  return [columns.map((column) => column.header), columns.map((column) => example[column.key] ?? '')];
}

export function sellerTemplateCsv(rows: readonly (readonly string[])[]): string {
  return CSV_BOM + rows.map((cells) => csvLine(cells)).join('');
}
