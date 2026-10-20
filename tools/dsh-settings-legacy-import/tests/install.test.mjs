/**
 * Regression tests for the installer that puts the transactional migration into
 * an installed `@deepseek-ai/dsh-settings`.
 *
 * Everything happens on a copy of the installed package with a borrowed
 * `node_modules`, so the suite proves three things without touching the real
 * installation:
 *
 *   - `--apply` appends exactly one override block and keeps the published file
 *     intact underneath it (the backup is byte-identical);
 *   - `--apply` is idempotent and `--revert` restores the published bytes;
 *   - the patched package actually loads and drives a migration, i.e. the
 *     override is wired to the shipped replacement module.
 *
 * Run with: node --test tools/dsh-settings-legacy-import/tests/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  FLOWLET_LEGACY_YAML,
  RUN_ROOT,
  SOURCE_MODULE,
  TOOL_ROOT,
  cleanupRunRoot,
  dshRoot,
  loadYaml,
  makeHost,
  settingsRoot,
  writeLegacyDocument,
} from './helpers.mjs'

const run = promisify(execFile)
const APPLY = join(TOOL_ROOT, 'apply.mjs')
const yaml = loadYaml()

const RUN_COPY = join(RUN_ROOT, 'install-copy')
const PACKAGE_COPY = join(RUN_COPY, '@deepseek-ai', 'dsh-settings')

/**
 * The published `lib/index.js` of the installed package: the backup the
 * installer keeps when the override is present, otherwise the file itself.
 */
async function publishedIndexSource() {
  const root = settingsRoot()
  const backup = join(root, 'lib', 'index.js.dsh-legacy-import-fix.bak')
  return existsSync(backup) ? backup : join(root, 'lib', 'index.js')
}

/** Copy the installed package in its published shape, borrowing dependency resolution. */
async function copyPackage() {
  const source = settingsRoot()
  await rm(RUN_COPY, { recursive: true, force: true })
  await mkdir(join(PACKAGE_COPY, 'lib'), { recursive: true })
  await cp(join(source, 'package.json'), join(PACKAGE_COPY, 'package.json'))
  await cp(await publishedIndexSource(), join(PACKAGE_COPY, 'lib', 'index.js'))
  await cp(join(source, 'lib', 'types'), join(PACKAGE_COPY, 'lib', 'types'), { recursive: true })
  await mkdir(RUN_COPY, { recursive: true })
  await symlink(join(dshRoot(), 'node_modules'), join(RUN_COPY, 'node_modules'))
  return PACKAGE_COPY
}

const pristineIndex = async () => readFile(await publishedIndexSource(), 'utf8')

test.after(cleanupRunRoot)

test('the installer applies, is idempotent, and reverts byte-exactly', async () => {
  await copyPackage()
  const indexPath = join(PACKAGE_COPY, 'lib', 'index.js')
  const backupPath = `${indexPath}.dsh-legacy-import-fix.bak`
  const pristine = await pristineIndex()

  await assert.rejects(run(process.execPath, [APPLY, '--check', '--root', PACKAGE_COPY]))

  await run(process.execPath, [APPLY, '--apply', '--root', PACKAGE_COPY])

  const patched = await readFile(indexPath, 'utf8')
  assert.equal(await readFile(backupPath, 'utf8'), pristine, 'the backup must be the published file, byte for byte')
  assert.ok(patched.startsWith(pristine.trimEnd()), 'the published file must survive untouched underneath the override')
  assert.equal(patched.split('SettingsForms.prototype.importLegacyDocument =').length, 2, 'exactly one override is appended')
  assert.equal(
    await readFile(join(PACKAGE_COPY, 'lib', 'legacy-import-fix.js'), 'utf8'),
    await readFile(SOURCE_MODULE, 'utf8'),
    'the replacement module must be installed verbatim',
  )

  await run(process.execPath, [APPLY, '--apply', '--root', PACKAGE_COPY])
  assert.equal(await readFile(indexPath, 'utf8'), patched, 're-applying must not change a byte')

  const { stdout } = await run(process.execPath, [APPLY, '--check', '--root', PACKAGE_COPY])
  assert.equal(JSON.parse(stdout.slice(0, stdout.lastIndexOf('}') + 1)).patched, true)

  await run(process.execPath, [APPLY, '--revert', '--root', PACKAGE_COPY])
  assert.equal(await readFile(indexPath, 'utf8'), pristine, 'reverting must restore the published bytes')
})

test('the patched package loads and drives the transactional migration', async () => {
  await copyPackage()
  const indexPath = join(PACKAGE_COPY, 'lib', 'index.js')
  if (!(await readFile(indexPath, 'utf8')).includes('dsh-legacy-import-fix ─')) {
    await run(process.execPath, [APPLY, '--apply', '--root', PACKAGE_COPY])
  }

  const loaded = await import(pathToFileURL(indexPath).href)
  const SettingsForms = loaded.default ?? loaded.SettingsForms
  assert.equal(typeof SettingsForms, 'function')
  assert.ok(
    String(SettingsForms.prototype.importLegacyDocument).includes('legacy-import-fix.js'),
    'the loaded class must resolve its migration through the shipped replacement module',
  )

  const home = join(RUN_ROOT, 'install-copy-home')
  const world = makeHost({ home, profileName: 'headless' })
  await writeLegacyDocument(home, FLOWLET_LEGACY_YAML)
  await SettingsForms.prototype.importLegacyDocument.call(world.host, { yaml, registrationWaitMs: 50 })

  assert.equal(world.rows.get('llm-pi-ai').providers.flowlet.api, 'openai-completions')
  assert.deepEqual(world.rows.get('agent-default-model'), { provider: 'flowlet', model: 'flowlet-pro' })
  assert.equal(existsSync(join(home, 'settings.yaml')), false)
  assert.equal(existsSync(join(home, 'settings.yaml.imported')), true)
})

test('the installer refuses to patch a differently versioned package', async () => {
  await copyPackage()
  const manifestPath = join(PACKAGE_COPY, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: '0.3.0' }, null, 2)}\n`)

  await assert.rejects(
    run(process.execPath, [APPLY, '--apply', '--root', PACKAGE_COPY]),
    (error) => String(error.stderr).includes('written for 0.2.0-rc.2'),
  )
  assert.equal(
    (await readFile(join(PACKAGE_COPY, 'lib', 'index.js'), 'utf8')).includes('dsh-legacy-import-fix ─'),
    false,
    'a refused apply must not modify index.js',
  )
})
