import { api, type OcrLanguage } from "./tauri";

/**
 * One language list for the whole window. A successful answer is kept — the installed
 * recognizers only change when Windows does — while a failure is forgotten, so installing a
 * language and reopening a picture can succeed without restarting the app.
 */
let pending: Promise<OcrLanguage[]> | null = null;

export function loadOcrLanguages(): Promise<OcrLanguage[]> {
  if (!pending) {
    pending = api.ocrLanguages().catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}
