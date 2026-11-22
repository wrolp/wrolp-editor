//! Windows' own OCR engine, for the picture the reader has open.
//!
//! The engine is part of Windows (Windows.Media.Ocr), so there is no model to download and
//! nothing leaves the machine. It does have to run on a thread whose COM apartment was
//! initialized for WinRT: the command's own worker thread has no such guarantee, so every
//! engine call is handed to a dedicated thread below.
//!
//! Decoding is ours rather than the platform's: `image` already knows the formats the preview
//! can draw, EXIF orientation is applied so a phone photo is read the right way up, and the
//! pixels are composited onto white before OCR — a transparent icon must not be read as dark
//! shapes.

use std::io::Cursor;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// One recognized word, in the coordinate space of the bitmap the engine saw.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
  pub text: String,
  pub x: f32,
  pub y: f32,
  pub width: f32,
  pub height: f32,
}

/// One line of words, in reading order as the engine grouped them.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
  pub words: Vec<OcrWord>,
}

/// The result, with the size of the image the engine actually saw (it may be scaled down).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrImage {
  pub width: u32,
  pub height: u32,
  pub lines: Vec<OcrLine>,
}

/// One installed OCR language. `tag` is what a later `ocr_image` names.
#[derive(Clone, Debug, Serialize)]
pub struct OcrLanguage {
  pub tag: String,
  pub name: String,
}

/// Where the picture comes from. An archive entry is read with the same scope and password
/// rules as the `wrolp-archive` image protocol; a path is the file the preview shows.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OcrSource {
  Path { path: String },
  Archive { archive: String, entry: String },
}

/// Largest file read for OCR. A picture at the 40 MP decode cap is far smaller than this; the
/// limit is here so a mistaken source cannot be turned into a multi-gigabyte allocation.
const MAX_BYTES: usize = 128 * 1024 * 1024;
/// The engine's own hard limit is 10,000 pixels on a side.
const MAX_EDGE: u32 = 10_000;
/// Decoding and two copies of the pixels are what this bounds.
const MAX_PIXELS: u64 = 40_000_000;

struct PreparedImage {
  bgra: Vec<u8>,
  width: u32,
  height: u32,
}

/// The languages Windows has an OCR recognizer for.
#[tauri::command(async)]
pub fn ocr_languages() -> Result<Vec<OcrLanguage>, String> {
  languages()
}

/// Recognize the text in one picture. `language` is an OCR tag from [`ocr_languages`]; an
/// empty or missing value follows the user profile, which is what the engine does by default.
#[tauri::command(async)]
pub fn ocr_image(
  app: AppHandle,
  source: OcrSource,
  language: Option<String>,
) -> Result<OcrImage, String> {
  let bytes = match source {
    OcrSource::Path { path } => {
      if path.to_ascii_lowercase().ends_with(".svg") {
        return Err("ocr_unsupported".into());
      }
      std::fs::read(&path).map_err(|e| format!("ocr_read:{e}"))?
    }
    OcrSource::Archive { archive, entry } => {
      crate::archive::read_gallery_image(&app, &archive, &entry)?
    }
  };
  if bytes.len() > MAX_BYTES {
    return Err("ocr_too_large".into());
  }
  let prepared = prepare_image(&bytes)?;
  recognize(prepared, language)
}

/// Decode one picture into the BGRA bitmap the engine wants.
fn prepare_image(bytes: &[u8]) -> Result<PreparedImage, String> {
  use image::metadata::Orientation;
  use image::{DynamicImage, ImageDecoder, ImageReader};

  let reader = ImageReader::new(Cursor::new(bytes))
    .with_guessed_format()
    .map_err(|_| "ocr_decode".to_string())?;
  let mut decoder = reader
    .into_decoder()
    .map_err(|_| "ocr_decode".to_string())?;
  let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
  let mut image = DynamicImage::from_decoder(decoder).map_err(|_| "ocr_decode".to_string())?;
  image.apply_orientation(orientation);

  let (mut width, mut height) = (image.width().max(1), image.height().max(1));
  if width as u64 * height as u64 > MAX_PIXELS || width > MAX_EDGE || height > MAX_EDGE {
    let by_edge = if width > MAX_EDGE || height > MAX_EDGE {
      MAX_EDGE as f64 / width.max(height) as f64
    } else {
      1.0
    };
    let by_pixels = ((MAX_PIXELS as f64) / (width as u64 * height as u64) as f64).sqrt();
    let scale = by_edge.min(by_pixels).min(1.0);
    let next_width = ((width as f64 * scale).round() as u32).max(1);
    let next_height = ((height as f64 * scale).round() as u32).max(1);
    image = image.resize_exact(
      next_width,
      next_height,
      image::imageops::FilterType::Lanczos3,
    );
    width = next_width;
    height = next_height;
  }
  if width == 0 || height == 0 || width as u64 * height as u64 > MAX_PIXELS {
    return Err("ocr_too_large".into());
  }

  // The engine takes BGRA8. Transparent pixels are composited onto white first: an icon on a
  // transparent background would otherwise be recognized as if it sat on black.
  let rgba = image.to_rgba8();
  let mut bgra = Vec::with_capacity((width as usize) * (height as usize) * 4);
  for pixel in rgba.pixels() {
    let [red, green, blue, alpha] = pixel.0;
    let alpha = alpha as u32;
    let white = 255 * (255 - alpha);
    let red = (red as u32 * alpha + white) / 255;
    let green = (green as u32 * alpha + white) / 255;
    let blue = (blue as u32 * alpha + white) / 255;
    bgra.extend_from_slice(&[blue as u8, green as u8, red as u8, 255]);
  }
  Ok(PreparedImage {
    bgra,
    width,
    height,
  })
}

#[cfg(windows)]
fn languages() -> Result<Vec<OcrLanguage>, String> {
  use windows::Media::Ocr::OcrEngine;

  on_winrt(|| {
    let list =
      OcrEngine::AvailableRecognizerLanguages().map_err(|_| "ocr_unavailable".to_string())?;
    let count = list.Size().map_err(|_| "ocr_unavailable".to_string())?;
    let mut out = Vec::new();
    for index in 0..count {
      let language = list
        .GetAt(index)
        .map_err(|_| "ocr_unavailable".to_string())?;
      let tag = language
        .LanguageTag()
        .map(|tag| tag.to_string())
        .unwrap_or_default();
      let name = language
        .DisplayName()
        .map(|name| name.to_string())
        .unwrap_or_default();
      if !tag.is_empty() {
        out.push(OcrLanguage { tag, name });
      }
    }
    if out.is_empty() {
      return Err("ocr_unavailable".into());
    }
    Ok(out)
  })
}

#[cfg(not(windows))]
fn languages() -> Result<Vec<OcrLanguage>, String> {
  Err("ocr_unsupported".into())
}

#[cfg(windows)]
fn recognize(image: PreparedImage, language: Option<String>) -> Result<OcrImage, String> {
  use windows::core::HSTRING;
  use windows::Globalization::Language;
  use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
  use windows::Media::Ocr::OcrEngine;
  use windows::Storage::Streams::DataWriter;

  let PreparedImage {
    bgra,
    width,
    height,
  } = image;
  let tag = language
    .map(|tag| tag.trim().to_string())
    .filter(|tag| !tag.is_empty());

  on_winrt(move || {
    let engine = match tag {
      Some(tag) => {
        let language = Language::CreateLanguage(&HSTRING::from(tag.as_str()))
          .map_err(|_| "ocr_language_unavailable".to_string())?;
        OcrEngine::TryCreateFromLanguage(&language)
          .map_err(|_| "ocr_language_unavailable".to_string())?
      }
      None => {
        OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| "ocr_unavailable".to_string())?
      }
    };

    let writer = DataWriter::new().map_err(|_| "ocr_thread".to_string())?;
    writer
      .WriteBytes(&bgra)
      .map_err(|_| "ocr_thread".to_string())?;
    let buffer = writer
      .DetachBuffer()
      .map_err(|_| "ocr_thread".to_string())?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
      &buffer,
      BitmapPixelFormat::Bgra8,
      width as i32,
      height as i32,
    )
    .map_err(|_| "ocr_decode".to_string())?;

    let operation = engine
      .RecognizeAsync(&bitmap)
      .map_err(|_| "ocr_unavailable".to_string())?;
    let result = block_on(operation).map_err(|_| "ocr_unavailable".to_string())?;
    let lines = result.Lines().map_err(|_| "ocr_unavailable".to_string())?;
    let count = lines.Size().map_err(|_| "ocr_unavailable".to_string())?;
    let mut out = Vec::new();
    for index in 0..count {
      let line = lines
        .GetAt(index)
        .map_err(|_| "ocr_unavailable".to_string())?;
      let words = line.Words().map_err(|_| "ocr_unavailable".to_string())?;
      let word_count = words.Size().map_err(|_| "ocr_unavailable".to_string())?;
      let mut row = Vec::new();
      for word_index in 0..word_count {
        let word = words
          .GetAt(word_index)
          .map_err(|_| "ocr_unavailable".to_string())?;
        let text = word.Text().map(|text| text.to_string()).unwrap_or_default();
        if text.is_empty() {
          continue;
        }
        let rect = word
          .BoundingRect()
          .map_err(|_| "ocr_unavailable".to_string())?;
        row.push(OcrWord {
          text,
          x: rect.X,
          y: rect.Y,
          width: rect.Width,
          height: rect.Height,
        });
      }
      if !row.is_empty() {
        out.push(OcrLine { words: row });
      }
    }
    Ok(OcrImage {
      width,
      height,
      lines: out,
    })
  })
}

#[cfg(not(windows))]
fn recognize(_image: PreparedImage, _language: Option<String>) -> Result<OcrImage, String> {
  Err("ocr_unsupported".into())
}

/// Run one WinRT call on a thread with a multi-threaded COM apartment. WinRT initialization is
/// per thread, and a Tauri worker may already carry an apartment we do not control.
#[cfg(windows)]
fn on_winrt<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

  let (tx, rx) = std::sync::mpsc::channel();
  std::thread::spawn(move || {
    if unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_err() {
      let _ = tx.send(Err("ocr_thread".into()));
      return;
    }
    let outcome = work();
    unsafe { RoUninitialize() };
    let _ = tx.send(outcome);
  });
  rx.recv().map_err(|_| "ocr_thread".to_string())?
}

/// A minimal executor for one WinRT operation: the future is polled on this thread, and its
/// completion callback wakes the thread. `futures_util::executor` is not compiled into the
/// build, and a whole runtime for one call would be more machinery than this needs.
#[cfg(windows)]
fn block_on<F: std::future::IntoFuture>(future: F) -> F::Output {
  use std::future::Future;
  use std::sync::Arc;
  use std::task::{Context, Poll, Wake, Waker};

  struct ThreadWake(std::thread::Thread);
  impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
      self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
      self.0.unpark();
    }
  }

  let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
  let mut context = Context::from_waker(&waker);
  let mut future = Box::pin(future.into_future());
  loop {
    match future.as_mut().poll(&mut context) {
      Poll::Ready(value) => return value,
      Poll::Pending => std::thread::park(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_transparent_pixel_is_composited_onto_white() {
    let mut rgba = image::RgbaImage::new(2, 1);
    rgba.put_pixel(0, 0, image::Rgba([255, 0, 0, 0]));
    rgba.put_pixel(1, 0, image::Rgba([0, 0, 255, 255]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
      .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
      .expect("png");
    let prepared = prepare_image(&bytes).expect("prepared");
    assert_eq!((prepared.width, prepared.height), (2, 1));
    // BGRA, both opaque; the transparent red becomes white.
    assert_eq!(&prepared.bgra[0..4], &[255, 255, 255, 255]);
    assert_eq!(&prepared.bgra[4..8], &[255, 0, 0, 255]);
  }

  #[test]
  fn a_file_that_is_not_an_image_is_refused() {
    assert_eq!(
      prepare_image(b"not an image").err(),
      Some("ocr_decode".to_string())
    );
  }

  /// The engine is a Windows component; this is the one runtime check that the WinRT apartment
  /// and the installed recognizers are reachable from the dedicated thread.
  #[cfg(windows)]
  #[test]
  fn windows_offers_an_ocr_recognizer() {
    let languages = languages().expect("ocr languages");
    assert!(!languages.is_empty());
  }

  #[cfg(windows)]
  #[test]
  fn the_engine_reads_a_blank_bitmap() {
    let image = image::RgbaImage::from_pixel(20, 20, image::Rgba([255, 255, 255, 255]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(image)
      .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
      .expect("png");
    let prepared = prepare_image(&bytes).expect("prepared");
    let result = recognize(prepared, None).expect("recognize");
    assert_eq!((result.width, result.height), (20, 20));
    assert!(result.lines.is_empty());
  }
}
