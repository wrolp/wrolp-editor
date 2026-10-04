//! Windows Explorer context-menu integration: add/remove an HKCU registry entry,
//! which needs no administrator rights.

pub const MENU_NAME: &str = "WROLP Editor";
pub const MENU_LABEL: &str = "Open with WROLP";
const SHELL_ROOT: &str = r"Software\Classes\*\shell";

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

/// Whether the entry is already installed for the currently running executable.
#[cfg(windows)]
pub fn is_installed() -> Result<bool, String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let expected = command_value()?;
  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let actual: String = match hkcu.open_subkey(command_key_path()) {
    Ok(key) => key.get_value("").map_err(|e| e.to_string())?,
    Err(_) => return Ok(false),
  };
  Ok(actual == expected)
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
pub fn is_installed() -> Result<bool, String> {
  Ok(false)
}

#[cfg(not(windows))]
pub fn install() -> Result<String, String> {
  Err("The context menu integration is Windows-only".into())
}

#[cfg(not(windows))]
pub fn uninstall() -> Result<(), String> {
  Err("The context menu integration is Windows-only".into())
}
