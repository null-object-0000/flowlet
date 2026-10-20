#!/usr/bin/env node
/**
 * Install / verify / revert the transactional legacy-settings migration in an
 * installed `@deepseek-ai/dsh-settings` 0.2.0-rc.2.
 *
 * What it changes (three files under the package, nothing else):
 *
 *   lib/legacy-import-fix.js            copied in verbatim from this tool
 *   lib/index.js                        ONE appended block that overrides
 *                                       `SettingsForms.prototype.importLegacyDocument`
 *   lib/index.js.dsh-legacy-import-fix.bak   pristine copy, written once on apply
 *
 * The appended block is the whole upstream diff. It defers to the replacement
 * module, so no published code is edited in place and `--revert` is a byte-exact
 * truncation back to the backup.
 *
 * Usage:
 *   node tools/dsh-settings-legacy-import/apply.mjs --check
 *   node tools/dsh-settings-legacy-import/apply.mjs --apply   [--root <dsh-settings-dir>]
 *   node tools/dsh-settings-legacy-import/apply.mjs --revert  [--root <dsh-settings-dir>]
 *   node tools/dsh-settings-legacy-import/apply.mjs --restore-backup [--root <dir>]
 *
 * A `--root` may point at the `dsh-settings` package directory, at the
 * `@deepseek-ai/dsh` package/installation directory, or at any directory above
 * them. Without it the installed package is discovered automatically.
 */

import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locateDshSettings } from './lib/locate-install.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE_MODULE = join(HERE, 'lib', 'legacy-import-fix.js')

/** Marker that identifies the appended override block. */
const MARKER = 'dsh-legacy-import-fix'
const BACKUP_SUFFIX = `.${MARKER}.bak`
const PATCHED_MODULE = 'legacy-import-fix.js'

const BLOCK = `
// ─── ${MARKER} ─────────────────────────────────────────────────────────────
// Published 0.2.0-rc.2 consumed <DSH_HOME>/settings.yaml before it knew whether
// the migration could succeed, imported every section independently, and never
// rolled back. The replacement below is transactional: the document is renamed
// only after every section imported, the provider sections and the
// agent-default-model that references them commit as one unit, a failed write
// rolls the unit back, and a default model may never be committed while its
// provider has no registered adapter.
//
// See tools/dsh-settings-legacy-import/README.md in the Flowlet checkout.
SettingsForms.prototype.importLegacyDocument = async function importLegacyDocument(options) {
	const { importLegacyDocument } = await import("./${PATCHED_MODULE}");
	return importLegacyDocument.call(this, options);
};
// ─── end ${MARKER} ─────────────────────────────────────────────────────────
`

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const optionValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const modes = ['--check', '--apply', '--revert', '--restore-backup'].filter(flag)
if (modes.length !== 1) {
  console.error('usage: apply.mjs (--check | --apply | --revert | --restore-backup) [--root <dir>]')
  process.exit(2)
}
const mode = modes[0]

/** Locate the installed package, or explain why none was found. */
function locate() {
  try {
    return locateDshSettings(optionValue('--root'))
  } catch (error) {
    console.error(error.message)
    process.exit(6)
  }
}

/** Current state of one package directory. */
async function inspect(root) {
  const indexPath = join(root, 'lib', 'index.js')
  const backupPath = `${indexPath}${BACKUP_SUFFIX}`
  const modulePath = join(root, 'lib', PATCHED_MODULE)
  const index = await readFile(indexPath, 'utf8')
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  return {
    root,
    version,
    indexPath,
    backupPath,
    modulePath,
    patched: index.includes(`${MARKER} ─`),
    backupPresent: existsSync(backupPath),
    modulePresent: existsSync(modulePath),
    index,
  }
}

/** Keep a pristine copy of `lib/index.js` before the first modification. */
async function ensureBackup(state) {
  if (state.backupPresent) return false
  await copyFile(state.indexPath, state.backupPath)
  return true
}

async function doCheck() {
  const root = locate()
  const state = await inspect(root)
  const source = await readFile(SOURCE_MODULE, 'utf8')
  const installed = state.modulePresent ? await readFile(state.modulePath, 'utf8') : undefined
  const report = {
    package: '@deepseek-ai/dsh-settings',
    version: state.version,
    root,
    patched: state.patched,
    replacementModuleInstalled: state.modulePresent,
    replacementModuleCurrent: installed === source,
    backupPresent: state.backupPresent,
  }
  console.log(JSON.stringify(report, null, 2))
  const healthy = report.patched && report.replacementModuleInstalled && report.replacementModuleCurrent && report.backupPresent
  if (!healthy) {
    console.error(
      '\nnot fully installed: run `node tools/dsh-settings-legacy-import/apply.mjs --apply`' +
        (optionValue('--root') === undefined ? '' : ` --root ${root}`),
    )
    process.exit(1)
  }
}

async function doApply() {
  const root = locate()
  const state = await inspect(root)
  if (state.version !== '0.2.0-rc.2') {
    console.error(
      `refusing to patch @deepseek-ai/dsh-settings@${state.version}: this fix is written for 0.2.0-rc.2. ` +
        'Re-derive the replacement against the target release first.',
    )
    process.exit(3)
  }
  const created = await ensureBackup(state)
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(state.modulePath, await readFile(SOURCE_MODULE, 'utf8'))

  let index = state.index
  if (state.backupPresent && !state.patched) {
    const backup = await readFile(state.backupPath, 'utf8')
    if (backup !== state.index) {
      console.error(
        `warning: ${state.indexPath} differs from ${state.backupPath}; ` +
          'patching the current file and keeping the backup as it is',
      )
    } else {
      index = backup
    }
  }
  if (!index.includes(`${MARKER} ─`)) {
    index = `${index.trimEnd()}\n${BLOCK}`
  }
  await writeFile(state.indexPath, index)
  console.log(
    JSON.stringify(
      {
        applied: true,
        root,
        backupCreated: created,
        backup: state.backupPath,
        replacementModule: state.modulePath,
      },
      null,
      2,
    ),
  )
}

async function doRevert() {
  const root = locate()
  const state = await inspect(root)
  if (!state.backupPresent) {
    console.error(`no backup at ${state.backupPath}; nothing to revert`)
    process.exit(5)
  }
  await copyFile(state.backupPath, state.indexPath)
  console.log(JSON.stringify({ reverted: true, root, restoredFrom: state.backupPath }, null, 2))
}

async function doRestoreBackup() {
  const root = locate()
  const state = await inspect(root)
  if (!state.backupPresent) {
    console.error(`no backup at ${state.backupPath}; nothing to restore`)
    process.exit(5)
  }
  await copyFile(state.backupPath, state.indexPath)
  console.log(JSON.stringify({ restored: true, root, restoredFrom: state.backupPath }, null, 2))
}

const start = Date.now()
if (mode === '--check') await doCheck()
else if (mode === '--apply') await doApply()
else if (mode === '--revert') await doRevert()
else await doRestoreBackup()
console.log(`(${mode.slice(2)} finished in ${Date.now() - start}ms)`)
