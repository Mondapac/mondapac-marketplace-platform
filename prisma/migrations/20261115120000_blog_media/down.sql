-- Reverses 20261115120000_blog_media.
-- Development and CI only: the blog pictures are lost (their files stay in the object store).
REVOKE SELECT, INSERT ON TABLE "blog"."media_renditions" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "blog"."media" FROM "mondapac_app";
DROP TABLE "blog"."media_renditions";
DROP TABLE "blog"."media";
