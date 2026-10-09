mod commands;
mod context_menu;
mod draft;
mod encoding;
mod entry;
mod file_settings;
mod group;
mod rename;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .manage(commands::PendingFiles::default())
    .setup(|app| {
      // "Open with WROLP" hands the file path over as argv[1..].
      for path in commands::paths_from_args(std::env::args()) {
        commands::enqueue_path(app.handle(), &path);
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::take_startup_files,
      commands::open_file,
      commands::stat_file,
      commands::save_file,
      rename::rename_path,
      entry::create_file,
      entry::create_dir,
      entry::remove_entry,
      commands::get_draft,
      commands::save_draft,
      commands::clear_draft,
      commands::list_dir,
      commands::allow_asset_dir,
      commands::render_diagram,
      commands::get_file_settings,
      commands::save_file_settings,
      commands::clear_file_settings,
      file_settings::file_settings_view,
      commands::get_history,
      commands::remove_history,
      commands::get_settings,
      commands::save_settings,
      commands::get_groups,
      commands::save_groups,
      commands::transfer_tabs,
      commands::get_window_state,
      commands::save_window_state,
      commands::plan_window_placement,
      commands::context_menu_target,
      commands::install_context_menu,
      commands::uninstall_context_menu
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
