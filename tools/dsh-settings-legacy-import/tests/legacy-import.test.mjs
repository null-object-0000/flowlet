/**
 * Regression tests for the transactional legacy `settings.yaml` migration.
 *
 * Every test drives the installed replacement module through the fake
 * `SettingsForms` host in `helpers.mjs`, which reproduces the two field
 * failures exactly:
 *
 *   - a boot whose settings context is already disposed (the EADDRINUSE run
 *     that consumed the document and imported nothing);
 *   - a boot where the provider section is rejected while the dependent
 *     `agent-default-model` section still commits (the documented
 *     `no adapter registered for provider "flowlet"` state).
 *
 * Run with: node --test tools/dsh-settings-legacy-import/tests/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FLOWLET_LEGACY_YAML,
  RUN_ROOT,
  cleanupRunRoot,
  legacyDocumentState,
  loadFixModule,
  loadYaml,
  makeHost,
  mergePatch,
  readFailureReport,
  writeLegacyDocument,
} from './helpers.mjs'

const yaml = loadYaml()
const { importLegacyDocument } = await loadFixModule()

let counter = 0
const nextHome = (label) => `${RUN_ROOT}/unit-${label}-${(counter += 1)}`

/** Run the migration against a fake host seeded with the given document. */
async function migrate(host, home, document = FLOWLET_LEGACY_YAML, options = {}) {
  await writeLegacyDocument(home, document)
  await importLegacyDocument.call(host, { yaml, registrationWaitMs: 50, ...options })
}

const updateIds = (events) => events.filter((event) => event.type === 'update').map((event) => event.id)

test.after(cleanupRunRoot)

test('migrates a custom openai-completions provider and the default model that references it', async () => {
  const home = nextHome('flowlet-web')
  const world = makeHost({ home, profileName: 'web' })

  await migrate(world.host, home)

  const provider = world.rows.get('llm-pi-ai')
  assert.ok(provider !== undefined, 'llm-pi-ai must be imported')
  const profile = provider.providers.flowlet
  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.apiKeyEnv, 'FLOWLET_CLIENT_TOKEN')
  assert.equal(profile.baseURL, 'http://127.0.0.1:18640/v1')
  assert.equal(profile.displayName, 'Flowlet')
  assert.deepEqual(
    profile.models.map((model) => [model.id, model.contextWindow, model.input]),
    [
      ['flowlet-pro', 1048576, ['text', 'image']],
      ['flowlet-flash', 1048576, ['text', 'image']],
    ],
  )

  assert.deepEqual(world.rows.get('agent-default-model'), { provider: 'flowlet', model: 'flowlet-pro' })

  const state = await legacyDocumentState(home)
  assert.equal(state.present, false, 'the legacy document is consumed only after a full success')
  assert.equal(state.imported, true)
  assert.equal(state.importedText, FLOWLET_LEGACY_YAML)
  assert.equal(await readFailureReport(home), undefined)
  assert.deepEqual(world.logs.error, [])
})

test('commits provider sections before the default model regardless of document order', async () => {
  const home = nextHome('order')
  const world = makeHost({ home })
  const reversed = `agent-default-model:
  provider: flowlet
  model: flowlet-pro
llm-pi-ai:
  providers:
    flowlet:
      api: openai-completions
      apiKeyEnv: FLOWLET_CLIENT_TOKEN
      baseURL: http://127.0.0.1:18640/v1
      models:
        - id: flowlet-pro
          contextWindow: 1048576
`

  await migrate(world.host, home, reversed)

  assert.deepEqual(updateIds(world.events), ['llm-pi-ai', 'agent-default-model'])
})

test('a failing provider section never commits the default model that references it', async () => {
  const home = nextHome('half-migration')
  const world = makeHost({ home, failOn: 'llm-pi-ai' })

  await migrate(world.host, home)

  assert.equal(world.rows.has('agent-default-model'), false, 'the half-migrated default model must never be written')
  assert.equal(world.rows.size, 0)
  assert.deepEqual(updateIds(world.events), ['llm-pi-ai'])

  const state = await legacyDocumentState(home)
  assert.equal(state.present, true, 'the document stays in place so the next boot can retry')
  assert.equal(state.imported, false)

  const report = await readFailureReport(home)
  assert.equal(report.kind, 'dsh-settings-legacy-import')
  assert.equal(report.legacyDocumentConsumed, false)
  assert.deepEqual(report.failures.map((failure) => [failure.section, failure.entry, failure.phase]), [
    ['llm-pi-ai', 'llm-pi-ai', 'write'],
  ])
  assert.ok(report.remedy.some((line) => line.includes('was left in place')))
  assert.ok(world.logs.error.length > 0, 'the failure must be reported at error level')
})

test('rolls back every written section when a later section fails', async () => {
  const home = nextHome('rollback')
  const world = makeHost({ home, failOn: 'ui-settings-general' })
  const document = `${FLOWLET_LEGACY_YAML}ui-onboarding:
  seen: true
`

  await migrate(world.host, home, document)

  assert.equal(world.rows.has('llm-pi-ai'), false, 'the committed provider section is rolled back')
  assert.equal(world.rows.has('agent-default-model'), false, 'the committed default model is rolled back')

  const state = await legacyDocumentState(home)
  assert.equal(state.present, true)
  assert.equal(state.imported, false)

  const report = await readFailureReport(home)
  assert.deepEqual(report.failures.map((failure) => failure.entry), ['ui-settings-general'])
  assert.deepEqual(report.appliedAndRolledBack.map((row) => row.entry), ['llm-pi-ai', 'agent-default-model'])
})

test('refuses before writing anything when the default model names a route nothing registers', async () => {
  const home = nextHome('dangling')
  const world = makeHost({ home, configurableRoutes: ['deepseek-official'] })
  const document = `llm-pi-ai:
  providers:
    someother:
      api: openai-completions
      baseURL: http://127.0.0.1:18640/v1
agent-default-model:
  provider: ghost
  model: ghost-pro
`

  await migrate(world.host, home, document)

  assert.deepEqual(updateIds(world.events), [], 'nothing may be written when the composition cannot serve the default model')
  const state = await legacyDocumentState(home)
  assert.equal(state.present, true)
  assert.equal(state.imported, false)

  const report = await readFailureReport(home)
  assert.equal(report.failures[0].phase, 'preflight')
  assert.match(report.failures[0].message, /ghost/)
  assert.ok(world.logs.error.some((args) => String(args[0]).includes('refusing to import')))
})

test('refuses when the default model is not listed by the profile that introduces the provider', async () => {
  const home = nextHome('typo-model')
  const world = makeHost({ home })
  const document = `llm-pi-ai:
  providers:
    flowlet:
      api: openai-completions
      baseURL: http://127.0.0.1:18640/v1
      models:
        - id: flowlet-pro
          contextWindow: 1048576
agent-default-model:
  provider: flowlet
  model: flowlet-typo
`

  await migrate(world.host, home, document)

  assert.deepEqual(updateIds(world.events), [])
  const report = await readFailureReport(home)
  assert.equal(report.failures[0].phase, 'preflight')
  assert.match(report.failures[0].message, /flowlet-typo/)
  assert.match(report.failures[0].message, /flowlet-pro/)
})

test('rolls back when the route never appears in the live adapter registry', async () => {
  const home = nextHome('verify')
  const world = makeHost({
    home,
    registeredRoutes: [],
    configurableRoutes: ['deepseek-official'],
    registrationSideEffect: false,
  })

  await migrate(world.host, home)

  assert.equal(world.rows.size, 0, 'the unit is rolled back when the provider never registers')
  const state = await legacyDocumentState(home)
  assert.equal(state.present, true)
  assert.equal(state.imported, false)

  const report = await readFailureReport(home)
  assert.equal(report.failures[0].phase, 'verify')
  assert.match(report.failures[0].message, /NO_ADAPTER/)
})

test('leaves the document untouched when the settings context is already disposed', async () => {
  const home = nextHome('inactive')
  const world = makeHost({ home, inactive: true })

  await migrate(world.host, home)

  assert.deepEqual(updateIds(world.events), [])
  const state = await legacyDocumentState(home)
  assert.equal(state.present, true)
  assert.equal(state.imported, false)

  const report = await readFailureReport(home)
  assert.equal(report.failures[0].phase, 'preflight')
  assert.match(report.failures[0].message, /inactive/)
  assert.ok(world.logs.warn.length > 0, 'an unimportable boot must warn without consuming the document')
})

test('leaves the document untouched when the config editor service is unreachable', async () => {
  const home = nextHome('no-editor')
  const world = makeHost({ home, configEditorInactive: true })

  await migrate(world.host, home)

  assert.deepEqual(updateIds(world.events), [])
  const state = await legacyDocumentState(home)
  assert.equal(state.present, true)
  assert.equal(state.imported, false)
  const report = await readFailureReport(home)
  assert.equal(report.failures[0].phase, 'preflight')
})

test('does not re-consume a legacy document once it has been imported', async () => {
  const home = nextHome('already-imported')
  const world = makeHost({ home })
  await writeLegacyDocument(home, FLOWLET_LEGACY_YAML)
  const { rename } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await rename(join(home, 'settings.yaml'), join(home, 'settings.yaml.imported'))
  await writeLegacyDocument(home, 'agent-default-model:\n  provider: flowlet\n  model: flowlet-pro\n')

  await importLegacyDocument.call(world.host, { yaml, registrationWaitMs: 50 })

  assert.deepEqual(updateIds(world.events), [])
  assert.equal(world.rows.size, 0)
})

test('reports an unparseable document and leaves it in place', async () => {
  const home = nextHome('malformed')
  const world = makeHost({ home })

  await migrate(world.host, home, 'llm-pi-ai: [this is not a mapping\n')

  assert.deepEqual(updateIds(world.events), [])
  const state = await legacyDocumentState(home)
  assert.equal(state.present, true)
  assert.equal(state.imported, false)
  const report = await readFailureReport(home)
  assert.equal(report.failures[0].phase, 'parse')
})

test('maps removed section names onto the entries that own them', async () => {
  const home = nextHome('mapping')
  const world = makeHost({ home })
  const document = `ui-onboarding:
  seen: true
ui-developer-tools:
  enabled: false
shell:
  timeoutMs: 1000
`

  await migrate(world.host, home, document)

  assert.deepEqual(updateIds(world.events).sort(), ['bash-sandbox', 'ui-settings', 'ui-settings-general'])
  assert.deepEqual(world.rows.get('ui-settings-general'), { seen: true })
  assert.equal((await legacyDocumentState(home)).imported, true)
})

test('a failed migration is retried on the next boot and then completes', async () => {
  const home = nextHome('retry')
  const first = makeHost({ home, failOn: 'llm-pi-ai' })

  await migrate(first.host, home)
  assert.equal((await legacyDocumentState(home)).present, true)
  assert.notEqual(await readFailureReport(home), undefined)

  const second = makeHost({ home })
  await importLegacyDocument.call(second.host, { yaml, registrationWaitMs: 50 })

  assert.deepEqual(second.rows.get('agent-default-model'), { provider: 'flowlet', model: 'flowlet-pro' })
  const state = await legacyDocumentState(home)
  assert.equal(state.present, false)
  assert.equal(state.imported, true)
  assert.equal(await readFailureReport(home), undefined, 'a successful retry clears the stale ledger')
})

test('migrates the same section content for the web and headless profiles', async () => {
  const webHome = nextHome('web')
  const headlessHome = nextHome('headless')
  const web = makeHost({ home: webHome, profileName: 'web' })
  const headless = makeHost({ home: headlessHome, profileName: 'headless' })

  await migrate(web.host, webHome)
  await migrate(headless.host, headlessHome)

  assert.deepEqual(web.rows.get('llm-pi-ai'), headless.rows.get('llm-pi-ai'))
  assert.deepEqual(web.rows.get('agent-default-model'), headless.rows.get('agent-default-model'))
  assert.equal(web.patchPath.endsWith('profiles/web/cordis.patch.yml'), true)
  assert.equal(headless.patchPath.endsWith('profiles/headless/cordis.patch.yml'), true)
  assert.equal((await legacyDocumentState(webHome)).imported, true)
  assert.equal((await legacyDocumentState(headlessHome)).imported, true)
})

test('re-applying a successful migration is a no-op', async () => {
  const home = nextHome('idempotent')
  const world = makeHost({ home })

  await migrate(world.host, home)
  const first = structuredClone(world.rows.get('llm-pi-ai'))

  // The document is gone, so a second pass has nothing to do.
  await importLegacyDocument.call(world.host, { yaml, registrationWaitMs: 50 })
  assert.deepEqual(world.rows.get('llm-pi-ai'), first)
  assert.deepEqual(mergePatch(first, {}), first)
})
