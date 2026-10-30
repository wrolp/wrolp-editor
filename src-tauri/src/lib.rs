mod backup;
mod commands;
mod context_menu;
mod crypto;
mod draft;
mod encoding;
mod entry;
mod file_settings;
mod gallery;
mod git;
mod group;
mod name_order;
mod rename;
mod unlock;
mod versioning;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    // Only read by the editor's own paste, which cannot reach the web clipboard here.
    .plugin(tauri_plugin_clipboard_manager::init())
    // Signs nothing itself: it reads the endpoint and public key from tauri.conf.json and
    // verifies every downloaded installer against that key.
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(commands::PendingFiles::default())
    .manage(unlock::UnlockStore::default())
    .manage(git::GitLocks::default())
    .manage(git::GitOps::default())
    .setup(|app| {
      // "Open with WROLP" hands the file path over as argv[1..].
      for path in commands::paths_from_args(std::env::args()) {
        commands::enqueue_path(app.handle(), &path);
      }
      // The main window is configured hidden: place it first so the first frame it paints is
      // already at the saved size (and maximized, if that is how it was left), then show it.
      if let Some(window) = app.get_webview_window("main") {
        commands::restore_window(app.handle(), &window);
        let _ = window.show();
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::take_startup_files,
      commands::open_file,
      commands::stat_file,
      commands::save_file,
      rename::rename_path,
      rename::rename_entries,
      entry::create_file,
      entry::create_dir,
      entry::copy_entry,
      entry::paste_clipboard_files,
      entry::keep_file,
      entry::remove_entry,
      commands::get_draft,
      commands::save_draft,
      commands::clear_draft,
      commands::list_dir,
      gallery::list_images,
      commands::allow_asset_dir,
      commands::render_diagram,
      commands::get_file_settings,
      commands::save_file_settings,
      commands::clear_file_settings,
      file_settings::file_settings_view,
      unlock::unlock_file,
      unlock::lock_file,
      unlock::lock_all,
      unlock::change_password,
      unlock::remove_encryption,
      unlock::save_file_as_encrypted,
      unlock::create_encrypted,
      unlock::remember_password,
      unlock::forget_password,
      unlock::recall_password,
      unlock::remembered_password_count,
      unlock::clear_remembered_passwords,
      commands::get_history,
      commands::remove_history,
      commands::remove_history_many,
      commands::clear_history,
      commands::get_folder_history,
      commands::record_folder_history,
      commands::remove_folder_history,
      commands::get_settings,
      commands::save_settings,
      commands::get_store_dirs,
      backup::create_config_backup,
      backup::list_config_backups,
      backup::open_backup_folder,
      backup::restore_config_backup,
      backup::maybe_auto_backup,
      versioning::versioning_state,
      versioning::set_version_override,
      versioning::add_version,
      versioning::get_versions,
      versioning::get_version_content,
      versioning::list_versions,
      versioning::clear_versions,
      commands::get_groups,
      commands::save_groups,
      commands::transfer_tabs,
      commands::get_window_state,
      commands::save_window_state,
      commands::plan_window_placement,
      commands::context_menu_target,
      commands::install_context_menu,
      commands::uninstall_context_menu,
      git::git_repo_info,
      git::git_init,
      git::status::git_status,
      git::status::git_repo_summary,
      git::repos::git_scan_repos,
      git::diff::git_diff,
      git::index::git_stage,
      git::index::git_unstage,
      git::index::git_discard,
      git::index::git_commit,
      git::history::git_log,
      git::history::git_commit_files,
      git::history::git_head_commit,
      git::branch::git_branches,
      git::branch::git_create_branch,
      git::branch::git_switch_branch,
      git::branch::git_delete_branch,
      git::git_cancel,
      git::auth::git_auth_view,
      git::auth::git_save_https,
      git::auth::git_save_ssh,
      git::auth::git_forget_credential,
      git::auth::git_save_identity,
      git::auth::git_clear_identity,
      git::auth::git_trust_host,
      git::auth::git_forget_host,
      git::remote::git_remotes,
      git::remote::git_fetch,
      git::remote::git_pull,
      git::remote::git_push,
      git::remote::git_conflict_sides,
      git::remote::git_resolve_conflict,
      git::remote::git_write_resolution,
      git::remote::git_delete_resolution,
      git::remote::git_merge_abort,
      git::local::git_local_ignore,
      git::local::git_local_unignore,
      git::local::git_assume_unchanged,
      git::local::git_local_view,
      git::local::git_local_state,
      git::local::git_exclude_open
    ]);

  #[cfg(windows)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      for path in commands::paths_from_args(argv) {
        commands::enqueue_path(app, &path);
      }
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
      }
    }));
  }

  builder
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
