// Upload the built NSIS installer to a GitHub release.
//
// Usage:
//   node scripts/upload-release.mjs [--tag v0.0.2] [--notes "..."] [--repo owner/name]
//                                   [--draft] [--pre] [--dry-run]
//
// The repository is read from `git remote get-url origin` unless --repo is given. The release
// carries the installer and latest.json — the updater manifest names the asset and carries its
// signature — and nothing else; the standalone `.sig` stays local.
//
// Prerequisites: run `npm run release` first (or `npm run publish`, which does both), and have
// the `gh` CLI installed and authenticated with push access to the repository.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

let tagOverride = ''
let notes = ''
let repoOverride = ''
let draft = false
let pre = false
let dryRun = false
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--tag') tagOverride = process.argv[++i] ?? ''
  else if (arg === '--notes') notes = process.argv[++i] ?? ''
  else if (arg === '--repo') repoOverride = process.argv[++i] ?? ''
  else if (arg === '--draft') draft = true
  else if (arg === '--pre') pre = true
  else if (arg === '--dry-run') dryRun = true
  else {
    console.error(`[upload] unknown argument: ${arg}`)
    process.exit(2)
  }
}

const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const { productName, version } = conf

function repoFromRemote() {
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
  const url = remote.status === 0 ? remote.stdout.trim() : ''
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : ''
}

const repo = repoOverride || repoFromRemote()
if (!repo) {
  console.error('[upload] could not determine the repository; pass --repo owner/name.')
  process.exit(1)
}

const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const installer = join(nsisDir, `${productName}_${version}_x64-setup.exe`)
if (!existsSync(installer)) {
  const seen = existsSync(nsisDir)
    ? readdirSync(nsisDir).filter((name) => name.endsWith('-setup.exe'))
    : []
  console.error(`[upload] installer not found: ${installer}`)
  console.error('[upload] run "npm run release" first.')
  if (seen.length) console.error(`[upload] found instead:\n  ${seen.join('\n  ')}`)
  process.exit(1)
}

const latestPath = join(nsisDir, 'latest.json')
if (!existsSync(latestPath)) {
  console.error(`[upload] updater manifest not found: ${latestPath}`)
  console.error('[upload] run "npm run release" first (it writes latest.json).')
  process.exit(1)
}

const tag = tagOverride || `v${version}`
const megabytes = (statSync(installer).size / 1024 / 1024).toFixed(1)
const notesText = notes || `Release ${version}`

if (dryRun) {
  console.log(`[upload] dry run: nothing will be sent.`)
  console.log(`[upload] repo:  ${repo}`)
  console.log(`[upload] tag:   ${tag}${draft ? ' (draft)' : ''}${pre ? ' (prerelease)' : ''}`)
  console.log(`[upload] file:  ${installer} (${megabytes} MB)`)
  console.log(`[upload] file:  ${latestPath}`)
  console.log(`[upload] notes: ${notesText}`)
  process.exit(0)
}

// `gh` is a real executable on every platform (gh.exe on Windows), so no shell is needed
// anywhere below — and none is used, so nothing in a path or a note is ever re-parsed.
if (spawnSync('gh', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('[upload] `gh` CLI not found. Install it and run `gh auth login`.')
  process.exit(1)
}

const view = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' })
if (view.status !== 0) {
  console.log(`[upload] release ${tag} not found — creating it ...`)
  const createArgs = [
    'gh', 'release', 'create', tag,
    '--repo', repo,
    '--title', tag,
    '--notes', notesText,
  ]
  if (draft) createArgs.push('--draft')
  if (pre) createArgs.push('--prerelease')
  const created = spawnSync(createArgs[0], createArgs.slice(1), { stdio: 'inherit' })
  if (created.status !== 0) {
    console.error('[upload] failed to create the release.')
    process.exit(1)
  }
} else {
  console.log(`[upload] release ${tag} already exists — uploading/replacing its asset.`)
}

console.log(`[upload] uploading the installer and latest.json to ${repo}@${tag} ...`)
const uploaded = spawnSync(
  'gh',
  [
    'release', 'upload', tag,
    resolve(installer),
    resolve(latestPath),
    '--repo', repo,
    '--clobber',
  ],
  { stdio: 'inherit' }
)
if (uploaded.status !== 0) {
  console.error('[upload] upload failed.')
  process.exit(1)
}

console.log('[upload] done.')
console.log(`[upload] https://github.com/${repo}/releases/tag/${tag}`)
console.log(
  `[upload] latest.json: https://github.com/${repo}/releases/download/${tag}/latest.json`
)
