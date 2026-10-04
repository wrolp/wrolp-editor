mod commands;
mod context_menu;
mod draft;

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
      commands::save_file,
      commands::get_draft,
      commands::save_draft,
      commands::clear_draft,
      commands::list_dir,
      commands::get_history,
      commands::remove_history,
      commands::get_settings,
      commands::save_settings,
      commands::is_context_menu_installed,
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
