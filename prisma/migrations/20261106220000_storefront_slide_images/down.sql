-- Reverses 20261106220000_storefront_slide_images.
-- Development and CI only: the slide images are lost (their files stay in the object store).
REVOKE SELECT, INSERT ON TABLE "storefront"."slide_image_renditions" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "storefront"."slide_images" FROM "mondapac_app";
DROP TABLE "storefront"."slide_image_renditions";
DROP TABLE "storefront"."slide_images";
