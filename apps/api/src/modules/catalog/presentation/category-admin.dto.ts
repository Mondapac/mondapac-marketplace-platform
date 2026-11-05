import { ApiProperty } from '@nestjs/swagger';

// Answers of the admin category read routes (categories package C1). Ids, slugs, names and counts;
// never an account id of a seller or a permission key.

export class CategoryNameBody {
  @ApiProperty({ description: 'A BCP 47 locale code.' }) locale!: string;
  @ApiProperty() name!: string;
}

export class CategoryCountsBody {
  @ApiProperty({ description: 'Live products (published, with a listed Offer) in the subtree.' })
  liveProducts!: number;
  @ApiProperty({ description: 'Live products that name this category itself.' })
  liveProductsDirect!: number;
  @ApiProperty({ description: 'Non-deleted Offers on the products of the subtree.' })
  offers!: number;
}

export class CategoryRowBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) parentId!: string | null;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['active', 'hidden', 'merged', 'archived'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) mergedIntoId!: string | null;
  @ApiProperty({ type: [CategoryNameBody] }) names!: CategoryNameBody[];
  @ApiProperty({ description: '0 for a department.' }) depth!: number;
  @ApiProperty({ description: 'Place among the siblings, from 0, in the order the editor set.' })
  position!: number;
  @ApiProperty({ description: 'False: the category stays out of the main menu.' })
  showInMenu!: boolean;
  @ApiProperty({ description: 'The version of this category.' }) version!: number;
  @ApiProperty({ type: CategoryCountsBody }) counts!: CategoryCountsBody;
}

export class ActionAnswerBody {
  @ApiProperty() allowed!: boolean;
  @ApiProperty({
    required: false,
    enum: ['access.permission-missing', 'access.acting-as-refused', 'category.not-active'],
  })
  denial?: string;
}

export class CategoryTreeBody {
  @ApiProperty({ description: 'The version of the Market tree.' }) treeVersion!: number;
  @ApiProperty() defaultLocale!: string;
  @ApiProperty({ type: [String] }) supportedLocales!: string[];
  @ApiProperty({ type: [String], description: 'Locales every category needs a name in.' })
  requiredLocales!: string[];
  @ApiProperty({ description: 'False when the counts hit their time bound: they are "at least".' })
  complete!: boolean;
  @ApiProperty({ type: [CategoryRowBody], description: 'Depth first, siblings in order.' })
  categories!: CategoryRowBody[];
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'object' },
    description: 'Action code to { allowed, denial? } for the page.',
  })
  actions!: Record<string, ActionAnswerBody>;
}

export class CategoryPathEntryBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
}

export class CategoryRevisionBody {
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ description: 'created, renamed, moved, merged or archived.' })
  changeKind!: string;
  @ApiProperty({ enum: ['seed', 'admin'] }) authorKind!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) authorAccountId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) parentId!: string | null;
  @ApiProperty({ type: [CategoryNameBody] }) names!: CategoryNameBody[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class CategoryTextBody {
  @ApiProperty({ description: 'A BCP 47 locale code.' }) locale!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) shortDescription!: string | null;
  @ApiProperty({ type: [String] }) keywords!: string[];
}

export class CategorySeoBody {
  @ApiProperty({ nullable: true, type: String, description: 'English only, at most 60.' })
  title!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'English only, at most 160.' })
  description!: string | null;
  @ApiProperty() noindex!: boolean;
}

export class CategoryEditDetailsBody {
  @ApiProperty({
    type: [CategoryTextBody],
    description: 'Per locale; a locale not listed is Missing.',
  })
  texts!: CategoryTextBody[];
  @ApiProperty({ type: CategorySeoBody }) seo!: CategorySeoBody;
  @ApiProperty() showInMenu!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) imageId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'The category whose Hide hid this one; null when hidden on its own.',
  })
  hiddenById!: string | null;
}

export class CategoryDetailBody {
  @ApiProperty({ type: CategoryRowBody }) category!: CategoryRowBody;
  @ApiProperty({ type: [CategoryPathEntryBody], description: 'Root first, the category last.' })
  path!: CategoryPathEntryBody[];
  @ApiProperty({ type: [String] }) requiredLocales!: string[];
  @ApiProperty({ type: [String], description: 'Required locales with no name yet.' })
  missingLocales!: string[];
  @ApiProperty({ type: [CategoryRevisionBody], description: 'Newest first, at most 200.' })
  revisions!: CategoryRevisionBody[];
  @ApiProperty() complete!: boolean;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'object' },
    description: 'Action code to { allowed, denial? } for this category.',
  })
  actions!: Record<string, ActionAnswerBody>;
  @ApiProperty({ type: CategoryEditDetailsBody, description: 'What the edit form starts from.' })
  details!: CategoryEditDetailsBody;
  @ApiProperty({ description: 'The tree version a structural change of this category must name.' })
  treeVersion!: number;
}

export class CategoryImpactBody {
  @ApiProperty({ enum: ['move', 'merge', 'archive'] }) action!: string;
  @ApiProperty({ description: 'Published products in the subtree.' }) products!: number;
  @ApiProperty({ description: 'Published products that name the category itself.' })
  directProducts!: number;
  @ApiProperty({ description: 'Non-deleted Offers on those products.' }) offers!: number;
  @ApiProperty({ description: 'Listed Offers on those products.' }) listedOffers!: number;
  @ApiProperty({ description: 'Offers with an active certification tag.' })
  offersWithActiveTag!: number;
  @ApiProperty({ description: 'Categories under this one, any status.' }) descendants!: number;
  @ApiProperty({ description: 'False when the time bound ran out: every count is "at least".' })
  complete!: boolean;
}

// Requests and answers of the tree editor (categories package C3a).

export class CategoryTextRequest {
  @ApiProperty({ description: '1 to 120 characters.' }) name!: string;
  @ApiProperty({ required: false, nullable: true, description: 'At most 300 characters.' })
  shortDescription?: string | null;
  @ApiProperty({ required: false, type: [String], description: 'At most 20, each 1 to 40.' })
  keywords?: string[];
}

export class CategorySeoRequest {
  @ApiProperty({ required: false, nullable: true, description: 'English only, at most 60.' })
  title?: string | null;
  @ApiProperty({ required: false, nullable: true, description: 'English only, at most 160.' })
  description?: string | null;
  @ApiProperty({ required: false }) noindex?: boolean;
}

export class CategoryCreateRequest {
  @ApiProperty({
    required: false,
    nullable: true,
    format: 'uuid',
    description: 'Null: a department.',
  })
  parentId?: string | null;
  @ApiProperty({ description: 'English URL name: lower-case words with hyphens, 2 to 80.' })
  slug!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'object' },
    description:
      'Locale to { name, shortDescription?, keywords? }. The default locale is required.',
  })
  texts!: Record<string, CategoryTextRequest>;
  @ApiProperty({ required: false, type: CategorySeoRequest }) seo?: CategorySeoRequest;
  @ApiProperty({ required: false }) showInMenu?: boolean;
  @ApiProperty({ description: 'The tree version the page read.' }) treeVersion!: number;
}

export class CategoryEditDetailsRequest {
  @ApiProperty({ description: 'The category version the admin saw.' }) version!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'object' },
    description: 'The whole content per locale; a locale or field left out is cleared.',
  })
  texts!: Record<string, CategoryTextRequest>;
  @ApiProperty({ required: false, type: CategorySeoRequest }) seo?: CategorySeoRequest;
  @ApiProperty({ required: false }) showInMenu?: boolean;
  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Not yet supported: must be null until the category image intake exists.',
  })
  imageId?: string | null;
}

export class CategoryTreeVersionRequest {
  @ApiProperty({ description: 'The tree version the page read.' }) treeVersion!: number;
}

export class CategoryReorderRequest extends CategoryTreeVersionRequest {
  @ApiProperty({ enum: ['up', 'down'] }) direction!: string;
}

export class CategoryChangeSlugRequest extends CategoryTreeVersionRequest {
  @ApiProperty({ description: 'The new English URL name. The old one redirects.' }) slug!: string;
}

export class CategoryWriteBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['active', 'hidden', 'archived'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ description: 'The tree version after the write.' }) treeVersion!: number;
}

export class CategoryWriteWrapBody {
  @ApiProperty({ type: CategoryWriteBody }) category!: CategoryWriteBody;
}
