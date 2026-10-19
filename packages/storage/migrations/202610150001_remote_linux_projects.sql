-- Linux is a real remote workspace platform; preserve all existing identities.
ALTER TABLE plugin_collectors DROP CONSTRAINT plugin_collectors_platform_check;
ALTER TABLE plugin_collectors ADD CONSTRAINT plugin_collectors_platform_check CHECK(platform IN('macos','windows','linux'));
ALTER TABLE project_streams DROP CONSTRAINT project_streams_platform_check;
ALTER TABLE project_streams ADD CONSTRAINT project_streams_platform_check CHECK(platform IN('macos','windows','linux'));
ALTER TABLE project_hook_links DROP CONSTRAINT project_hook_links_platform_check;
ALTER TABLE project_hook_links ADD CONSTRAINT project_hook_links_platform_check CHECK(platform IN('macos','windows','linux'));
ALTER TABLE cleanup_project_barriers DROP CONSTRAINT cleanup_project_barriers_platform_check;
ALTER TABLE cleanup_project_barriers ADD CONSTRAINT cleanup_project_barriers_platform_check CHECK(platform IN('macos','windows','linux'));
