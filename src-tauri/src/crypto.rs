//! Password-based container for encrypted files.
//!
//! Everything here is a pure function: no `AppHandle`, no managed state, so the whole
//! format is covered by unit tests without touching the filesystem. The container is
//! self-describing (KDF parameters live in the header) and recognised by its magic
//! bytes, never by file extension.
//!
//! Layout, 50-byte header followed by the ciphertext:
//!
//! ```text
//! 0     8     magic "WROLPENC"
//! 8     1     format version
//! 9     1     KDF id (1 = argon2id)
//! 10    4     m_cost, KiB (u32 LE)
//! 14    4     t_cost (u32 LE)
//! 18    4     p_cost (u32 LE)
//! 22    16    salt, random per file
//! 38    12    nonce, re-randomised on every write
//! 50    ...   AES-256-GCM(plaintext) || 16-byte tag
//! ```
//!
//! The whole header is the AEAD associated data, so tampering with any of it — including
//! lowering `m_cost` to speed up a brute force — fails authentication instead of being
//! honoured.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroize;

pub const MAGIC: &[u8; 8] = b"WROLPENC";
pub const HEADER_LEN: usize = 50;

const FORMAT_VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;

/// Public because [`random_salt`] hands one out for a caller-chosen salt.
pub const SALT_LEN: usize = 16;
/// Public because the draft envelope carries its own nonce alongside the sealed payload.
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;
/// AES-GCM appends the tag to the ciphertext, so anything shorter cannot be a container body.
const TAG_LEN: usize = 16;

/// `age` is the one foreign format we name explicitly; others stay `file_undecodable`.
const AGE_MAGIC: &[u8] = b"age-encryption.org/";

/// Bounds applied before anything is handed to Argon2. Absurd parameters are as much a
/// denial of service against this process as they are a sign of a damaged file.
pub const MIN_M_COST: u32 = 1024;
pub const MAX_M_COST: u32 = 1_048_576;
pub const MIN_T_COST: u32 = 1;
pub const MAX_T_COST: u32 = 64;
pub const MIN_P_COST: u32 = 1;
pub const MAX_P_COST: u32 = 8;

/// Written into new containers. Raising these later does not break existing files, which
/// carry their own copy.
pub const DEFAULT_M_COST: u32 = 65536;
pub const DEFAULT_T_COST: u32 = 3;
pub const DEFAULT_P_COST: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
  pub m_cost: u32,
  pub t_cost: u32,
  pub p_cost: u32,
}

impl Default for KdfParams {
  fn default() -> Self {
    Self {
      m_cost: DEFAULT_M_COST,
      t_cost: DEFAULT_T_COST,
      // p_cost stays 1 on purpose: the `argon2` crate fills lanes on one thread, so a
      // higher p buys no wall-clock speed. The field exists for cross-implementation use.
      p_cost: DEFAULT_P_COST,
    }
  }
}

impl KdfParams {
  fn validate(self) -> Result<(), String> {
    let ok = self.m_cost >= MIN_M_COST
      && self.m_cost <= MAX_M_COST
      && self.t_cost >= MIN_T_COST
      && self.t_cost <= MAX_T_COST
      && self.p_cost >= MIN_P_COST
      && self.p_cost <= MAX_P_COST;
    if ok {
      Ok(())
    } else {
      Err("encrypted_params_invalid".to_string())
    }
  }
}

#[derive(Clone, Copy, Debug)]
pub struct ContainerHeader {
  pub params: KdfParams,
  pub salt: [u8; SALT_LEN],
  pub nonce: [u8; NONCE_LEN],
}

/// True for anything starting with the magic. Every caller shares this one test, so a
/// plain text file and a container can never be told apart two different ways.
pub fn is_container(bytes: &[u8]) -> bool {
  bytes.len() >= MAGIC.len() && &bytes[..MAGIC.len()] == MAGIC
}

/// Only matches a format we can name with certainty; a binary file must not be reported
/// as somebody else's encrypted document.
pub fn looks_foreign(bytes: &[u8]) -> bool {
  bytes.len() >= AGE_MAGIC.len() && &bytes[..AGE_MAGIC.len()] == AGE_MAGIC
}

/// Argon2id. An empty password never reaches the KDF: it is rejected as weak, not as wrong.
pub fn derive_key(password: &str, salt: &[u8], params: KdfParams) -> Result<[u8; KEY_LEN], String> {
  if password.is_empty() {
    return Err("encrypted_weak_password".to_string());
  }
  params.validate()?;
  if salt.len() != SALT_LEN {
    return Err("encrypted_corrupt".to_string());
  }
  let argon_params = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(KEY_LEN))
    .map_err(|e| format!("encrypted_params_invalid:{e}"))?;
  let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
  let mut key = [0u8; KEY_LEN];
  argon2
    .hash_password_into(password.as_bytes(), salt, &mut key)
    .map_err(|e| format!("encrypted_params_invalid:{e}"))?;
  Ok(key)
}

/// Reads and checks the header. Called before any key derivation so a damaged or hostile
/// file is rejected without spending Argon2 time on it.
pub fn parse_header(bytes: &[u8]) -> Result<ContainerHeader, String> {
  if !is_container(bytes) {
    return Err("encrypted_corrupt".to_string());
  }
  if bytes.len() < HEADER_LEN {
    return Err("encrypted_corrupt".to_string());
  }
  let version = bytes[8];
  if version != FORMAT_VERSION {
    return Err(format!("encrypted_version_unknown:{version}"));
  }
  let kdf = bytes[9];
  if kdf != KDF_ARGON2ID {
    return Err(format!("encrypted_kdf_unknown:{kdf}"));
  }
  let params = KdfParams {
    m_cost: u32::from_le_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]),
    t_cost: u32::from_le_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]),
    p_cost: u32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]),
  };
  params.validate()?;

  let mut salt = [0u8; SALT_LEN];
  salt.copy_from_slice(&bytes[22..22 + SALT_LEN]);
  let mut nonce = [0u8; NONCE_LEN];
  nonce.copy_from_slice(&bytes[38..38 + NONCE_LEN]);
  Ok(ContainerHeader {
    params,
    salt,
    nonce,
  })
}

fn header_bytes(header: &ContainerHeader) -> Vec<u8> {
  let mut out = Vec::with_capacity(HEADER_LEN);
  out.extend_from_slice(MAGIC);
  out.push(FORMAT_VERSION);
  out.push(KDF_ARGON2ID);
  out.extend_from_slice(&header.params.m_cost.to_le_bytes());
  out.extend_from_slice(&header.params.t_cost.to_le_bytes());
  out.extend_from_slice(&header.params.p_cost.to_le_bytes());
  out.extend_from_slice(&header.salt);
  out.extend_from_slice(&header.nonce);
  out
}

fn fill_random(buf: &mut [u8]) -> Result<(), String> {
  getrandom::getrandom(buf).map_err(|e| format!("encrypted_random:{e}"))
}

/// A fresh salt. One per file: two files that share a password must not share a key, or a
/// brute force against one would open both.
pub fn random_salt() -> Result<[u8; SALT_LEN], String> {
  let mut salt = [0u8; SALT_LEN];
  fill_random(&mut salt)?;
  Ok(salt)
}

/// Produces a complete container, header included, under the default parameters. The nonce
/// is fresh per call, so two saves of the same content under the same password differ on
/// disk. This is for making a document encrypted in the first place; re-saving one that
/// already is goes through [`encrypt_under`] with the key and the parameters it carries.
pub fn encrypt(plaintext: &[u8], password: &str) -> Result<Vec<u8>, String> {
  let params = KdfParams::default();
  let salt = random_salt()?;
  let mut key = derive_key(password, &salt, params)?;
  let result = build_container(plaintext, &key, salt, params);
  key.zeroize();
  result
}

/// The container for `plaintext` under a key and salt the caller already has: re-saving an
/// unlocked file, where the key comes from the session cache instead of a password so the
/// KDF is not run again, and changing a password, where a fresh salt is drawn for the new
/// key. Everything else here picks those two and then calls this.
pub fn encrypt_under(
  plaintext: &[u8],
  key: &[u8; KEY_LEN],
  salt: [u8; SALT_LEN],
  params: KdfParams,
) -> Result<Vec<u8>, String> {
  params.validate()?;
  build_container(plaintext, key, salt, params)
}

fn build_container(
  plaintext: &[u8],
  key: &[u8; KEY_LEN],
  salt: [u8; SALT_LEN],
  params: KdfParams,
) -> Result<Vec<u8>, String> {
  let mut nonce = [0u8; NONCE_LEN];
  fill_random(&mut nonce)?;
  let header = ContainerHeader {
    params,
    salt,
    nonce,
  };
  aead_encrypt(&header_bytes(&header), &nonce, key, plaintext)
}

fn aead_encrypt(
  header: &[u8],
  nonce: &[u8; NONCE_LEN],
  key: &[u8; KEY_LEN],
  plaintext: &[u8],
) -> Result<Vec<u8>, String> {
  let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
  let ciphertext = cipher
    .encrypt(
      Nonce::from_slice(nonce),
      Payload {
        msg: plaintext,
        aad: header,
      },
    )
    .map_err(|e| format!("encrypted_corrupt:{e}"))?;
  let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
  out.extend_from_slice(header);
  out.extend_from_slice(&ciphertext);
  Ok(out)
}

/// Verifies the tag against the header as associated data and returns the plaintext
/// bytes. Callers check UTF-8 themselves: a tag that verifies but yields invalid text is
/// a corrupt file, not a wrong password, and the two need different messages.
pub fn decrypt(bytes: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>, String> {
  let header = parse_header(bytes)?;
  let body = &bytes[HEADER_LEN..];
  if body.len() < TAG_LEN {
    return Err("encrypted_corrupt".to_string());
  }
  let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
  cipher
    .decrypt(
      Nonce::from_slice(&header.nonce),
      Payload {
        msg: body,
        aad: &bytes[..HEADER_LEN],
      },
    )
    // A tag mismatch is what a wrong password looks like; there is no way to tell it
    // apart from tampering, and claiming otherwise would be misleading.
    .map_err(|_| "encrypted_bad_password".to_string())
}

/// Builds a container from a password and a salt the caller chose, so a test can make a
/// file and then unlock it by password. Production always draws a fresh random salt:
/// reusing one would let two files that share a password share a key.
#[cfg(test)]
pub(crate) fn encrypt_with_salt(
  plaintext: &[u8],
  password: &str,
  salt: &[u8; SALT_LEN],
  params: KdfParams,
) -> Result<Vec<u8>, String> {
  let key = derive_key(password, salt, params)?;
  encrypt_under(plaintext, &key, *salt, params)
}

/// A fresh nonce. Every write needs one of its own: reusing a nonce under a key breaks
/// AES-GCM outright rather than degrading it, so this is not a convenience wrapper.
pub fn random_nonce() -> Result<[u8; NONCE_LEN], String> {
  let mut nonce = [0u8; NONCE_LEN];
  fill_random(&mut nonce)?;
  Ok(nonce)
}

/// AES-256-GCM over an arbitrary payload with no associated data. Used by the draft
/// envelope, which reuses the key of the file a draft belongs to but is not a container
/// and therefore has no header to authenticate against.
pub fn seal(
  plaintext: &[u8],
  key: &[u8; KEY_LEN],
  nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, String> {
  let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
  cipher
    .encrypt(Nonce::from_slice(nonce), plaintext)
    .map_err(|e| format!("encrypted_corrupt:{e}"))
}

/// The inverse of [`seal`]. A tag failure means the payload does not belong to this key or
/// was damaged; the two cannot be told apart, so they are not reported as if they could.
pub fn unseal(
  sealed: &[u8],
  key: &[u8; KEY_LEN],
  nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, String> {
  let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
  cipher
    .decrypt(Nonce::from_slice(nonce), sealed)
    .map_err(|_| "encrypted_corrupt".to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  const PASSWORD: &str = "correct horse battery staple";

  fn roundtrip(plaintext: &[u8]) -> Vec<u8> {
    let container = encrypt(plaintext, PASSWORD).expect("encrypt");
    let header = parse_header(&container).expect("header");
    let key = derive_key(PASSWORD, &header.salt, header.params).expect("derive");
    decrypt(&container, &key).expect("decrypt")
  }

  #[test]
  fn empty_and_long_plaintext_round_trip() {
    assert_eq!(roundtrip(b""), b"");

    let long: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
    assert_eq!(roundtrip(&long), long);
  }

  #[test]
  fn a_wrong_password_is_reported_as_a_wrong_password() {
    let container = encrypt(b"secret", PASSWORD).expect("encrypt");
    let header = parse_header(&container).expect("header");
    let key = derive_key("not the password", &header.salt, header.params).expect("derive");
    assert_eq!(
      decrypt(&container, &key),
      Err("encrypted_bad_password".to_string())
    );
  }

  #[test]
  fn an_empty_password_is_weak_not_wrong() {
    let container = encrypt(b"secret", PASSWORD).expect("encrypt");
    let header = parse_header(&container).expect("header");
    assert_eq!(
      derive_key("", &header.salt, header.params),
      Err("encrypted_weak_password".to_string())
    );
  }

  #[test]
  fn flipping_any_byte_of_header_or_body_is_caught() {
    // Long enough that stepping through the body samples a few dozen positions.
    let plaintext: Vec<u8> = (0..200u32).map(|i| (i % 251) as u8).collect();
    let container = encrypt(&plaintext, PASSWORD).expect("encrypt");
    let header = parse_header(&container).expect("header");
    let key = derive_key(PASSWORD, &header.salt, header.params).expect("derive");

    // Sample across the header and the body rather than every byte: a full sweep of the
    // body would be slow and would not test anything the samples do not.
    let offsets: Vec<usize> = (0..HEADER_LEN)
      .chain((HEADER_LEN..container.len()).step_by(7))
      .collect();
    let mut checked = 0;
    for offset in offsets {
      let mut damaged = container.clone();
      damaged[offset] ^= 0x01;
      // Anything but success. The exact code varies: a flipped version byte is
      // unknown, a flipped m_cost may be out of range, and the rest fail the tag.
      assert!(
        decrypt(&damaged, &key).is_err(),
        "byte {offset} was accepted after being flipped"
      );
      checked += 1;
    }
    assert!(checked > 60, "only sampled {checked} byte positions");
  }

  #[test]
  fn the_header_is_bound_to_the_ciphertext() {
    // Lowering m_cost in the header keeps it inside the valid range, so only the AAD
    // check can catch it. This is the case that would otherwise let an attacker trade
    // the file's work factor for a faster brute force.
    let container = encrypt(b"secret", PASSWORD).expect("encrypt");
    let header = parse_header(&container).expect("header");
    let key = derive_key(PASSWORD, &header.salt, header.params).expect("derive");

    let mut downgraded = container.clone();
    downgraded[10..14].copy_from_slice(&MIN_M_COST.to_le_bytes());
    assert_eq!(
      parse_header(&downgraded).map(|h| h.params.m_cost),
      Ok(MIN_M_COST)
    );
    assert_eq!(
      decrypt(&downgraded, &key),
      Err("encrypted_bad_password".to_string())
    );
  }

  #[test]
  fn out_of_range_parameters_are_rejected_before_deriving() {
    let container = encrypt(b"secret", PASSWORD).expect("encrypt");

    let mut huge = container.clone();
    huge[10..14].copy_from_slice(&(MAX_M_COST + 1).to_le_bytes());
    assert_eq!(
      parse_header(&huge).err(),
      Some("encrypted_params_invalid".to_string())
    );

    let mut tiny = container.clone();
    tiny[10..14].copy_from_slice(&(MIN_M_COST - 1).to_le_bytes());
    assert_eq!(
      parse_header(&tiny).err(),
      Some("encrypted_params_invalid".to_string())
    );

    let mut threads = container.clone();
    threads[18..22].copy_from_slice(&(MAX_P_COST + 1).to_le_bytes());
    assert_eq!(
      parse_header(&threads).err(),
      Some("encrypted_params_invalid".to_string())
    );
  }

  #[test]
  fn an_unknown_version_is_reported_not_guessed_at() {
    let mut container = encrypt(b"secret", PASSWORD).expect("encrypt");
    container[8] = 2;
    assert_eq!(
      parse_header(&container).err(),
      Some("encrypted_version_unknown:2".to_string())
    );
  }

  #[test]
  fn an_unknown_kdf_is_reported() {
    let mut container = encrypt(b"secret", PASSWORD).expect("encrypt");
    container[9] = 7;
    assert_eq!(
      parse_header(&container).err(),
      Some("encrypted_kdf_unknown:7".to_string())
    );
  }

  #[test]
  fn a_truncated_container_is_corrupt() {
    let container = encrypt(b"secret", PASSWORD).expect("encrypt");
    let head_only = &container[..HEADER_LEN];
    assert_eq!(parse_header(head_only).map(|_| ()), Ok(()));
    let header = parse_header(head_only).expect("header");
    let key = derive_key(PASSWORD, &header.salt, header.params).expect("derive");
    assert_eq!(
      decrypt(head_only, &key),
      Err("encrypted_corrupt".to_string())
    );

    // Shorter than a tag: no ciphertext left to authenticate.
    let stub = &container[..HEADER_LEN + TAG_LEN - 1];
    assert_eq!(decrypt(stub, &key), Err("encrypted_corrupt".to_string()));
  }

  #[test]
  fn is_container_only_matches_the_magic() {
    assert!(!is_container(b""));
    assert!(!is_container(b"WROL"));
    assert!(!is_container(&b"WROLPENC"[..7]));
    assert!(!is_container(b"plain text file, nothing to see"));
    assert!(is_container(b"WROLPENC\x01"));
  }

  #[test]
  fn looks_foreign_only_matches_the_age_header() {
    assert!(looks_foreign(b"age-encryption.org/v1\n-> scrypt"));
    assert!(!looks_foreign(b"-----BEGIN PGP MESSAGE-----"));
    assert!(!looks_foreign(b"age-encryption"));
    assert!(!looks_foreign(b""));
    assert!(!looks_foreign(b"WROLPENC"));
  }

  #[test]
  fn each_write_re_randomises_salt_and_nonce() {
    let a = encrypt(b"same content", PASSWORD).expect("encrypt");
    let b = encrypt(b"same content", PASSWORD).expect("encrypt");
    assert_ne!(a[22..HEADER_LEN], b[22..HEADER_LEN]);
    assert_ne!(a[HEADER_LEN..], b[HEADER_LEN..]);
  }

  #[test]
  fn re_saving_with_a_cached_key_keeps_the_content() {
    let params = KdfParams {
      m_cost: MIN_M_COST,
      t_cost: MIN_T_COST,
      p_cost: MIN_P_COST,
    };
    let salt = [7u8; SALT_LEN];
    let key = derive_key(PASSWORD, &salt, params).expect("derive");
    let container = encrypt_under(b"re-saved", &key, salt, params).expect("encrypt_under");
    assert_eq!(decrypt(&container, &key).expect("decrypt"), b"re-saved");
    assert_eq!(parse_header(&container).expect("header").params, params);
  }

  #[test]
  fn re_saving_rejects_out_of_range_parameters() {
    let key = [0u8; KEY_LEN];
    let bad = KdfParams {
      m_cost: MAX_M_COST + 1,
      t_cost: 3,
      p_cost: 1,
    };
    assert_eq!(
      encrypt_under(b"x", &key, random_salt().expect("salt"), bad),
      Err("encrypted_params_invalid".to_string())
    );
  }

  #[test]
  fn a_sealed_payload_needs_the_key_and_nonce_it_was_sealed_with() {
    let key = [3u8; KEY_LEN];
    let nonce = random_nonce().expect("nonce");
    let sealed = seal(b"draft body", &key, &nonce).expect("seal");
    assert_eq!(
      unseal(&sealed, &key, &nonce).expect("unseal"),
      b"draft body"
    );

    let other_key = [4u8; KEY_LEN];
    assert_eq!(
      unseal(&sealed, &other_key, &nonce),
      Err("encrypted_corrupt".to_string())
    );
    let other_nonce = random_nonce().expect("nonce");
    assert_eq!(
      unseal(&sealed, &key, &other_nonce),
      Err("encrypted_corrupt".to_string())
    );
  }

  #[test]
  fn a_sealed_payload_that_changed_by_one_byte_is_caught() {
    let key = [5u8; KEY_LEN];
    let nonce = random_nonce().expect("nonce");
    let mut sealed = seal(b"draft body", &key, &nonce).expect("seal");
    sealed[0] ^= 0x01;
    assert_eq!(
      unseal(&sealed, &key, &nonce),
      Err("encrypted_corrupt".to_string())
    );
  }

  #[test]
  fn an_empty_payload_still_carries_a_tag() {
    let key = [6u8; KEY_LEN];
    let nonce = random_nonce().expect("nonce");
    let sealed = seal(b"", &key, &nonce).expect("seal");
    assert_eq!(sealed.len(), 16);
    assert!(unseal(&sealed, &key, &nonce).expect("unseal").is_empty());
  }
}
