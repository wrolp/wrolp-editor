//! Windows Explorer context-menu integration: add/remove an HKCU registry entry,
//! which needs no administrator rights.

use serde::Serialize;

pub const MENU_NAME: &str = "WROLP Editor";
pub const MENU_LABEL: &str = "Open with WROLP";
const SHELL_ROOT: &str = r"Software\Classes\*\shell";

/// What the menu currently launches versus what this executable would write. Exposing
/// the difference lets Settings surface a stale entry pointing at a build that can no
/// longer start, instead of pretending the menu is simply not installed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuTarget {
  /// An entry exists under HKCU, whatever it points at.
  pub installed: bool,
  /// Command value currently stored in the registry.
  pub registered: Option<String>,
  /// Command value this executable would write.
  pub expected: String,
  /// `registered` equals `expected`.
  pub matches_current: bool,
  /// The running executable is a debug build, which needs the dev server to render.
  pub debug_build: bool,
}

#[cfg(windows)]
fn shell_key_path() -> String {
  format!(r"{SHELL_ROOT}\{MENU_NAME}")
}

#[cfg(windows)]
fn command_key_path() -> String {
  format!(r"{SHELL_ROOT}\{MENU_NAME}\command")
}

/// The command line written to the registry: `"<exe>" "%1"`.
#[cfg(windows)]
fn command_value() -> Result<String, String> {
  let exe = std::env::current_exe().map_err(|e| e.to_string())?;
  Ok(format!("\"{}\" \"%1\"", exe.display()))
}

#[cfg(windows)]
pub fn probe() -> Result<MenuTarget, String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let expected = command_value()?;
  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let registered = hkcu
    .open_subkey(command_key_path())
    .and_then(|key| key.get_value::<String, _>(""))
    .ok();

  Ok(MenuTarget {
    installed: registered.is_some(),
    matches_current: registered.as_deref() == Some(expected.as_str()),
    registered,
    expected,
    debug_build: cfg!(debug_assertions),
  })
}

#[cfg(windows)]
pub fn install() -> Result<String, String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let value = command_value()?;

  let (shell, _) = hkcu
    .create_subkey(shell_key_path())
    .map_err(|e| e.to_string())?;
  shell
    .set_value("", &MENU_LABEL)
    .map_err(|e| e.to_string())?;
  let exe = std::env::current_exe().map_err(|e| e.to_string())?;
  shell
    .set_value("Icon", &format!("\"{}\",0", exe.display()))
    .map_err(|e| e.to_string())?;

  let (command, _) = hkcu
    .create_subkey(command_key_path())
    .map_err(|e| e.to_string())?;
  command.set_value("", &value).map_err(|e| e.to_string())?;
  Ok(value)
}

#[cfg(windows)]
pub fn uninstall() -> Result<(), String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  match hkcu.delete_subkey_all(shell_key_path()) {
    Ok(()) => Ok(()),
    // The key was already absent: treat it as uninstalled.
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

#[cfg(not(windows))]
pub fn probe() -> Result<MenuTarget, String> {
  Ok(MenuTarget {
    installed: false,
    registered: None,
    expected: String::new(),
    matches_current: false,
    debug_build: cfg!(debug_assertions),
  })
}

#[cfg(not(windows))]
pub fn install() -> Result<String, String> {
  Err("The context menu integration is Windows-only".into())
}

#[cfg(not(windows))]
pub fn uninstall() -> Result<(), String> {
  Err("The context menu integration is Windows-only".into())
}
