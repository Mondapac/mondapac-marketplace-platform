-- Reordering the saved filters of a list (super list B0-1b): the owner moves their own filters
-- among themselves, so `position` becomes the fourth column the application may change. The
-- store, list and owner still never change after the insert.
GRANT UPDATE ("position") ON "lists"."saved_filters" TO "mondapac_app";
