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
  @ApiProperty({ enum: ['active', 'merged', 'archived'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) mergedIntoId!: string | null;
  @ApiProperty({ type: [CategoryNameBody] }) names!: CategoryNameBody[];
  @ApiProperty({ description: '0 for a department.' }) depth!: number;
  @ApiProperty({ description: 'Place among the siblings, from 0 (by name until C2).' })
  position!: number;
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
