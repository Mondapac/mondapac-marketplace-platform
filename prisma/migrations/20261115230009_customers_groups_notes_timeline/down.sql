-- Reverses 20261115230009_customers_groups_notes_timeline. Accepted loss: the groups, their
-- members, the admin notes and the timeline entries (the timeline is rebuilt only from new events).
DROP TABLE "customers"."customer_timeline";
DROP TABLE "customers"."customer_notes";
DROP TABLE "customers"."customer_group_members";
DROP TABLE "customers"."customer_groups";
