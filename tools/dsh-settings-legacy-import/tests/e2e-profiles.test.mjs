/**
 * End-to-end regression tests: the real `dsh` 0.2.0-rc.2 CLI booting real
 * profiles against a throwaway `DSH_HOME`.
 *
 * Each case reproduces a scenario from the bug report and asserts the outcome
 * the transactional migration guarantees:
 *
 *   1. headless migrates the legacy document, and the next boot actually serves
 *      the migrated provider (a fake OpenAI-compatible endpoint answers);
 *   2. the pre-0.2 profile shape is rejected without consuming the document and
 *      without committing the default model that references the rejected
 *      provider — the exact `no adapter registered for provider "flowlet"`
 *      half-migration;
 *   3. web migrates the legacy document into the web profile patch;
 *   4. a web boot that cannot bind its port imports nothing and keeps the
 *      document for the next, healthy boot.
 *
 * The suite needs the override installed:
 *
 *   node tools/dsh-settings-legacy-import/apply.mjs --apply
 *   node --test tools/dsh-settings-legacy-import/tests/
 *
 * It skips itself, with an explicit reason, when the installed package is
 * unpatched so the unit and schema suites still run on a stock installation.
 *
 * @module tools/dsh-settings-legacy-import/tests/e2e-profiles
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  REPO_ROOT,
  cleanupRunRoot,
  installedFixState,
  legacyDocumentState,
  loadYaml,
  makeDshHome,
  occupyPort,
  readFailureReport,
  readPatchRows,
  rowFor,
  runDsh,
  runDshUntil,
  startFakeOpenAiProvider,
} from './helpers.mjs'

const yaml = loadYaml()
const installed = await installedFixState()
/**
 * Skipping keeps the suite green on a stock installation. Setting
 * `DSH_LEGACY_IMPORT_FORCE_E2E=1` runs it anyway — that is how this suite is
 * verified to *fail* against the unmodified 0.2.0-rc.2 behaviour:
 *
 *   node tools/dsh-settings-legacy-import/apply.mjs --revert
 *   DSH_LEGACY_IMPORT_FORCE_E2E=1 node --test tools/dsh-settings-legacy-import/tests/e2e-profiles.test.mjs
 *   node tools/dsh-settings-legacy-import/apply.mjs --apply
 */
const forced = process.env.DSH_LEGACY_IMPORT_FORCE_E2E === '1'
const skip =
  installed.patched && installed.moduleCurrent
    ? false
    : forced
      ? false
      : `the transactional migration is not installed in ${installed.root} (version ${installed.version}); ` +
        `run: node ${join(REPO_ROOT, 'tools/dsh-settings-legacy-import/apply.mjs')} --apply`

const PROVIDER_TOKEN_ENV = { FLOWLET_CLIENT_TOKEN: 'e2e-placeholder-token' }

/** The legacy document reported in the bug, pointed at a chosen endpoint. */
function legacyDocument(baseURL, extra = '') {
  return `llm-pi-ai:
  providers:
    flowlet:
      ${extra}api: openai-completions
      apiKeyEnv: FLOWLET_CLIENT_TOKEN
      baseURL: ${baseURL}
      displayName: Flowlet
      models:
        - id: flowlet-pro
          contextWindow: 1048576
          input: [text, image]
        - id: flowlet-flash
          contextWindow: 1048576
          input: [text, image]
agent-default-model:
  provider: flowlet
  model: flowlet-pro
`
}

test.after(cleanupRunRoot)

test('headless migrates the legacy document and the next boot serves the migrated provider', { skip }, async () => {
  const provider = await startFakeOpenAiProvider({ reply: 'PROBE_OK' })
  try {
    const home = await makeDshHome('e2e-headless-ok', legacyDocument(`http://127.0.0.1:${provider.port}/v1`))

    const first = await runDsh(home, ['--profile', 'headless', '--json', 'reply with PROBE_OK'], {
      timeoutMs: 180000,
      env: PROVIDER_TOKEN_ENV,
    })
    void first

    const state = await legacyDocumentState(home)
    assert.equal(state.imported, true, 'the document is consumed once every section imported')
    assert.equal(state.present, false)
    assert.equal(await readFailureReport(home), undefined)

    const rows = await readPatchRows(yaml, join(home, 'profiles', 'headless', 'cordis.patch.yml'))
    const providerRow = rowFor(rows, 'llm-pi-ai')
    assert.ok(providerRow !== undefined, 'llm-pi-ai must reach the headless profile patch')
    assert.equal(providerRow.config.providers.flowlet.api, 'openai-completions')
    assert.equal(providerRow.config.providers.flowlet.apiKeyEnv, 'FLOWLET_CLIENT_TOKEN')
    assert.equal(providerRow.config.providers.flowlet.models.length, 2)
    assert.deepEqual(rowFor(rows, 'agent-default-model').config, { provider: 'flowlet', model: 'flowlet-pro' })

    // Second boot: the migrated provider is registered and actually used.
    const second = await runDsh(home, ['--profile', 'headless', '--json', 'reply with PROBE_OK'], {
      timeoutMs: 180000,
      env: PROVIDER_TOKEN_ENV,
    })
    assert.equal(second.code, 0, `second boot must succeed, stderr: ${second.stderr.slice(-400)}`)
    assert.match(second.stdout, /PROBE_OK/)
    assert.ok(
      provider.requests.some((url) => String(url).endsWith('/chat/completions')),
      `the migrated provider endpoint must receive the request, saw: ${JSON.stringify(provider.requests)}`,
    )
    assert.equal(
      second.stdout.includes('no adapter registered for provider'),
      false,
      'the migrated provider must have a registered adapter',
    )
  } finally {
    await provider.close()
  }
})

test('headless rejects the pre-0.2 profile shape without committing a dangling default model', { skip }, async () => {
  const provider = await startFakeOpenAiProvider({ reply: 'never-reached' })
  try {
    const home = await makeDshHome(
      'e2e-headless-pre02',
      legacyDocument(`http://127.0.0.1:${provider.port}/v1`, 'provider: flowlet\n      '),
    )

    await runDsh(home, ['--profile', 'headless', '--json', 'reply with anything'], {
      timeoutMs: 180000,
      env: PROVIDER_TOKEN_ENV,
    })

    const state = await legacyDocumentState(home)
    assert.equal(state.present, true, 'the document must survive a rejected section')
    assert.equal(state.imported, false)

    const rows = await readPatchRows(yaml, join(home, 'profiles', 'headless', 'cordis.patch.yml'))
    assert.equal(rowFor(rows, 'llm-pi-ai'), undefined, 'the rejected provider must not be written')
    assert.equal(
      rowFor(rows, 'agent-default-model'),
      undefined,
      'the default model must not be committed while its provider is unregistered',
    )

    const report = await readFailureReport(home)
    assert.ok(report !== undefined, 'a failure ledger must be written for the operator')
    assert.equal(report.legacyDocumentConsumed, false)
    assert.match(report.failures[0].message, /moved to the providers dict key/)
    assert.equal(report.failures[0].entry, 'llm-pi-ai')
  } finally {
    await provider.close()
  }
})

test('web migrates the legacy document into the web profile patch', { skip }, async () => {
  const home = await makeDshHome('e2e-web-ok', legacyDocument('http://127.0.0.1:1/v1'))
  const imported = join(home, 'settings.yaml.imported')

  // The surface prints its URL before `loader.await()` resolves, so wait for the
  // migration's own effect rather than for the ready line alone.
  const boot = await runDshUntil(home, ['--profile', 'web', '--port', '0', '--no-open'], {
    timeoutMs: 180000,
    env: PROVIDER_TOKEN_ENV,
    until: ({ stdout }) => stdout.includes('dsh web: http') && existsSync(imported),
  })
  assert.equal(boot.matched, true, `the web migration must complete; stderr: ${boot.stderr.slice(-400)}`)

  const state = await legacyDocumentState(home)
  assert.equal(state.imported, true)
  assert.equal(state.present, false)

  const rows = await readPatchRows(yaml, join(home, 'profiles', 'web', 'cordis.patch.yml'))
  const providerRow = rowFor(rows, 'llm-pi-ai')
  assert.ok(providerRow !== undefined, 'llm-pi-ai must reach the web profile patch')
  assert.equal(providerRow.config.providers.flowlet.baseURL, 'http://127.0.0.1:1/v1')
  assert.equal(providerRow.config.providers.flowlet.api, 'openai-completions')
  assert.deepEqual(rowFor(rows, 'agent-default-model').config, { provider: 'flowlet', model: 'flowlet-pro' })
})

test('a web boot that cannot bind its port imports nothing and keeps the document', { skip }, async () => {
  const occupied = await occupyPort()
  try {
    const home = await makeDshHome('e2e-web-eaddrinuse', legacyDocument('http://127.0.0.1:1/v1'))
    const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const before = await readPatchRows(yaml, patchPath)

    const run = await runDsh(home, ['--profile', 'web', '--port', String(occupied.port), '--no-open'], {
      timeoutMs: 180000,
      env: PROVIDER_TOKEN_ENV,
    })
    assert.notEqual(run.code, 0, 'the failed bind must fail the process')
    assert.match(run.stderr, /EADDRINUSE/)

    const state = await legacyDocumentState(home)
    assert.equal(state.present, true, 'a doomed boot must not consume the legacy document')
    assert.equal(state.imported, false)

    const after = await readPatchRows(yaml, patchPath)
    assert.deepEqual(after, before, 'a doomed boot must not write any section')
    assert.equal(rowFor(after, 'llm-pi-ai'), undefined)
    assert.equal(rowFor(after, 'agent-default-model'), undefined)
    assert.equal(existsSync(join(home, 'settings.yaml')), true)
  } finally {
    await occupied.close()
  }
})
