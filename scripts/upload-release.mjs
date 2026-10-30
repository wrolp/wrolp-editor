// Upload the built NSIS installer to a GitHub release.
//
// Usage:
//   node scripts/upload-release.mjs [--tag v0.0.2] [--notes "..."] [--repo owner/name]
//                                   [--draft] [--pre] [--dry-run]
//
// The tag defaults to `v<version>` and has to exist locally on HEAD, with a clean working tree:
// see `scripts/release-gate.mjs` for why both halves are checked again here rather than trusted
// from the build. The version also has to be ahead of the newest release already published, or
// this would swap the asset people download while their updater still calls them up to date.
//
// The repository is read from `git remote get-url origin` unless --repo is given. The release
// carries the installer and latest.json — the updater manifest names the asset and carries its
// signature — and nothing else; the standalone `.sig` stays local.
//
// The release body is the release's own notes, read from `RELEASE_NOTES.md` and
// `RELEASE_NOTES.zh.md` at the repository root; `--notes` overrides both for a one-off.
//
// Prerequisites: run `npm run release` first (or `npm run publish`, which does both), and have
// the `gh` CLI installed and authenticated with push access to the repository.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadReleaseNotes } from './release-notes.mjs'
import { checkReleaseReady, compareVersions, publishedVersions } from './release-gate.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

let tagOverride = ''
let notesOverride = ''
let repoOverride = ''
let draft = false
let pre = false
let dryRun = false
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--tag') tagOverride = process.argv[++i] ?? ''
  else if (arg === '--notes') notesOverride = process.argv[++i] ?? ''
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
const notesText = notesOverride || loadReleaseNotes() || `Release ${version}`

// Checked again on the way out: anything could have been edited between building and uploading,
// and this is the half that reaches other people's machines.
const ready = checkReleaseReady({ root, version, tag })
if (ready.problems.length) {
  for (const problem of ready.problems) console.error(`[upload] ${problem}`)
  console.error('[upload] nothing was sent.')
  process.exit(1)
}

// The updater compares versions, so one that is not ahead of what is already published would be
// read as "up to date" by every client while `--clobber` swapped the very asset they download.
const published = publishedVersions(repo)
if (published === null) {
  console.error(`[upload] cannot read the releases already published for ${repo}.`)
  console.error('[upload] check `gh auth status` and the network; nothing was sent rather than guess.')
  process.exit(1)
}
const newest = published.reduce((best, name) => (compareVersions(name, best) > 0 ? name : best), '')
if (newest && compareVersions(tag, newest) <= 0) {
  console.error(`[upload] ${tag} is not ahead of ${newest}, which is published already.`)
  console.error('[upload] bump tauri.conf.json, package.json and Cargo.toml, commit, tag, build again.')
  process.exit(1)
}

if (dryRun) {
  console.log(`[upload] dry run: nothing will be sent.`)
  console.log(`[upload] repo:  ${repo}`)
  console.log(
    `[upload] tag:   ${tag} at ${ready.commit.slice(0, 7)}, ahead of ${newest || 'nothing published yet'}` +
      `${draft ? ' (draft)' : ''}${pre ? ' (prerelease)' : ''}`
  )
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
  console.log(`[upload] release ${tag} not found — creating it at ${ready.commit.slice(0, 7)} ...`)
  const createArgs = [
    'gh', 'release', 'create', tag,
    '--repo', repo,
    // Without this, a release created on an existing tag lands on the default branch's head on
    // GitHub — which need not be the commit that was built here. GitHub ignores it when the tag
    // is already there, so pushing the tag first stays the normal path.
    '--target', ready.commit,
    '--title', tag,
    '--notes', notesText,
  ]
  if (draft) createArgs.push('--draft')
  if (pre) createArgs.push('--prerelease')
  const created = spawnSync(createArgs[0], createArgs.slice(1), { stdio: 'inherit' })
  if (created.status !== 0) {
    console.error('[upload] failed to create the release.')
    console.error(`[upload] if the tag is not on GitHub yet: git push origin ${tag}`)
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
