// The shapes of the sellers `my-file` answers that the setup pages read (apps/api sellers
// presentation, my-file.dto.ts). Fields the pages do not use are left out.

export type MissingPart =
  'storeName' | 'businessName' | 'phone' | 'address' | 'timezone' | 'identifier' | 'slug';

export type RegisterResult = 'matched' | 'not-matched' | 'could-not-be-checked';

export interface ZoneState {
  readonly operatingTimezone: string;
  readonly timezoneSource: string;
  readonly addressTimezone: string;
}

export type SellerStatus =
  | 'details-incomplete'
  | 'outside-service-area'
  | 'ready-to-submit'
  | 'awaiting-review'
  | 'changes-needed'
  | 'approved'
  | 'suspended'
  | 'file-check-needed';

export interface MyFile {
  readonly version: number;
  readonly status: SellerStatus;
  readonly submission: { readonly revisionNo: number; readonly submittedAt: string } | null;
  readonly latestWithdrawal: {
    readonly cause: string;
    readonly byKind: string;
    readonly at: string;
  } | null;
  readonly draftComplete: boolean;
  readonly missing: readonly MissingPart[];
  readonly general: {
    readonly storeName: string | null;
    readonly businessName: string | null;
    readonly phone: string | null;
    readonly contactEmail: string | null;
  };
  readonly address: Readonly<Record<string, string>> | null;
  readonly registeredAddress: Readonly<Record<string, string>> | null;
  readonly serviceArea: { readonly code: string; readonly sellerOnboardingEnabled: boolean } | null;
  readonly outsideServiceArea: boolean | null;
  readonly timezone: ZoneState | null;
  readonly slug: string | null;
  readonly identifier: { readonly value: string; readonly display: string } | null;
  readonly registerResult: RegisterResult | null;
  readonly zoneOptions: readonly string[];
}

export interface DraftSaved {
  readonly version: number;
  readonly draftComplete: boolean;
  readonly missing: readonly MissingPart[];
}

export interface AddressSaved extends DraftSaved {
  readonly serviceArea: MyFile['serviceArea'];
  readonly outsideServiceArea: boolean;
  readonly timezone: ZoneState | null;
  readonly zoneOptions: readonly string[];
}

export interface IdentifierSaved extends DraftSaved {
  readonly registerResult: RegisterResult | null;
}

export interface FormDescriptors {
  readonly address: {
    readonly fields: readonly {
      readonly key: string;
      readonly labelKey: string;
      readonly required: boolean;
      readonly maxLength: number;
    }[];
    readonly postcodeField: string;
    readonly regionField: string | null;
    readonly postcodePattern: string;
    readonly regions: readonly string[];
  };
  readonly timezones: Readonly<Record<string, readonly string[]>>;
  readonly phone: { readonly maxLength: number };
  readonly identifier: {
    readonly scheme: string;
    readonly labelKey: string;
    readonly required: boolean;
    readonly maxLength: number;
  };
}

export type SlugCheck = { readonly code: string; readonly slug?: string };
