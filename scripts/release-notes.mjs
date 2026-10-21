// The release notes in both languages the app ships, read as one body.
//
// Two files rather than one holding both languages interleaved: each is written and read in its
// own language, and the release page shows the English above a rule with the Chinese under it.
// `latest.json` carries the same text, because its `notes` is a single string there — a user who
// set the app to Chinese should not be shown English only.
//
// The files live at the repository root, named after the READMEs they sit beside, and are written
// by hand for each release. `--notes` on either script still overrides them, for a note about one
// particular build that is not part of the release's own notes.
//
// Usage (from another script):
//   import { loadReleaseNotes } from './release-notes.mjs'
//   const notes = loadReleaseNotes()   // null when neither file is there

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The file, and the heading that names its language in the combined body. */
const NOTES_FILES = [
  ['RELEASE_NOTES.md', ''],
  ['RELEASE_NOTES.zh.md', '## 简体中文'],
]

/**
 * The combined notes, or null when there are none to combine.
 *
 * A file that is missing is skipped rather than fatal: a release built before the notes were
 * written still uploads, with the plain `Release <version>` fallback the scripts already had.
 */
export function loadReleaseNotes() {
  const parts = []
  for (const [name, heading] of NOTES_FILES) {
    let text
    try {
      text = readFileSync(join(root, name), 'utf8').trim()
    } catch {
      continue
    }
    if (!text) continue
    parts.push(heading ? `${heading}\n\n${text}` : text)
  }
  return parts.length ? parts.join('\n\n---\n\n') : null
}
