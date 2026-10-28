/**
 * Every privilege a migration grants, checked in (docs/design/data/platform.md 10.2 and 10.5
 * guard 1). `privileges.db-spec.ts` compares the catalogs of the migrated database with this
 * map; a migration that grants, revokes or adds a table changes this file in the same PR.
 * The only grantee is the group role `mondapac_app`; the owner's own privileges are not listed.
 */
export interface ExpectedPrivileges {
  /** Schema-level privileges of `mondapac_app`, by schema. */
  readonly schemas: Readonly<Record<string, readonly string[]>>;
  /**
   * Every table of every schema that is not PostgreSQL's own, with the table-level privileges
   * of `mondapac_app` and the columns it may UPDATE when it has no table-level UPDATE.
   */
  readonly tables: Readonly<
    Record<string, { readonly table: readonly string[]; readonly columnUpdate: readonly string[] }>
  >;
  /**
   * Extensions the migrations install, each with its schema. A member function of a mapped
   * extension may be executable by PUBLIC (its owner is a superuser, so the migration role
   * cannot revoke that) only while the schema stays closed to the application: no `USAGE`, no
   * `CREATE` for anyone but its owner, and on nobody's `search_path` (platform.md 10.5 guard 1,
   * docs/design/data/sellers.md 9.2 and 9.6). Never `public`.
   */
  readonly extensions: Readonly<Record<string, string>>;
  /** Every SECURITY DEFINER function (`schema.name(arguments)`), with why it is one. */
  readonly securityDefinerFunctions: Readonly<Record<string, string>>;
}

export const EXPECTED_PRIVILEGES: ExpectedPrivileges = {
  schemas: {
    // No privilege for the application on `extensions` (see `extensions` below).
    extensions: [],
    identity: ['USAGE'],
    inventory: ['USAGE'],
    cart: ['USAGE'],
    ordering: ['USAGE'],
    payments: ['USAGE'],
    platform: ['USAGE'],
    catalog: ['USAGE'],
    certification: ['USAGE'],
    commission_payouts: ['USAGE'],
    wallet: ['USAGE'],
    reviews: ['USAGE'],
    promotions: ['USAGE'],
    customers: ['USAGE'],
    engagement: ['USAGE'],
    assistant: ['USAGE'],
    legal: ['USAGE'],
    tax: ['USAGE'],
    storefront: ['USAGE'],
    blog: ['USAGE'],
    pricing: ['USAGE'],
    sellers: ['USAGE'],
    shipping: ['USAGE'],
    notifications: ['USAGE'],
    search: ['USAGE'],
  },
  tables: {
    // docs/design/data/identity.md section 7: DELETE only for the unverified purge and erasure
    // (A2, H5); the credential goes with its account by the cascade, so it has no DELETE.
    'identity.accounts': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.password_credentials': {
      table: ['INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (slice 2): sessions and throttle counters are
    // ordinary tables (revocation, the last_seen_at write, the purge, a cleared counter); sign-in
    // records are append-only with retention, so no UPDATE (H6).
    'identity.sessions': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.sign_in_records': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'identity.sign_in_throttles': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (PM2): the envelope is immutable to the application.
    'identity.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // docs/design/data/identity.md section 7 (slice 3): a link row is reused per account and
    // purpose and purged when consumed or expired; the inbox gets DELETE with its prune job.
    'identity.one_time_links': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/identity.md section 7 (slice 5): ordinary tables, except the keys of a
    // role, which are added or removed and never edited.
    'identity.seller_access': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.seller_step_up_policies': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.step_up_proofs': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.seller_memberships': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.roles': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'identity.role_permissions': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'identity.role_assignments': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (slice 7): ordinary tables; recovery codes are
    // replaced at regeneration (DELETE), voided challenges and a reset factor are deleted.
    'identity.second_factors': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.recovery_codes': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.sign_in_challenges': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'identity.invitations': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (slice 9; H6): a decision is append-only by privilege.
    'identity.access_decisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Social sign-in: a provider identity is written once; it goes with its account (cascade).
    'identity.external_identities': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'platform.audit_log': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/platform.md 11.6 (identity slice 6a): append-only like the audit log;
    // INSERT moves to a worker-only group before the hardening trigger (11.6, PA 13).
    'platform.audit_log_seal': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'platform.audit_chain_checkpoint': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // SOC package 1 (docs/design/data/platform.md 13): insert-only events; DELETE
    // for the retention job only, which a trigger refuses for a row younger than its floor.
    'platform.security_events': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'platform.security_events_archive': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // Buyer assistant package 1 (identity design 13): the shared rate-limit counters, counted
    // and purged by the PostgreSQL store of rate-limiter-flexible.
    'platform.rate_limit_counters': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/identity.md section 7 (slice 3; PM3): the envelope copy is immutable to
    // the application; DELETE arrives with the prune job.
    'platform.event_delivery': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'attempts',
        'dead_at',
        'delivered_at',
        'error_code',
        'next_attempt_at',
        'status',
      ],
    },
    // docs/design/data/identity.md section 7 (PF 4): a tombstone, no DELETE; the identity
    // columns are frozen by the trigger as well.
    'platform.subject_keys': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['wrapped_key', 'wrapping_key_id', 'rewrapped_at', 'destroyed_at'],
    },
    // docs/design/data/sellers.md section 8 (slice 1): the outbox is immutable to the application
    // but for the relay's mark; the inbox gets DELETE with the prune job; the four roots have no
    // DELETE until the purge of slice 18.
    // docs/design/data/certification.md section 8 (migration 1): outbox and inbox as every module;
    // the type root and the issuers change only the listed columns (code, verification mode and
    // type are immutable); the root of a seller certificate is mutable; revisions, submissions and
    // decisions are insert-only, backed by the triggers of 6.1.
    'certification.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'certification.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.certification_types': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['published_revision_id', 'status', 'version'],
    },
    'certification.certification_type_revisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.issuers': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'accreditation_number',
        'display_name',
        'display_name_key',
        'expert_reference_ciphertext',
        'state',
        'state_changed_at',
        'state_changed_by_account_id',
        'state_changed_by_kind',
        'version',
      ],
    },
    // DELETE only for a draft that was never submitted (certificate slice 3).
    'certification.seller_certifications': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'certification.seller_certification_submissions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'certification.seller_submission_decisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Migration 2 (types registry): texts and terms are insert-only (6.1 triggers); a channel is
    // only retired; a relaxation proposal only decided; platform subject keys never change.
    'certification.type_revision_texts': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.claim_terms': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.issuer_contact_channels': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['retired_at'],
    },
    'certification.relaxation_proposals': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['decided_at', 'decided_by_account_id', 'state', 'version'],
    },
    'certification.platform_subjects': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Migration 3 (seller certificate submit): files are written once and deleted with an unsent
    // draft; quotas and rate counters are counters; the draft links come and go; the submission
    // links and the history are insert-only (triggers).
    'certification.uploaded_documents': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'certification.seller_draft_quotas': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'certification.rate_counters': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'certification.seller_certification_draft_documents': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'certification.seller_submission_documents': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.seller_certification_history': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Migration 4 (admin review): checks, scope readings and issuer confirmations are insert-only
    // (triggers); the two keyed indexes also get DELETE for erasure and for a removed draft file (L4).
    'certification.submission_review_checks': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.submission_scope_readings': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.seller_issuer_confirmations': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.certificate_number_index': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'certification.document_index': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // Migration 5 (issuer requests, slice 6): a request is never deleted and its typed name never
    // changes; only the answer columns move, once (guard trigger). The file links are insert-only.
    'certification.issuer_requests': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'answer_reason_code',
        'answered_at',
        'answered_by_account_id',
        'issuer_id',
        'state',
        'version',
      ],
    },
    'certification.issuer_request_documents': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Migration 7 (expiry warnings, slice 9; data design 9.1): one marker per (version, threshold), insert-only
    // (data design 3.18; reject_mutation triggers), kept.
    'certification.expiry_warnings': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Migration claim_policies (slice 13; data design 3.14): the root moves its pointer
    // under its version; revisions and rows are insert-only (reject_mutation triggers); a retired
    // category flag is cleared once.
    'certification.claim_basis_policies': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['published_revision_id', 'version'],
    },
    'certification.claim_policy_revisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.claim_policy_rows': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.retired_category_flags': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['cleared_at', 'cleared_by_account_id'],
    },
    // Migration product_certifications (slice 14; data design 3.15, 3.16): the root moves its
    // draft, pointers, status and version; the draft's coverage is replaced whole and its editors
    // cleared on approval (DELETE); revisions, their coverage, editors and decision, the issuer
    // confirmation and the history are insert-only (reject_mutation triggers).
    'certification.product_certifications': {
      table: ['INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'certification.product_certification_draft_coverage': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'certification.product_certification_draft_editors': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'certification.product_certification_revisions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'certification.product_revision_coverage': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.product_revision_editors': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.product_revision_decisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.product_issuer_confirmations': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.product_certification_history': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [],
    },
    // Migration product_documents (slice 15 part 2; data design 3.15, 3.16): the draft's files are
    // added and removed; a revision's files and its review checks are insert-only.
    'certification.product_certification_draft_documents': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'certification.product_revision_documents': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'certification.product_revision_review_checks': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'sellers.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'sellers.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'sellers.seller_files': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'sellers.seller_admin_settings': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'sellers.seller_tax_profiles': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'sellers.store_profiles': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    // docs/design/data/sellers.md section 8 (slice 2): a slug and its holder never change, only
    // its state; DELETE arrived in slice 5 (Q-M21, section 22: a never-public held row is
    // released by the seller before approval, by an admin, or by the purge); rate counters are
    // reserved, released (the two reviewer-notice kinds, 3.11) and purged after 48 hours.
    'sellers.shop_slugs': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['ever_public', 'retired_at', 'state', 'version'],
    },
    // docs/design/data/sellers.md section 8 (slice 3): a tax registration period is inserted,
    // closed (valid_to is the only column that changes) and, while it has not started, deleted.
    'sellers.tax_registration_periods': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['valid_to'],
    },
    'sellers.rate_counters': { table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    // docs/design/data/sellers.md section 8 (slice 4a): the latest register result per file and
    // value is written and rewritten; DELETE arrives with the purge of slice 18.
    'sellers.register_checks': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    // docs/design/data/sellers.md sections 3.3, 3.6, 3.13 (slice 7a-decide): a review check is
    // recorded again in place; a claim is inserted or released, never changed; a flag is raised
    // and later cleared, its other columns fixed.
    'sellers.review_checks': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    'sellers.identifier_claims': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'sellers.admin_flags': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['cleared_at', 'cleared_by_account_id'],
    },
    // docs/design/data/sellers.md section 8 (slice 5, section 22): a revision's content never
    // changes by privilege; only the status columns do. DELETE arrives with the purge (18).
    'sellers.business_file_revisions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'decided_at',
        'decided_by_account_id',
        'identity_decision_id',
        'reject_reason_code',
        'status',
        'status_changed_at',
        'withdraw_cause',
        'withdrawn_at',
        'withdrawn_by_kind',
      ],
    },
    // docs/design/data/sellers.md 3.8 (slice 12 part 2): a store profile revision is insert-only; the
    // current logo or banner row of a kind is replaced by deleting it and inserting the new one,
    // and its renditions go by the foreign key cascade.
    'sellers.store_profile_revisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'sellers.store_images': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'sellers.store_image_renditions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/inventory.md section 7 (slice 1): the inbox gets DELETE with the prune job;
    // a seller inventory is never deleted and a source has no delete in the brief; the seller,
    // the key columns and the Default flag are immutable, so UPDATE is by column.
    'inventory.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'inventory.seller_inventories': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['low_stock_threshold', 'version'],
    },
    'inventory.sources': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['address', 'name', 'priority', 'time_zone'],
    },
    // docs/design/data/inventory.md section 7 (slice 2): the outbox is immutable to the application
    // but for the relay's mark; stock items are retired, never deleted, and their key columns never
    // change; the ledger is append-only by privilege; a tombstone is inserted or cleared, never
    // edited; the signal's key columns never change.
    'inventory.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'inventory.stock_items': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['hold_seq', 'on_hand', 'retired_at', 'version'],
    },
    'inventory.stock_movements': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'inventory.availability_signals': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['changed_at', 'only_left', 'status', 'version'],
    },
    'inventory.retirements': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/inventory.md section 7 (slices 4 and 5): a reservation's expiry and a line's
    // quantity and sell-unit ids never change; DELETE on reservations is for the prune job only
    // (lines go by cascade); an Offer's purchase limit is cleared by deleting it.
    'inventory.reservations': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['release_cause', 'status', 'status_changed_at', 'version'],
    },
    'inventory.reservation_lines': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['order_line_id', 'state', 'state_changed_at', 'stock_item_id'],
    },
    'inventory.rate_counters': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'inventory.offer_purchase_limits': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['max_per_customer', 'version'],
    },
    // Cart (speed mode): a cart is deleted only by the purge job (cart.purge-inactive, hourly; an
    // expired guest cart is also ignored at read time; a merged one is kept so a replay is
    // recognised); its owner columns and status change on a merge, and its order mark is set when
    // a paid order clears lines and cleared by the next change (personalization 1c). A line is
    // deleted on remove and by the cascade of the purge; only its quantity, price-at-add and add
    // instant change.
    'cart.carts': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [
        'account_id',
        'guest_token_hash',
        'last_changed_at',
        'merged_at',
        'merged_into_cart_id',
        'ordered_at',
        'status',
        'version',
      ],
    },
    'cart.cart_lines': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['added_at', 'price_at_add_amount', 'price_at_add_currency', 'quantity'],
    },
    'cart.rate_counters': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['count', 'window_started_at'],
    },
    // Saved for later: saved again moves the item to the top; removed, moved to the cart or
    // purged a year after it was last saved.
    'cart.saved_items': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: ['saved_at'] },
    // Ordering (Phase 5 package 1): no row is ever deleted. Seller orders and lines are written
    // once; an order's state, payment state, Stripe ids, times and version change.
    'ordering.orders': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'cancel_reason',
        'cancelled_at',
        'confirmed_at',
        'payment_state',
        'status',
        'stripe_payment_intent_id',
        'stripe_session_id',
        'version',
      ],
    },
    // Phase 5 package 4: a seller order's fulfilment steps (to-ship, shipped, delivered) change
    // the fulfilment columns only; the amounts never change.
    'ordering.seller_orders': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'carrier',
        'delivered_at',
        'delivery_attention',
        'fulfilment',
        'inventory_recorded_at',
        'ledger_attempts',
        'ledger_state',
        'ready_at',
        'refunded_amount',
        'shipped_at',
        'tracking_ref',
      ],
    },
    // Commission-payouts (Phase 5 package 5): a seller's own commission rate is set, changed and
    // removed (back to the Market rate); the ledger is insert-only (a trigger also refuses UPDATE,
    // DELETE and TRUNCATE for every role).
    'commission_payouts.seller_commission_rates': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['rate_bps', 'updated_at', 'updated_by'],
    },
    'commission_payouts.ledger_entries': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Package 6b: the inbox is appended to; a seller's payout terms override is set, changed and
    // removed (back to the Market's terms); an eligibility anchor is written once (a trigger
    // refuses UPDATE and DELETE); a payout hold is inserted and released (a trigger allows only the
    // three release columns, once, and refuses DELETE).
    'commission_payouts.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'commission_payouts.payout_terms_overrides': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [
        'approval_mode',
        'hold_days_carrier',
        'hold_days_seller_click',
        'local_minute',
        'minimum_minor',
        'schedule_weekdays',
        'updated_at',
        'updated_by',
        'version',
      ],
    },
    'commission_payouts.eligibility_anchors': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'commission_payouts.payout_holds': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['release_reason', 'released_at', 'released_by'],
    },
    // Package 8b: a dispute case is inserted and refreshed (its state columns only; a trigger keeps
    // the identity columns and the one-way flags), a decision is insert-only (a trigger refuses
    // more), and commission-payouts has its own outbox (the relay marks events published).
    'commission_payouts.dispute_cases': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'bucket',
        'closed',
        'closed_at',
        'evidence_due_by',
        'funds_reinstated',
        'funds_reinstated_at',
        'funds_withdrawn',
        'funds_withdrawn_at',
        'inquiry',
        'last_synced_version',
        'outcome',
        'reason',
        'status',
        'updated_at',
      ],
    },
    'commission_payouts.dispute_decisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'commission_payouts.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // Wallet (customer wallet package 1): journals, their legs and a hold's lots are insert-only
    // (triggers refuse more for every role); the rest change only the columns named and are never
    // deleted (a trigger refuses DELETE and TRUNCATE for every role).
    'wallet.journals': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'wallet.postings': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'wallet.hold_lots': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'wallet.accounts': { table: ['INSERT', 'SELECT'], columnUpdate: ['status'] },
    'wallet.lots': { table: ['INSERT', 'SELECT'], columnUpdate: ['remaining_minor'] },
    'wallet.holds': { table: ['INSERT', 'SELECT'], columnUpdate: ['resolved_at', 'status'] },
    'wallet.balances': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['available_minor', 'held_minor', 'updated_at'],
    },
    'wallet.market_settings': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['reason_code', 'status', 'updated_at', 'updated_by_account_id'],
    },
    // Admin credit (package 2a): a request is written once and decided once; a day row is
    // written once and then only locked. Neither is ever deleted (a trigger refuses it).
    'wallet.admin_credit_requests': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'decided_at',
        'decided_by_account_id',
        'decision_reason_code',
        'journal_id',
        'status',
      ],
    },
    'wallet.admin_credit_days': { table: ['INSERT', 'SELECT'], columnUpdate: ['locked_at'] },
    // Reviews (buyer reviews and ratings, package 1): the moderation log and the signals are
    // insert-only (triggers refuse more for every role); the rest change only the columns named
    // and are never deleted (a trigger refuses DELETE and TRUNCATE for every role).
    'reviews.moderation_actions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'reviews.review_signals': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'reviews.product_reviews': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'account_id',
        'anonymous',
        'body',
        'created_at',
        'deleted_at',
        'edited_at',
        'last_purchase_at',
        'last_seller_order_id',
        'locale',
        'offer_id',
        'published_at',
        'rating',
        'seller_id',
        'status',
        'title',
      ],
    },
    'reviews.seller_ratings': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['account_id', 'seller_order_id', 'status'],
    },
    'reviews.review_replies': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['body', 'edited_at', 'status'],
    },
    'reviews.review_reports': { table: ['INSERT', 'SELECT'], columnUpdate: ['status'] },
    'reviews.rating_summaries': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'arrived_ok_yes',
        'as_described_yes',
        'count',
        'histogram_1',
        'histogram_2',
        'histogram_3',
        'histogram_4',
        'histogram_5',
        'rated_seller_orders',
        'rebuilt_at',
        'satisfied_count',
        'sum',
      ],
    },
    'reviews.market_settings': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['status', 'updated_at', 'updated_by_account_id'],
    },
    // Blog (blog package 1): a post changes its slug, status, pointers, schedule and stamps (never
    // its kind, owner or seller); a version's content and review stamps change while it is a draft
    // or is decided (a trigger refuses the rest); links and tags are rewritten with the draft; an
    // event's status changes at once; a redirect is removed when its post takes the slug back; a
    // category and its names are changed and deleted; a quota row is counted. Outbox as every module.
    'blog.posts': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'draft_version_id',
        'featured',
        'live_version_id',
        'paused_reason',
        'published_at',
        'quota_period',
        'row_version',
        'scheduled_at',
        'scheduled_by',
        'slug',
        'status',
        'unpublished_at',
        'updated_at',
        'updated_by',
      ],
    },
    'blog.post_versions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'author_display',
        'body',
        'category_id',
        'cover_alt',
        'cover_image_id',
        'decided_at',
        'decided_by',
        'decision',
        'decision_note',
        'excerpt',
        'published_at',
        'published_by',
        'self_approved',
        'seo_description',
        'seo_title',
        'state',
        'submitted_at',
        'submitted_by',
        'title',
        'updated_at',
      ],
    },
    'blog.post_events': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [
        'address',
        'attendance',
        'ends_at',
        'event_status',
        'registration_url',
        'starts_at',
        'status_message',
        'time_zone',
        'venue_name',
      ],
    },
    'blog.post_links': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'blog.post_tags': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'blog.redirects': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'blog.categories': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['position', 'updated_at', 'updated_by'],
    },
    'blog.category_names': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['name'],
    },
    'blog.tags': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['name'],
    },
    'blog.seller_quotas': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['updated_at', 'used'],
    },
    'blog.outbox': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['published_at'],
    },
    'blog.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Promotions (package T1): a promotion changes only the columns named and is never deleted;
    // usage is insert-only; the target list and the zone thresholds may be deleted; the rest
    // change only the columns named (triggers refuse DELETE and TRUNCATE where it is not granted).
    'promotions.promotions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'budget_minor',
        'cap_minor',
        'combinable',
        'ends_at',
        'max_per_order_minor',
        'max_total_uses',
        'max_uses_per_customer',
        'min_spend_minor',
        'name',
        'paused_by',
        'platform_split_bps',
        'prior_approved',
        'reward_amount_minor',
        'reward_bps',
        'reward_kind',
        'special_campaign',
        'starts_at',
        'status',
        'test_mode',
        'updated_at',
      ],
    },
    'promotions.promotion_targets': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'promotions.promotion_usage': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'promotions.co_funding_opt_ins': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['decided_by_account_id', 'opted_in_at', 'withdrawn_at'],
    },
    'promotions.promotion_reviews': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['decided_at', 'decided_by_account_id', 'status'],
    },
    'promotions.first_order_settings': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'amount_minor',
        'cap_minor',
        'enabled',
        'kind',
        'min_spend_minor',
        'monthly_budget_minor',
        'percent_bps',
        'updated_at',
        'updated_by_account_id',
      ],
    },
    'promotions.free_shipping_thresholds': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['threshold_minor', 'updated_at', 'updated_by_account_id'],
    },
    'promotions.market_settings': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['status', 'updated_at', 'updated_by_account_id'],
    },
    // Storefront: a page is created and changed (never its kind, key or template) and never
    // deleted; a version's content and state change; a redirect is removed when its page takes the
    // old slug back.
    'storefront.pages': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'archived_at',
        'archived_redirect',
        'ends_at',
        'linked_id',
        'linked_type',
        'seo',
        'slug',
        'starts_at',
        'title',
        'updated_at',
        'updated_by',
      ],
    },
    'storefront.page_versions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'placements',
        'published_at',
        'published_by',
        'settings',
        'state',
        'updated_at',
        'updated_by',
      ],
    },
    'storefront.redirects': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // Storefront slides: a slide is created and changed (never its kind) and never deleted; a
    // version is insert-only except its approval stamp; the placement projection is rebuilt
    // (inserted and deleted); a position lock is created and touched.
    'storefront.slides': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'draft_version_id',
        'ends_at',
        'internal_name',
        'live_version_id',
        'pinned',
        'row_version',
        'sponsored',
        'starts_at',
        'state',
        'submitted_version_id',
        'updated_at',
        'updated_by',
      ],
    },
    'storefront.slide_versions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['approved_at', 'approved_by'],
    },
    // The reorder of live slides rewrites only the sort order of a projection row, and replaces
    // the saved order of a placement (deleted and inserted).
    'storefront.slide_placements': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['sort_order'],
    },
    'storefront.slide_saved_orders': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'storefront.slide_position_locks': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['touched_at'],
    },
    // Tax: an admin-defined strategy is inserted, changed (name, parameters, active flag) and
    // removed.
    'tax.tax_strategies': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['active', 'config', 'kind', 'name', 'updated_at', 'updated_by'],
    },
    // Customers (package 1): a customer adds, changes (sealed content, default flag) and removes
    // their own delivery addresses.
    'customers.addresses': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['content_ciphertext', 'is_default', 'updated_at'],
    },
    // Customers (package 5a): the account deletion setting is insert-only versions (the reason is
    // part of the audit evidence); the outbox is immutable to the application except the relay's
    // published_at.
    'customers.account_deletion_settings': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Package 5b: a deletion request is inserted and moved on (only the state columns: status, the
    // job's claim and the closing columns), never deleted.
    'customers.account_deletion_requests': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['cancel_reason', 'cancelled_at', 'claimed_at', 'completed_at', 'status'],
    },
    'customers.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // Legal (personalization 1b): the current marketing consent changes (granted, source, time)
    // and is never removed by the API; its history is append-only.
    'legal.marketing_consents': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['changed_at', 'granted', 'source'],
    },
    'legal.marketing_consent_changes': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Engagement (personalization 1a): behaviour events are inserted and deleted (retention purge,
    // switch off, account deletion), never changed; the switch changes and goes with the account.
    'engagement.behaviour_events': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'engagement.personalization_settings': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['changed_at', 'enabled'],
    },
    // Engagement (personalization 1d-3): a block count is inserted by its first event of the day,
    // then only its counters and time change (the upsert); the retention purge deletes it.
    'engagement.block_counts': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['clicks', 'impressions', 'updated_at'],
    },
    // Shipping (Phase 5 package 4): one flat fee row per seller and Market; the fee columns
    // change, the identity never, and no row is deleted.
    'shipping.seller_flat_fees': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['amount', 'currency', 'updated_at', 'updated_by'],
    },
    // Shipping, the real-time carrier (SHP-02/03): a booking is stored once the carrier confirms
    // it and only its progress moves; a carrier webhook event is taken once by its id; shipping
    // writes `shipping.carrier-delivery-progressed.v1` and ordering records each one it handled.
    'shipping.carrier_bookings': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['carrier_status', 'progress', 'updated_at', 'version'],
    },
    'shipping.carrier_events': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Delivery models, package 3 (the fleet router): selection models are created and edited,
    // never deleted; one active-model row per Market and method and one reliability score per
    // fleet are written once and changed; a booking attempt is written, moved and removed.
    'shipping.fleet_selection_models': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['kind', 'name', 'rule', 'updated_at', 'updated_by', 'version'],
    },
    'shipping.fleet_selection_assignments': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['model_id', 'updated_at', 'updated_by'],
    },
    'shipping.fleet_reliability': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['score', 'updated_at', 'updated_by'],
    },
    // Delivery models, package 4: the Market's delivery settings and the methods taken away from a
    // seller are written once and changed; never deleted.
    'shipping.delivery_settings': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'instant_enabled',
        'margin_basis_points',
        'margin_fixed_minor',
        'margin_kind',
        'pickup_enabled',
        'rounding_step_minor',
        'same_day_cutoff_minutes',
        'same_day_enabled',
        'scheduled_days_ahead',
        'scheduled_enabled',
        'scheduled_window_minutes',
        'updated_at',
        'updated_by',
        'version',
      ],
    },
    'shipping.seller_delivery_methods': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['unsupported', 'updated_at', 'updated_by'],
    },
    'shipping.fleet_booking_attempts': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['attempted_at', 'fleet'],
    },
    'shipping.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // Delivery models, package 2: the pickup code of a seller order handed over in person. A code is
    // created, counted against (failures, lock) and replaced; never deleted.
    'ordering.pickup_codes': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['code_hash', 'code_sealed', 'failed_attempts', 'issued_at', 'locked_at'],
    },
    'ordering.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Phase 6 package 1: the order emails. Ordering writes `ordering.order-paid.v1` (the relay marks
    // it published); notifications records each event it handled, once per handler.
    'notifications.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'ordering.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    // Buyer assistant settings: insert-only versions, like the support contact.
    'assistant.settings': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Buyer assistant package 4: conversations are created, counted (turns and last message time
    // only) and purged; messages are written once and go with their conversation (the cascade
    // needs no DELETE on them); spend days are counted up and never deleted.
    'assistant.conversations': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['last_message_at', 'turns'],
    },
    'assistant.messages': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'assistant.spend_days': { table: ['INSERT', 'SELECT', 'UPDATE'], columnUpdate: [] },
    // Notifications (support contact): a change is a new version row; none is updated or deleted.
    'notifications.support_contacts': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // In-app notifications package 1: a notice is written once and deleted by retention (90 days,
    // 200 per seller); a read is insert-only and leaves with its notice by the cascade.
    'notifications.in_app_notices': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'notifications.in_app_notice_reads': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Personalization 1c: a cart reminder is taken once per account, cart change and stage, never
    // updated, and deleted by retention (30 days, the reminder job).
    'notifications.cart_reminders': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    // Search (Phase 6 package 2): a projection of catalog, upserted by events and the rebuild job
    // and deleted when an Offer is no longer sellable. The vector is set by a trigger, so it is
    // not an updatable column for the application.
    'search.offer_documents': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: [
        'category_ids',
        'indexed_at',
        'locale',
        'name',
        'product_id',
        'seller_id',
        'short_text',
        'text_search_config',
      ],
    },
    'ordering.order_lines': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Tax step 3: a refund is written once and only settles (state, Stripe refund id, attempts,
    // settled time); its lines and its credit note are insert-only. No row is deleted. Package 6a:
    // once settled it moves only the two ledger bookkeeping columns (marker set once, counter up).
    'ordering.refunds': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'attempts',
        'ledger_attempts',
        'ledger_recorded_at',
        'settled_at',
        'state',
        'stripe_refund_id',
      ],
    },
    // Personalization 1d-2: the nightly job deletes a Market's pairs and inserts the new ones.
    'ordering.offer_pairs': { table: ['DELETE', 'INSERT', 'SELECT'], columnUpdate: [] },
    'ordering.refund_lines': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'ordering.credit_notes': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Payments (Phase 5 package 2): a verified Stripe event is inserted once; the worker counts
    // its attempts and marks it done. No row is deleted.
    // Payments (Phase 5 package 3): one connected account row per seller and Market; the state
    // columns change as Stripe reports, the identity columns never. No row is deleted.
    // Payments (Phase 5 package 3 leftovers): the waiting period, the payout pause and its applied
    // state are columns the application moves; the change history is insert-only.
    'payments.connected_accounts': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'account_ref',
        'cooling_off_until',
        'details_submitted',
        'external_account_hmac',
        'last_change_id',
        'last_read_at',
        'payout_schedule_applied',
        'payout_schedule_revision',
        'payouts_enabled',
        'payouts_paused_until',
        'requirements_due',
        'requirements_past_due',
        'status',
        'transfers_active',
        'updated_at',
      ],
    },
    'payments.disputes': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'evidence_due_by',
        'funds_reinstated',
        'funds_reinstated_at',
        'funds_withdrawn',
        'funds_withdrawn_at',
        'last_read_at',
        'outcome',
        'reason',
        'status',
        'updated_at',
        'version',
      ],
    },
    'payments.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'payments.payout_account_changes': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Package 6c: a transfer is inserted once; only its state, Stripe id, reversed amount, send
    // count, lease and instants move (a trigger keeps the machine); the content never changes.
    'payments.transfer_executions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'abandoned_at',
        'executed_at',
        'failure_code',
        'fence_breached_at',
        'lease_until',
        'provider_transfer_ref',
        'reversed_minor',
        'send_count',
        'state',
        'updated_at',
        'version',
      ],
    },
    'payments.stripe_events': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['attempts', 'next_attempt_at', 'outcome', 'processed_at'],
    },
    // docs/design/data/catalog.md section 7 (slice 1): the outbox is immutable to the application
    // but for the relay's mark; no DELETE on products or variants, ever (Q-K2: a discard is a
    // status and a retired variant). The identity columns of a product and a variant never change.
    'catalog.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'catalog.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.products': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'discarded_at',
        'last_changed_at',
        'matched_into_product_id',
        'owner_seller_id',
        'own_brand',
        'pending_revision_id',
        'pending_submitted_at',
        'promoted_at',
        'published_revision_id',
        'retired_at',
        'scope',
        'status',
        'version',
        'withdrawn_at',
      ],
    },
    'catalog.product_variants': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['published_at', 'retired_at', 'state'],
    },
    'catalog.product_code_counters': { table: ['INSERT', 'SELECT'], columnUpdate: ['next_value'] },
    // docs/design/data/catalog.md section 7 (slice 2): the tree is never deleted from; a category's
    // slug and creator kind never change; revisions and their names are insert-only.
    'catalog.category_trees': { table: ['INSERT', 'SELECT'], columnUpdate: ['version'] },
    'catalog.platform_categories': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['merged_into_id', 'parent_id', 'published_revision_id', 'status', 'version'],
    },
    'catalog.platform_category_revisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.platform_category_revision_names': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/catalog.md section 7 (slice 3): definitions and families are never deleted;
    // code, type and the localizable flag stay on the root, fixed by the column grant; the
    // material and variant-option flags live in insert-only revisions.
    'catalog.attribute_definitions': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['published_revision_id', 'status', 'version'],
    },
    'catalog.attribute_definition_revisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.attribute_definition_revision_options': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [],
    },
    'catalog.attribute_families': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['published_revision_id', 'status', 'version'],
    },
    'catalog.attribute_family_revisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/catalog.md section 7 (slice 4): the working copy and the counters are
    // mutable and deleted from; the five revision tables are insert-only (CA3).
    'catalog.product_working_copies': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    'catalog.product_revisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.product_revision_texts': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.product_revision_categories': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.product_revision_variants': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.product_revision_decisions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // Photos (slice 13): a photo is inserted, read and deleted while no revision uses it; its
    // renditions go with it by the cascade; the revision's photo rows are insert-only. A photo's state
    // and its takedown columns are updated (takedown, forward-only by trigger).
    'catalog.product_images': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['state', 'taken_down_at', 'taken_down_by_account_id', 'takedown_reason_code'],
    },
    'catalog.product_image_renditions': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.product_revision_images': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'catalog.rate_counters': {
      table: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      columnUpdate: [],
    },
    // docs/design/data/catalog.md section 7 (slice 7): no DELETE on offers (Q-K2: a discarded
    // draft's Offer becomes `deleted`); the seller, identity and creation columns never change;
    // the Offer history is insert-only (CA3).
    'catalog.offers': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'attestation_account_id',
        'attestation_recorded_at',
        'condition_code',
        'deleted_at',
        'description',
        'first_published_at',
        'handling',
        'listed',
        'off_sale_description_claim_text',
        'off_sale_product_not_listed',
        'off_sale_product_retired',
        'off_sale_tag_suspended',
        'off_sale_type_not_allowed',
        'product_id',
        'seller_sku',
        'status',
        'submitted_at',
        'version',
      ],
    },
    'catalog.offer_history': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/catalog.md 3.15, 3.16 (slice 8): a tag's type, Offer, seller and creation
    // never change; its status, claim copy and removal do. The history is insert-only.
    'catalog.offer_tags': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'badge_data',
        'basis',
        'certificate_id',
        'certificate_kind',
        'certificate_version_id',
        'change_seq',
        'copy_revision_id',
        'copy_revision_published',
        'evaluated_at',
        'inputs_hash',
        'issuer_id',
        'last_change_cause',
        'last_reason_code',
        'policy_revision_id',
        'removed_at',
        'removed_by_account_id',
        'removed_by_kind',
        'status',
        'status_changed_at',
        'type_revision_id',
        'valid_until',
      ],
    },
    'catalog.offer_tag_history': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    // docs/design/data/catalog.md 3.18 (slice 11): the fan-out queue moves its state, cursor and
    // counts; what it names never changes. No DELETE until the purge of 10.3.
    'catalog.tag_reevaluation_requests': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['counts', 'cursor_offer_id', 'settled_at', 'state'],
    },
    // docs/design/data/catalog.md 3.27 (certification slice 15, request C-6): a warning to an Offer
    // owner moves its state, outcome, attempts and next try; what it names never changes. No
    // DELETE until a purge lands.
    'catalog.offer_owner_notices': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['attempts', 'next_attempt_at', 'outcome', 'settled_at', 'state'],
    },
    // docs/design/data/pricing.md section 7 (slice 1): the outbox is immutable to the application
    // but for the relay's mark; the inbox gets DELETE with the prune job. A series' Offer, seller
    // and currency never change; a regular record's content never changes (only its status,
    // decision, supersede and period-end columns, once each, under the write-once trigger);
    // tombstones are insert-only; the refusal counters are purged.
    'pricing.outbox': { table: ['INSERT', 'SELECT'], columnUpdate: ['published_at'] },
    'pricing.inbox': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'pricing.price_series': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: ['retire_cause', 'retired_at', 'version'],
    },
    'pricing.regular_price_records': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'decided_at',
        'decided_by_account_id',
        'decision_note',
        'decision_reason_code',
        'effective_from',
        'effective_to',
        'status',
        'supersede_cause',
        'superseded_at',
        'superseded_by_record_id',
      ],
    },
    // Special price records (slice 5): content never changes; status, decision, supersede,
    // withdraw and effective-start columns are written once under the write-once trigger.
    'pricing.special_price_records': {
      table: ['INSERT', 'SELECT'],
      columnUpdate: [
        'decided_at',
        'decided_by_account_id',
        'decision_note',
        'decision_reason_code',
        'effective_from',
        'status',
        'supersede_cause',
        'superseded_at',
        'superseded_by_record_id',
        'withdraw_cause',
        'withdrawn_at',
      ],
    },
    // Boundary markers (D 11): insert-only. Write counters: count and window, purged.
    'pricing.special_price_boundaries': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'pricing.write_rate_counters': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['count', 'window_started_at'],
    },
    'pricing.retired_offers': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'pricing.retired_variants': { table: ['INSERT', 'SELECT'], columnUpdate: [] },
    'pricing.write_refusal_throttles': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['window_started_at'],
    },
    // The per-actor counter of M7 (pricing-data 12.1: a proposed shape, pending sign-off).
    'pricing.write_refusal_actor_throttles': {
      table: ['DELETE', 'INSERT', 'SELECT'],
      columnUpdate: ['recorded_count', 'suppressed_count', 'window_started_at'],
    },
    'public._prisma_migrations': { table: [], columnUpdate: [] },
  },
  extensions: {
    // Exclusion constraints on `=` of ids (sellers tax registration periods; V2 records later).
    btree_gist: 'extensions',
  },
  securityDefinerFunctions: {},
};
