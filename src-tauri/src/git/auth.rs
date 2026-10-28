//! Remote credentials, commit identity and trusted SSH host keys.
//!
//! Stored in `state/git.json` beside the other state files, in plain text like the rest of this
//! app's configuration. Deliberately not part of `settings.json`: configuration backups copy
//! that file, and a token does not belong in every snapshot taken for safety.
//!
//! Secrets are write-only over IPC. The view handed to the panel says which host has a password,
//! never what it is; the panel collects a replacement when the user asks to change one.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use tauri::AppHandle;

const AUTH_FILE: &str = "git.json";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthStore {
  pub identity: Option<Identity>,
  /// HTTPS credentials by host. The key is the host libgit2 names in `credentials`, lowercased.
  pub https: BTreeMap<String, HttpsCredential>,
  /// SSH keys by host.
  pub ssh: BTreeMap<String, SshCredential>,
  /// Trusted SSH host-key fingerprints by host, in SHA-256 hex.
  pub known_hosts: BTreeMap<String, String>,
}

impl AuthStore {
  pub fn load(app: &AppHandle) -> Result<Self, String> {
    Ok(crate::commands::read_json::<AuthStore>(app, AUTH_FILE)?.unwrap_or_default())
  }

  pub fn save(&self, app: &AppHandle) -> Result<(), String> {
    crate::commands::write_json(app, AUTH_FILE, self)
  }

}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Identity {
  pub name: String,
  pub email: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HttpsCredential {
  pub username: String,
  pub secret: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SshCredential {
  pub key_path: String,
  pub passphrase: Option<String>,
}

/// The host a remote URL talks to, lowercased. Handles both `https://[user@]host[:port]/…` and
/// the scp-like `[user@]host:path` that git accepts for SSH.
pub fn host_of(url: &str) -> Option<String> {
  // A local repository is addressed by a path, not a host. `D:/repo.git` would otherwise read
  // as the scp-like `D:repo.git` and invent a one-letter host.
  if url.starts_with("file://") || Path::new(url).is_absolute() {
    return None;
  }
  if let Some((_, rest)) = url.split_once("://") {
    let authority = rest.split('/').next()?;
    let host = authority.rsplit('@').next()?;
    if host.is_empty() || host.chars().any(char::is_whitespace) {
      return None;
    }
    return Some(host.to_ascii_lowercase());
  }
  let after_at = url.rsplit_once('@').map(|(_, host)| host).unwrap_or(url);
  let host = after_at.split(':').next()?;
  if host.is_empty()
    || host.contains('/')
    || host.contains('\\')
    || host.chars().any(char::is_whitespace)
  {
    return None;
  }
  Some(host.to_ascii_lowercase())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialView {
  pub host: String,
  /// `https` or `ssh`.
  pub kind: String,
  /// The HTTPS username; absent for SSH, where the remote URL's user decides.
  pub username: Option<String>,
  pub key_path: Option<String>,
  /// A password or token is stored. The value never leaves Rust.
  pub has_secret: bool,
  /// An SSH passphrase is stored.
  pub has_passphrase: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostView {
  pub host: String,
  pub fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthView {
  pub identity: Option<Identity>,
  pub credentials: Vec<CredentialView>,
  pub known_hosts: Vec<KnownHostView>,
}

#[tauri::command]
pub fn git_auth_view(app: AppHandle) -> Result<AuthView, String> {
  let store = AuthStore::load(&app)?;
  let mut credentials = Vec::new();
  for (host, credential) in &store.https {
    credentials.push(CredentialView {
      host: host.clone(),
      kind: "https".into(),
      username: Some(credential.username.clone()),
      key_path: None,
      has_secret: !credential.secret.is_empty(),
      has_passphrase: false,
    });
  }
  for (host, credential) in &store.ssh {
    credentials.push(CredentialView {
      host: host.clone(),
      kind: "ssh".into(),
      username: None,
      key_path: Some(credential.key_path.clone()),
      has_secret: false,
      has_passphrase: credential.passphrase.is_some(),
    });
  }
  credentials.sort_by(|a, b| (&a.host, &a.kind).cmp(&(&b.host, &b.kind)));
  let known_hosts = store
    .known_hosts
    .iter()
    .map(|(host, fingerprint)| KnownHostView {
      host: host.clone(),
      fingerprint: fingerprint.clone(),
    })
    .collect();
  Ok(AuthView {
    identity: store.identity,
    credentials,
    known_hosts,
  })
}

#[tauri::command]
pub fn git_save_https(
  app: AppHandle,
  host: String,
  username: String,
  secret: String,
) -> Result<(), String> {
  let host = clean_host(&host)?;
  let username = username.trim().to_string();
  if username.is_empty() || secret.is_empty() {
    return Err("git_auth_incomplete".into());
  }
  let mut store = AuthStore::load(&app)?;
  store.https.insert(
    host,
    HttpsCredential {
      username,
      secret,
    },
  );
  store.save(&app)
}

#[tauri::command]
pub fn git_save_ssh(
  app: AppHandle,
  host: String,
  key_path: String,
  passphrase: Option<String>,
  remember_passphrase: bool,
) -> Result<(), String> {
  let host = clean_host(&host)?;
  let key_path = key_path.trim().to_string();
  if key_path.is_empty() {
    return Err("git_auth_incomplete".into());
  }
  let mut store = AuthStore::load(&app)?;
  store.ssh.insert(
    host,
    SshCredential {
      key_path,
      passphrase: passphrase.filter(|value| remember_passphrase && !value.is_empty()),
    },
  );
  store.save(&app)
}

#[tauri::command]
pub fn git_forget_credential(app: AppHandle, host: String) -> Result<(), String> {
  let host = clean_host(&host)?;
  let mut store = AuthStore::load(&app)?;
  store.https.remove(&host);
  store.ssh.remove(&host);
  store.save(&app)
}

#[tauri::command]
pub fn git_save_identity(app: AppHandle, name: String, email: String) -> Result<(), String> {
  let name = name.trim().to_string();
  let email = email.trim().to_string();
  if name.is_empty() || email.is_empty() {
    return Err("git_auth_incomplete".into());
  }
  let mut store = AuthStore::load(&app)?;
  store.identity = Some(Identity { name, email });
  store.save(&app)
}

#[tauri::command]
pub fn git_clear_identity(app: AppHandle) -> Result<(), String> {
  let mut store = AuthStore::load(&app)?;
  store.identity = None;
  store.save(&app)
}

/// Remember a host key the user just looked at. The fingerprint is stored as shown, so the next
/// connection compares against exactly what was approved.
#[tauri::command]
pub fn git_trust_host(app: AppHandle, host: String, fingerprint: String) -> Result<(), String> {
  let host = clean_host(&host)?;
  let fingerprint = fingerprint.trim().to_ascii_lowercase();
  if fingerprint.is_empty() {
    return Err("git_auth_incomplete".into());
  }
  let mut store = AuthStore::load(&app)?;
  store.known_hosts.insert(host, fingerprint);
  store.save(&app)
}

#[tauri::command]
pub fn git_forget_host(app: AppHandle, host: String) -> Result<(), String> {
  let host = clean_host(&host)?;
  let mut store = AuthStore::load(&app)?;
  store.known_hosts.remove(&host);
  store.save(&app)
}

fn clean_host(host: &str) -> Result<String, String> {
  let host = host.trim().to_ascii_lowercase();
  if host.is_empty() {
    return Err("git_auth_incomplete".into());
  }
  Ok(host)
}

#[cfg(test)]
mod tests {
  use super::host_of;

  #[test]
  fn hosts_come_out_of_both_url_shapes() {
    assert_eq!(host_of("https://github.com/a/b.git").as_deref(), Some("github.com"));
    assert_eq!(
      host_of("https://user:token@github.com:8443/a/b.git").as_deref(),
      Some("github.com:8443")
    );
    assert_eq!(host_of("ssh://git@github.com/a/b.git").as_deref(), Some("github.com"));
    assert_eq!(host_of("git@github.com:owner/repo.git").as_deref(), Some("github.com"));
    assert_eq!(host_of("git@example.com:/srv/repo.git").as_deref(), Some("example.com"));
    assert_eq!(host_of("not a url"), None);
    assert_eq!(host_of("D:/wrolp/remote.git"), None);
    assert_eq!(host_of("/srv/repo.git"), None);
  }
}
