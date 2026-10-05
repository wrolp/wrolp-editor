//! Text encoding: decoding on open and encoding on save.
//!
//! The editor used to accept UTF-8 only and refuse anything else. Chinese Windows
//! machines still hold plenty of GBK/GB18030 files, so the encoding is now a setting
//! and every tab remembers what its file actually was: a legacy file must be written
//! back in the encoding it came in, or the save silently mangles it.
//!
//! Both directions are deliberately strict. Decoding refuses to hand back a buffer
//! full of U+FFFD, and encoding refuses to write WHATWG numeric character references
//! (`&#128512;`) into a user's file. Both would be silent corruption, and the project
//! already treats oversized and binary files the same way.

use encoding_rs::{Encoding, BIG5, EUC_KR, GB18030, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8};

/// Setting value meaning "sniff the file instead of trusting a fixed choice".
pub const AUTO: &str = "auto";

/// A decoded file plus what it took to decode it, so a save can reproduce the shape.
#[derive(Debug)]
pub struct Decoded {
  pub text: String,
  /// Canonical label (`Encoding::name`), not the setting value, so a save is stable.
  pub encoding: String,
  /// The file started with a byte-order mark that has been stripped from `text`.
  pub bom: bool,
}

/// Every encoding the UI offers, in menu order, with the i18n key suffix for each.
/// `auto` is resolved per file rather than being a real encoding.
pub const CHOICES: &[(&str, &str)] = &[
  (AUTO, "auto"),
  ("utf-8", "utf-8"),
  ("gbk", "gbk"),
  ("gb18030", "gb18030"),
  ("big5", "big5"),
  ("shift-jis", "shift-jis"),
  ("euc-kr", "euc-kr"),
  ("utf-16le", "utf-16le"),
  ("utf-16be", "utf-16be"),
];

/// The BOM each UTF encoding would carry, so we can detect and restore it.
/// Takes `&'static` because `Encoding::name` is only defined on the static instances.
fn bom_prefix(encoding: &'static Encoding) -> Option<&'static [u8]> {
  match encoding.name() {
    "UTF-8" => Some(&[0xEF, 0xBB, 0xBF]),
    "UTF-16LE" => Some(&[0xFF, 0xFE]),
    "UTF-16BE" => Some(&[0xFE, 0xFF]),
    _ => None,
  }
}

/// Map a setting value to an encoding. An unknown value is an error rather than a
/// silent fall back to UTF-8: the user picked something, and quietly using another
/// encoding is how files get mangled.
pub fn resolve(name: &str) -> Result<&'static Encoding, String> {
  let key = name.trim().to_ascii_lowercase().replace('_', "-");
  match key.as_str() {
    "utf-8" | "utf8" => Ok(UTF_8),
    "gbk" => Ok(GBK),
    "gb18030" => Ok(GB18030),
    "big5" => Ok(BIG5),
    "shift-jis" | "sjis" => Ok(SHIFT_JIS),
    "euc-kr" => Ok(EUC_KR),
    "utf-16le" => Ok(UTF_16LE),
    "utf-16be" => Ok(UTF_16BE),
    _ => Err(format!("encoding_unsupported:{name}")),
  }
}

/// True when `name` is a value the settings may store. `auto` is always allowed.
pub fn is_known(name: &str) -> bool {
  let key = name.trim().to_ascii_lowercase().replace('_', "-");
  key == AUTO || resolve(&key).is_ok()
}

fn is_utf16(encoding: &'static Encoding) -> bool {
  encoding.name() == "UTF-16LE" || encoding.name() == "UTF-16BE"
}

pub fn decode(bytes: &[u8], preference: &str) -> Result<Decoded, String> {
  if preference.trim().eq_ignore_ascii_case(AUTO) {
    return decode_auto(bytes);
  }
  decode_with(bytes, resolve(preference)?, false)
}

fn decode_auto(bytes: &[u8]) -> Result<Decoded, String> {
  // A BOM is the only encoding hint a file gives us for free, so it wins. The mark is
  // already consumed here, hence the `true`: decode_with must not look for it again.
  if let Some((encoding, bom_len)) = Encoding::for_bom(bytes) {
    return decode_with(&bytes[bom_len..], encoding, true);
  }
  // No BOM: strict UTF-8 next. This is the overwhelmingly common case and the only
  // one where "definitely right" can be proven without guessing.
  if let Ok(text) = std::str::from_utf8(bytes) {
    return Ok(Decoded {
      text: text.to_string(),
      encoding: UTF_8.name().to_string(),
      bom: false,
    });
  }
  // Legacy Chinese files are the reason this feature exists, so fall back to
  // GB18030 (a superset of GBK) rather than refusing outright.
  decode_with(bytes, GB18030, false)
}

fn decode_with(
  bytes: &[u8],
  encoding: &'static Encoding,
  bom_already_stripped: bool,
) -> Result<Decoded, String> {
  let (body, had_bom) = if bom_already_stripped {
    (bytes, true)
  } else {
    match bom_prefix(encoding) {
      Some(p) if bytes.starts_with(p) => (&bytes[p.len()..], true),
      _ => (bytes, false),
    }
  };

  let text = if is_utf16(encoding) {
    // Hand-rolled because `Encoding::decode` implements the WHATWG rules, under which
    // UTF-16's output encoding is defined to be UTF-8. See `encode` below.
    if body.len() % 2 != 0 {
      return Err("file_undecodable".into());
    }
    let mut units = Vec::with_capacity(body.len() / 2);
    for pair in body.chunks_exact(2) {
      units.push(if encoding.name() == "UTF-16LE" {
        u16::from_le_bytes([pair[0], pair[1]])
      } else {
        u16::from_be_bytes([pair[0], pair[1]])
      });
    }
    // Rejects lone surrogates, the UTF-16 equivalent of invalid bytes.
    String::from_utf16(&units).map_err(|_| "file_undecodable".to_string())?
  } else {
    let (text, had_errors) = encoding.decode_without_bom_handling(body);
    if had_errors {
      return Err("file_undecodable".into());
    }
    text.into_owned()
  };

  Ok(Decoded {
    text,
    encoding: encoding.name().to_string(),
    bom: had_bom,
  })
}

/// Encode `text` back to bytes. `bom` reproduces whatever the file had on disk, so
/// saving a file that started with a BOM does not quietly drop it.
///
/// Note on `Encoding::encode`: it short-circuits ASCII-only input and returns the
/// source bytes unchanged. Harmless for the ASCII-compatible legacy encodings (GBK,
/// Big5, ...) but wrong for UTF-16, whose output encoding the WHATWG rules this method
/// implements define as UTF-8. UTF-16 is therefore written by hand.
pub fn encode(text: &str, encoding: &str, bom: bool) -> Result<Vec<u8>, String> {
  let target = resolve(encoding)?;
  let mut out = Vec::with_capacity(text.len() + 3);
  if bom {
    if let Some(prefix) = bom_prefix(target) {
      out.extend_from_slice(prefix);
    }
  }
  if is_utf16(target) {
    for unit in text.encode_utf16() {
      out.extend_from_slice(&if target.name() == "UTF-16LE" {
        unit.to_le_bytes()
      } else {
        unit.to_be_bytes()
      });
    }
    return Ok(out);
  }
  let (body, _, unmappable) = target.encode(text);
  if unmappable {
    // The encoder would substitute WHATWG numeric character references, turning one
    // character into six literal ones. Refuse rather than corrupt the file.
    return Err("text_not_encodable".into());
  }
  out.extend_from_slice(&body);
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Probe kept as a test so the surprising branches stay visible: does `encode` add a
  /// UTF-16 BOM on its own, and what does it do with a character GBK cannot hold?
  #[test]
  fn utf16_is_written_as_utf16_not_utf8() {
    // Regression guard: `Encoding::encode` short-circuits ASCII-only input and hands
    // back the UTF-8 source bytes, which is invalid UTF-16.
    assert_eq!(
      encode("hi", "utf-16le", false).unwrap(),
      vec![0x68, 0x00, 0x69, 0x00]
    );
    assert_eq!(
      encode("hi", "utf-16be", false).unwrap(),
      vec![0x00, 0x68, 0x00, 0x69]
    );
  }

  #[test]
  fn a_character_the_target_cannot_hold_is_refused_not_substituted() {
    assert_eq!(
      encode("a\u{1F600}b", "gbk", false).unwrap_err(),
      "text_not_encodable"
    );
  }

  #[test]
  fn unknown_encoding_is_an_error_not_a_silent_utf8_fallback() {
    assert!(resolve("utf-16le").is_ok());
    assert_eq!(
      resolve("latin1").unwrap_err(),
      "encoding_unsupported:latin1"
    );
    assert!(!is_known("latin1"));
    assert!(is_known("auto"));
    assert!(is_known("GBK"));
  }

  #[test]
  fn auto_reads_plain_utf8() {
    let got = decode("中文 ok".as_bytes(), AUTO).expect("decode");
    assert_eq!(got.text, "中文 ok");
    assert_eq!(got.encoding, "UTF-8");
    assert!(!got.bom);
  }

  #[test]
  fn auto_strips_and_reports_a_utf8_bom() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("hi".as_bytes());
    let got = decode(&bytes, AUTO).expect("decode");
    assert_eq!(got.text, "hi");
    assert!(got.bom);
  }

  #[test]
  fn auto_falls_back_to_gb18030_for_legacy_chinese() {
    // "中文" in GBK. Not asserting `from_utf8` fails on it: `auto` tries strict UTF-8
    // first, so coming back with "gb18030" already proves the bytes were not UTF-8.
    let bytes = [0xD6u8, 0xD0, 0xCE, 0xC4];
    let got = decode(&bytes, AUTO).expect("decode");
    assert_eq!(got.text, "中文");
    assert_eq!(got.encoding, "gb18030");
    assert!(!got.bom);
  }

  #[test]
  fn explicit_gbk_decodes_the_same_bytes() {
    let bytes = [0xD6, 0xD0, 0xCE, 0xC4];
    let got = decode(&bytes, "gbk").expect("decode");
    assert_eq!(got.text, "中文");
  }

  #[test]
  fn round_trip_preserves_the_text() {
    for name in ["utf-8", "gbk", "gb18030", "utf-16le"] {
      let text = "中文 abc";
      let bytes = encode(text, name, false).expect("encode");
      let back = decode(&bytes, name).expect("decode");
      assert_eq!(back.text, text, "round trip failed for {name}");
    }
  }

  #[test]
  fn a_gbk_file_saved_stays_gbk() {
    // The whole point of remembering the encoding: bytes in, same bytes out.
    let original: &[u8] = &[0xD6, 0xD0, 0xCE, 0xC4];
    let opened = decode(original, AUTO).expect("decode");
    let written = encode(&opened.text, &opened.encoding, opened.bom).expect("encode");
    assert_eq!(written, original);
  }

  #[test]
  fn utf8_bom_survives_a_save() {
    let bytes = encode("hi", "utf-8", true).expect("encode");
    assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
    assert_eq!(decode(&bytes, AUTO).expect("decode").text, "hi");
  }

  #[test]
  fn undecodable_bytes_are_refused_rather_than_replaced() {
    // 0xFF is not a valid GBK lead byte.
    assert_eq!(decode(&[0xFF], "gbk").unwrap_err(), "file_undecodable");
    // An odd byte count cannot be UTF-16.
    assert_eq!(
      decode(&[0x68, 0x00, 0x69], "utf-16le").unwrap_err(),
      "file_undecodable"
    );
  }
}
