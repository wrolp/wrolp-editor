//! Windows Explorer context-menu integration: add/remove HKCU registry entries, which
//! need no administrator rights.
//!
//! The verb is registered once under `*\shell`, which covers every file. Excluding a type
//! then means *hiding* that one verb for it, not registering per type: a per-type
//! registration only covers the types it lists, so a file the app opens perfectly well but
//! the list forgot would lose the menu entirely.
//!
//! Hiding works the way Windows documents it — a `.<ext>\shell\<verb>` key whose default
//! value is an empty string masks the verb inherited from `*`.

use serde::Serialize;

pub const MENU_NAME: &str = "WROLP Editor";
pub const MENU_LABEL: &str = "Open with WROLP";
/// Where the verb lives for every file.
const SHELL_ROOT: &str = r"Software\Classes\*\shell";

/// What the menu currently launches versus what this executable would write. Exposing
/// the difference lets Settings surface a stale entry pointing at a build that can no
/// longer start, instead of pretending the menu is simply not installed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuTarget {
  /// The catch-all entry exists under HKCU, whatever it points at.
  pub installed: bool,
  /// Command value currently stored in the registry.
  pub registered: Option<String>,
  /// Command value this executable would write.
  pub expected: String,
  /// `registered` equals `expected`.
  pub matches_current: bool,
  /// How many types are currently masked out of the menu.
  pub excluded_count: usize,
  /// Entries exist under a key spelling the shell never reads, and none under `*`. A build
  /// that wrote those had the menu switched on, so Settings rewrites them instead of
  /// asking the user to toggle it.
  pub stale_layout: bool,
  /// The running executable is a debug build, which needs the dev server to render.
  pub debug_build: bool,
}

/// The verb for one file type, or for every file when `ext` is empty.
#[cfg(windows)]
fn shell_key_path(ext: &str) -> String {
  if ext.is_empty() {
    format!(r"{SHELL_ROOT}\{MENU_NAME}")
  } else {
    format!(r"Software\Classes\.{ext}\shell\{MENU_NAME}")
  }
}

#[cfg(windows)]
fn command_key_path(ext: &str) -> String {
  format!(r"{}\command", shell_key_path(ext))
}

/// The key an earlier build wrote when it registered the verb per type under a name that
/// belongs to no file type. A key called `*.md` is perfectly legal, so nothing else would
/// ever go looking for it.
#[cfg(windows)]
fn orphan_key_path(ext: &str) -> String {
  format!(r"Software\Classes\*.{ext}\shell\{MENU_NAME}")
}

/// Registry key names reject `\`, `/` and `"`, and this list comes from a text field, so
/// it is treated as untrusted input rather than assumed to be clean. Not `cfg(windows)`:
/// the settings normalizer runs on every platform, so the rules live in one place.
pub fn sanitize(ext: &str) -> Option<String> {
  let cleaned = ext.trim().trim_start_matches('.').to_ascii_lowercase();
  if cleaned.is_empty() || cleaned.contains(['\\', '/', ' ', '"']) {
    return None;
  }
  Some(cleaned)
}

/// The command line written to the registry: `"<exe>" "%1"`.
#[cfg(windows)]
fn command_value() -> Result<String, String> {
  let exe = std::env::current_exe().map_err(|e| e.to_string())?;
  Ok(format!("\"{}\" \"%1\"", exe.display()))
}

#[cfg(windows)]
fn mask(hkcu: &winreg::RegKey, ext: &str) -> bool {
  let Ok((key, _)) = hkcu.create_subkey(shell_key_path(ext)) else {
    return false;
  };
  // An empty default value is what masks the inherited verb. The command is dropped as
  // well: leaving one behind would keep the verb alive on systems that only look at it.
  let _ = key.delete_subkey_all("command");
  key.set_value("", &"").is_ok()
}

#[cfg(windows)]
fn unmask(hkcu: &winreg::RegKey, ext: &str) {
  let _ = hkcu.delete_subkey_all(shell_key_path(ext));
}

#[cfg(windows)]
pub fn probe(extensions: &[String]) -> Result<MenuTarget, String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let expected = command_value()?;
  let hkcu = RegKey::predef(HKEY_CURRENT_USER);

  let registered = hkcu
    .open_subkey(command_key_path(""))
    .and_then(|key| key.get_value::<String, _>(""))
    .ok();

  // A mask is a key with an empty default value. Counting them tells Settings how much of
  // the exclusion list actually reached the registry.
  let mut excluded_count = 0usize;
  let mut orphan_count = 0usize;
  let mut per_type_count = 0usize;
  for ext in extensions {
    let Some(ext) = sanitize(ext) else {
      continue;
    };
    if let Ok(key) = hkcu.open_subkey(shell_key_path(&ext)) {
      let label = key.get_value::<String, _>("").unwrap_or_default();
      let has_command = hkcu.open_subkey(command_key_path(&ext)).is_ok();
      if label.is_empty() && !has_command {
        excluded_count += 1;
      } else if !label.is_empty() {
        // A real verb for this one type: the layout of the build that switched from a
        // catch-all to per-type registration, and something to normalize away.
        per_type_count += 1;
      }
    }
    if hkcu.open_subkey(orphan_key_path(&ext)).is_ok() {
      orphan_count += 1;
    }
  }

  Ok(MenuTarget {
    installed: registered.is_some(),
    matches_current: registered.as_deref() == Some(expected.as_str()),
    excluded_count,
    // Anything left over from a layout that no longer exists, and no catch-all to go with
    // it. Both intermediate builds land here: the one whose keys were named `*.<ext>`, and
    // the one that registered per type and dropped the catch-all.
    stale_layout: registered.is_none() && (orphan_count > 0 || per_type_count > 0),
    registered,
    expected,
    debug_build: cfg!(debug_assertions),
  })
}

/// `extensions` is every type the app recognizes, `excluded` the ones to hide. The first
/// list is what lets a previous per-type install be undone: those entries have to go, or
/// the types they cover would keep a verb of their own.
#[cfg(windows)]
pub fn install(extensions: &[String], excluded: &[String]) -> Result<String, String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let value = command_value()?;
  let exe = std::env::current_exe().map_err(|e| e.to_string())?;

  // Whatever earlier builds left behind: the per-type verbs (whose key is deleted whole —
  // keeping its label while dropping its command would leave a menu entry that does
  // nothing), and the orphan keys from the build that used the wrong spelling.
  for ext in extensions {
    let Some(ext) = sanitize(ext) else {
      continue;
    };
    unmask(&hkcu, &ext);
    let _ = hkcu.delete_subkey_all(orphan_key_path(&ext));
  }

  let (shell, _) = hkcu
    .create_subkey(shell_key_path(""))
    .map_err(|e| e.to_string())?;
  shell
    .set_value("", &MENU_LABEL)
    .map_err(|e| e.to_string())?;
  shell
    .set_value("Icon", &format!("\"{}\",0", exe.display()))
    .map_err(|e| e.to_string())?;
  let (command, _) = hkcu
    .create_subkey(command_key_path(""))
    .map_err(|e| e.to_string())?;
  command.set_value("", &value).map_err(|e| e.to_string())?;

  // Only the excluded types are left to clear: any other mask would be one this build did
  // not ask for, and a stale mask hides the menu the user does want.
  for ext in excluded {
    if let Some(ext) = sanitize(ext) {
      mask(&hkcu, &ext);
    }
  }
  Ok(value)
}

#[cfg(windows)]
pub fn uninstall(extensions: &[String]) -> Result<(), String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  for ext in extensions {
    let Some(ext) = sanitize(ext) else {
      continue;
    };
    unmask(&hkcu, &ext);
    let _ = hkcu.delete_subkey_all(orphan_key_path(&ext));
  }
  match hkcu.delete_subkey_all(shell_key_path("")) {
    Ok(()) => {}
    // Already absent: the goal is "not there", which is what the caller asked for.
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
    Err(e) => return Err(e.to_string()),
  }
  Ok(())
}

#[cfg(not(windows))]
pub fn probe(_extensions: &[String]) -> Result<MenuTarget, String> {
  Ok(MenuTarget {
    installed: false,
    registered: None,
    expected: String::new(),
    matches_current: false,
    excluded_count: 0,
    stale_layout: false,
    debug_build: cfg!(debug_assertions),
  })
}

#[cfg(not(windows))]
pub fn install(_extensions: &[String], _excluded: &[String]) -> Result<String, String> {
  Err("menu_windows_only".into())
}

#[cfg(not(windows))]
pub fn uninstall(_extensions: &[String]) -> Result<(), String> {
  Err("menu_windows_only".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sanitize_normalizes_what_a_text_field_can_produce() {
    assert_eq!(sanitize("PNG"), Some("png".into()));
    assert_eq!(sanitize(" .Json "), Some("json".into()));
    assert_eq!(sanitize(""), None);
    assert_eq!(sanitize("..."), None);
    // Anything that would create a nested or malformed key is refused.
    assert_eq!(sanitize(r"a\b"), None);
    assert_eq!(sanitize("a b"), None);
    assert_eq!(sanitize(r#"a"b"#), None);
  }

  #[test]
  fn the_verb_is_registered_for_every_file_and_masked_per_type() {
    // One catch-all entry, so a type the app can open but nobody listed still has the menu.
    assert_eq!(shell_key_path(""), r"Software\Classes\*\shell\WROLP Editor");
    assert_eq!(
      command_key_path(""),
      r"Software\Classes\*\shell\WROLP Editor\command"
    );
    // `.<ext>` is the file-type branch; `*.<ext>` is a name no file has, which is why the
    // build that used it produced a menu that could never appear.
    assert_eq!(
      shell_key_path("md"),
      r"Software\Classes\.md\shell\WROLP Editor"
    );
    assert_eq!(
      orphan_key_path("md"),
      r"Software\Classes\*.md\shell\WROLP Editor"
    );
  }
}
