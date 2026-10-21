// Write latest.json for the Tauri updater from the signed NSIS installer.
//
// `npm run release` runs this after the build; it can also be re-run on its own to refresh the
// notes or point the file at another tag. The URL must name the asset exactly as GitHub stores
// it (percent-encoded), because the updater requests it literally.
//
// The notes are the release's own, read from `RELEASE_NOTES.md` and `RELEASE_NOTES.zh.md` at the
// repository root; `--notes` overrides both for a one-off.
//
// Usage:
//   node scripts/gen-latest-json.mjs [--tag v0.0.2] [--notes "..."]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadReleaseNotes } from './release-notes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

let tagOverride = ''
let notesOverride = ''
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--tag') tagOverride = process.argv[++i] ?? ''
  else if (arg === '--notes') notesOverride = process.argv[++i] ?? ''
  else {
    console.error(`[gen-latest] unknown argument: ${arg}`)
    process.exit(2)
  }
}

const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const { productName, version } = conf
const tag = tagOverride || `v${version}`

function repoFromRemote() {
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
  const url = remote.status === 0 ? remote.stdout.trim() : ''
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : ''
}

const repo = repoFromRemote()
if (!repo) {
  console.error('[gen-latest] could not read the GitHub repository from `git remote get-url origin`.')
  process.exit(1)
}

const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const installerName = `${productName}_${version}_x64-setup.exe`
const installer = join(nsisDir, installerName)
const sigPath = installer + '.sig'
if (!existsSync(installer) || !existsSync(sigPath)) {
  const seen = existsSync(nsisDir) ? readdirSync(nsisDir) : []
  console.error(`[gen-latest] signed installer not found: ${installer}`)
  console.error('[gen-latest] run "npm run release" first.')
  if (seen.length) console.error(`[gen-latest] found instead:\n  ${seen.join('\n  ')}`)
  process.exit(1)
}

const notes = notesOverride || loadReleaseNotes() || `Release ${version}`
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(sigPath, 'utf8').trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(installerName)}`,
    },
  },
}

const out = join(nsisDir, 'latest.json')
writeFileSync(out, JSON.stringify(latest, null, 2) + '\n', 'utf8')
console.log(`[gen-latest] wrote ${out}`)
console.log(`[gen-latest] version=${version} tag=${tag} url=${latest.platforms['windows-x86_64'].url}`)
