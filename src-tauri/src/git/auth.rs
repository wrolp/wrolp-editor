//! Remote credentials, commit identity and trusted SSH host keys.
//!
//! What is safe to show lives in `state/git.json` beside the other state files: the commit
//! identity, the hosts that have a credential, the SSH key paths and the trusted fingerprints.
//! Passwords and passphrases do not — they go to the system credential store through the same
//! service the encrypted-file feature uses, under accounts of their own. Deliberately not
//! `settings.json` either: configuration backups copy that file, and a token does not belong in
//! every snapshot taken for safety.
//!
//! If this platform has no credential store, saving a secret fails loudly instead of writing it
//! to a file: a token the user believes is in the Windows store but is actually sitting in a
//! plain-text file next to the app is worse than one that was never saved.
//!
//! Secrets are write-only over IPC. The view handed to the panel says which host has a password,
//! never what it is; the panel collects a replacement when the user asks to change one.

use keyring_core::{CredentialStore, Entry};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;

const AUTH_FILE: &str = "git.json";
/// Account prefix for every secret this module keeps. The rest of the account is a digest of
/// kind and host, so which servers the user has credentials for is not readable in the store.
const ACCOUNT_PREFIX: &str = "git-";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthStore {
  pub identity: Option<Identity>,
  /// HTTPS credentials by host. The key is the host libgit2 names in `credentials`, lowercased.
  pub https: BTreeMap<String, HttpsCredential>,
  /// SSH keys by host.
  pub ssh: BTreeMap<String, SshCredential>,
  /// Trusted SSH host-key fingerprints by host, in SHA-256 hex.
  pub known_hosts: BTreeMap<String, String>,
  /// HTTPS certificates the user chose to accept after the system refused them, by host. The
  /// value is the SHA-256 of the certificate DER that was on screen when the choice was made,
  /// so a server that changes its certificate has to ask again.
  pub https_certs: BTreeMap<String, String>,
  /// The system credential store, absent when this platform has none. Not serialized: the
  /// file holds no secret, only the pointer-shaped facts about which hosts have one.
  #[serde(skip)]
  keyring: Option<Arc<CredentialStore>>,
}

impl fmt::Debug for AuthStore {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("AuthStore")
      .field("identity", &self.identity)
      .field("https", &self.https)
      .field("ssh", &self.ssh)
      .field("known_hosts", &self.known_hosts)
      .field("https_certs", &self.https_certs)
      .finish_non_exhaustive()
  }
}

impl AuthStore {
  pub fn load(app: &AppHandle) -> Result<Self, String> {
    let mut store =
      crate::commands::read_json::<AuthStore>(app, AUTH_FILE)?.unwrap_or_default();
    store.keyring = crate::unlock::system_store();
    store.migrate_secrets(app);
    Ok(store)
  }

  pub fn save(&self, app: &AppHandle) -> Result<(), String> {
    crate::commands::write_json(app, AUTH_FILE, self)
  }

  /// Move secrets written by an earlier build into the credential store.
  ///
  /// Best effort by design: a store that is missing or refuses an entry leaves the value where
  /// it already was, where it still works, instead of losing a credential the user typed. New
  /// credentials never travel this path — they are refused outright when the store is absent.
  fn migrate_secrets(&mut self, app: &AppHandle) {
    let https: Vec<(String, String)> = self
      .https
      .iter()
      .filter(|(_, credential)| !credential.secret.is_empty())
      .map(|(host, credential)| (host.clone(), credential.secret.clone()))
      .collect();
    let mut changed = false;
    for (host, secret) in https {
      if self.remember_secret("https", &host, &secret).is_ok() {
        if let Some(credential) = self.https.get_mut(&host) {
          credential.secret.clear();
        }
        changed = true;
      }
    }
    let ssh: Vec<(String, String)> = self
      .ssh
      .iter()
      .filter_map(|(host, credential)| {
        credential
          .passphrase
          .clone()
          .filter(|value| !value.is_empty())
          .map(|passphrase| (host.clone(), passphrase))
      })
      .collect();
    for (host, passphrase) in ssh {
      if self.remember_secret("ssh", &host, &passphrase).is_ok() {
        if let Some(credential) = self.ssh.get_mut(&host) {
          credential.passphrase = None;
        }
        changed = true;
      }
    }
    if changed {
      // The rewritten file is the point of the migration. Failing here only means the next
      // load tries again; the secrets already in the store keep working either way.
      let _ = self.save(app);
    }
  }

  fn account(kind: &str, host: &str) -> String {
    format!(
      "{ACCOUNT_PREFIX}{kind}-{}",
      crate::draft::path_key(&format!("{kind}:{host}"))
    )
  }

  fn secret_entry(&self, kind: &str, host: &str) -> Result<Entry, String> {
    let keyring = self
      .keyring
      .as_ref()
      .ok_or_else(|| "git_auth_keyring_unavailable".to_string())?;
    keyring
      .build(
        crate::unlock::CREDENTIAL_SERVICE,
        &Self::account(kind, host),
        None,
      )
      .map_err(|e| format!("git_auth_keyring_unavailable:{e}"))
  }

  fn remember_secret(&self, kind: &str, host: &str, secret: &str) -> Result<(), String> {
    self
      .secret_entry(kind, host)?
      .set_password(secret)
      .map_err(|e| format!("git_auth_keyring_unavailable:{e}"))
  }

  fn forget_secret(&self, kind: &str, host: &str) -> Result<(), String> {
    match self.secret_entry(kind, host)?.delete_credential() {
      Ok(()) => Ok(()),
      Err(keyring_core::Error::NoEntry) => Ok(()),
      Err(e) => Err(format!("git_auth_keyring_unavailable:{e}")),
    }
  }

  fn recall_secret(&self, kind: &str, host: &str) -> Option<String> {
    self
      .secret_entry(kind, host)
      .ok()?
      .get_password()
      .ok()
      .filter(|secret| !secret.is_empty())
  }

  /// The HTTPS password for this host: the credential store first, then plaintext an earlier
  /// build left in the file. `None` means the caller has to ask for one.
  pub(crate) fn https_secret(&self, host: &str) -> Option<String> {
    self.recall_secret("https", host).or_else(|| {
      self
        .https
        .get(host)
        .map(|credential| credential.secret.clone())
        .filter(|secret| !secret.is_empty())
    })
  }

  /// The SSH passphrase for this host, under the same rule as [`Self::https_secret`].
  pub(crate) fn ssh_passphrase(&self, host: &str) -> Option<String> {
    self.recall_secret("ssh", host).or_else(|| {
      self
        .ssh
        .get(host)
        .and_then(|credential| credential.passphrase.clone())
        .filter(|passphrase| !passphrase.is_empty())
    })
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
  /// Plaintext secret from a `git.json` written by an earlier build. `load` moves it into the
  /// credential store and clears it; current saves never set it. It stays (de)serialisable so a
  /// store that could not take it does not cost the user the credential.
  #[serde(default)]
  pub secret: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SshCredential {
  pub key_path: String,
  /// Plaintext passphrase, kept for the same migration reason as [`HttpsCredential::secret`].
  #[serde(default)]
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
  /// HTTPS certificates accepted in spite of the system refusing them, so they can be revoked.
  pub certs: Vec<KnownHostView>,
}

#[tauri::command(async)]
pub fn git_auth_view(app: AppHandle) -> Result<AuthView, String> {
  let store = AuthStore::load(&app)?;
  let mut credentials = Vec::new();
  for (host, credential) in &store.https {
    credentials.push(CredentialView {
      host: host.clone(),
      kind: "https".into(),
      username: Some(credential.username.clone()),
      key_path: None,
      has_secret: store.https_secret(host).is_some(),
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
      has_passphrase: store.ssh_passphrase(host).is_some(),
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
  let certs = store
    .https_certs
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
    certs,
  })
}

#[tauri::command(async)]
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
  // The secret goes to the credential store before the file is touched. If this platform has
  // no store to put it in, nothing is saved and the caller is told why, rather than being left
  // with a credential that looks remembered and is in fact plain text.
  store.remember_secret("https", &host, &secret)?;
  store.https.insert(
    host,
    HttpsCredential {
      username,
      secret: String::new(),
    },
  );
  store.save(&app)
}

#[tauri::command(async)]
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
  let passphrase = passphrase.filter(|value| remember_passphrase && !value.is_empty());
  match &passphrase {
    Some(passphrase) => store.remember_secret("ssh", &host, passphrase)?,
    // Asking not to remember has to clear what an earlier answer left behind, or the old
    // passphrase would keep being used after the user asked for it to be forgotten.
    None => store.forget_secret("ssh", &host)?,
  }
  store.ssh.insert(
    host,
    SshCredential {
      key_path,
      passphrase: None,
    },
  );
  store.save(&app)
}

#[tauri::command(async)]
pub fn git_forget_credential(app: AppHandle, host: String) -> Result<(), String> {
  let host = clean_host(&host)?;
  let mut store = AuthStore::load(&app)?;
  // Forgetting has to take the secret out of the store too: a token left behind would silently
  // re-authenticate the next time this host is configured again.
  store.forget_secret("https", &host)?;
  store.forget_secret("ssh", &host)?;
  store.https.remove(&host);
  store.ssh.remove(&host);
  store.save(&app)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn git_clear_identity(app: AppHandle) -> Result<(), String> {
  let mut store = AuthStore::load(&app)?;
  store.identity = None;
  store.save(&app)
}

/// Remember a host key the user just looked at. The fingerprint is stored as shown, so the next
/// connection compares against exactly what was approved.
#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn git_forget_host(app: AppHandle, host: String) -> Result<(), String> {
  let host = clean_host(&host)?;
  let mut store = AuthStore::load(&app)?;
  store.known_hosts.remove(&host);
  store.save(&app)
}

/// Accept one HTTPS certificate the system refused, for this host, until it is forgotten or the
/// server presents a different one. The fingerprint is what makes the choice narrow: trusting a
/// host is not trusting whatever it offers next.
#[tauri::command(async)]
pub fn git_trust_cert(app: AppHandle, host: String, fingerprint: String) -> Result<(), String> {
  let host = clean_host(&host)?;
  let fingerprint = fingerprint.trim().to_ascii_lowercase();
  if fingerprint.is_empty() {
    return Err("git_auth_incomplete".into());
  }
  let mut store = AuthStore::load(&app)?;
  store.https_certs.insert(host, fingerprint);
  store.save(&app)
}

#[tauri::command(async)]
pub fn git_forget_cert(app: AppHandle, host: String) -> Result<(), String> {
  let host = clean_host(&host)?;
  let mut store = AuthStore::load(&app)?;
  store.https_certs.remove(&host);
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
