/**
 * Schema-level regression tests for the legacy provider profile shape.
 *
 * These use the *installed* `@deepseek-ai/dsh-llm-pi-ai` and
 * `@deepseek-ai/dsh-agent-default-model` Config schemas, so they pin the
 * contract the migration writes against: a custom OpenAI-compatible route with
 * `apiKeyEnv`, `baseURL` and per-model `contextWindow` / `input` must resolve,
 * and the default model must name a route the same patch registers.
 *
 * Note on scope: the Config schema is deliberately permissive about the
 * pre-0.2 shapes (a `provider` key inside the profile, or `providers` as an
 * array). Those are refused one layer down, by the adapter's own
 * `internal/config` resolver, at write time. That refusal — and the
 * half-migration it used to cause — is covered end to end in
 * `e2e-profiles.test.mjs`, where a real boot rejects the shape.
 *
 * Run with: node --test tools/dsh-settings-legacy-import/tests/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FLOWLET_LEGACY_YAML,
  RUN_ROOT,
  cleanupRunRoot,
  importFromDsh,
  loadFixModule,
  loadYaml,
  makeHost,
  writeLegacyDocument,
} from './helpers.mjs'

const { Config: PiAiConfig } = await importFromDsh('@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
const AgentDefaultModel = (await importFromDsh('@deepseek-ai/dsh-agent-default-model/lib/index.js')).default
const { resolveConfig } = await importFromDsh('@deepseek-ai/cordis/lib/index.js')

const yaml = loadYaml()
const { importLegacyDocument } = await loadFixModule()

/** The exact provider profile the bug report carries. */
const FLOWLET_PROFILE = {
  api: 'openai-completions',
  apiKeyEnv: 'FLOWLET_CLIENT_TOKEN',
  baseURL: 'http://127.0.0.1:18640/v1',
  displayName: 'Flowlet',
  models: [
    { id: 'flowlet-pro', contextWindow: 1048576, input: ['text', 'image'] },
    { id: 'flowlet-flash', contextWindow: 1048576, input: ['text', 'image'] },
  ],
}

test.after(cleanupRunRoot)

test('the llm-pi-ai schema resolves a custom openai-completions provider', () => {
  const resolved = resolveConfig(PiAiConfig, { providers: { flowlet: FLOWLET_PROFILE } })
  const profile = resolved.providers.flowlet

  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.baseURL, 'http://127.0.0.1:18640/v1')
  assert.equal(profile.displayName, 'Flowlet')
  assert.deepEqual(
    profile.models.map((model) => [model.id, model.contextWindow, model.input]),
    [
      ['flowlet-pro', 1048576, ['text', 'image']],
      ['flowlet-flash', 1048576, ['text', 'image']],
    ],
  )
})

test('the llm-pi-ai schema preserves the apiKeyEnv credential reference', () => {
  const resolved = resolveConfig(PiAiConfig, { providers: { flowlet: FLOWLET_PROFILE } })
  assert.equal(resolved.providers.flowlet.apiKeyEnv, 'FLOWLET_CLIENT_TOKEN')
  // Nothing in the resolved value inlines a secret; the reference is the value.
  assert.equal(JSON.stringify(resolved).includes('sk-'), false)
})

test('a route with no protocol of its own is still accepted', () => {
  const resolved = resolveConfig(PiAiConfig, {
    providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
  })
  assert.equal(resolved.providers.openai.apiKeyEnv, 'OPENAI_API_KEY')
})

test('agent-default-model accepts the migrated selection', () => {
  const resolved = resolveConfig(AgentDefaultModel.Config, { provider: 'flowlet', model: 'flowlet-pro' })
  assert.equal(resolved.provider, 'flowlet')
  assert.equal(resolved.model, 'flowlet-pro')
})

test('agent-default-model does not itself police an empty selection', () => {
  // `provider`/`model` are optional volatile fields, so an empty selection
  // resolves rather than throwing. That is precisely why the migration carries
  // its own pre-flight gate: nothing downstream would otherwise notice that the
  // committed selection names a provider with no adapter.
  const partial = resolveConfig(AgentDefaultModel.Config, { model: 'flowlet-pro' })
  assert.equal(partial.provider, undefined)
  assert.equal(partial.model, 'flowlet-pro')
})

test('what the migration writes is exactly what the adapter schema accepts', async () => {
  const world = makeHost({ home: `${RUN_ROOT}/schema-flowlet`, profileName: 'web' })
  await writeLegacyDocument(world.home, FLOWLET_LEGACY_YAML)
  await importLegacyDocument.call(world.host, { yaml, registrationWaitMs: 50 })

  const written = world.rows.get('llm-pi-ai')
  assert.ok(written !== undefined, 'the migration must have written llm-pi-ai')

  const resolved = resolveConfig(PiAiConfig, written)
  assert.equal(resolved.providers.flowlet.api, 'openai-completions')
  assert.equal(resolved.providers.flowlet.apiKeyEnv, 'FLOWLET_CLIENT_TOKEN')
  assert.equal(resolved.providers.flowlet.models.length, 2)

  const selection = resolveConfig(AgentDefaultModel.Config, world.rows.get('agent-default-model'))
  assert.deepEqual(
    { provider: selection.provider, model: selection.model },
    { provider: 'flowlet', model: 'flowlet-pro' },
  )
  assert.ok(
    Object.keys(resolved.providers).includes(selection.provider),
    'the default model must name a provider the same patch registers',
  )
})

test('the legacy document is not mutated when it is migrated', async () => {
  const world = makeHost({ home: `${RUN_ROOT}/schema-text`, profileName: 'web' })
  await writeLegacyDocument(world.home, FLOWLET_LEGACY_YAML)
  await importLegacyDocument.call(world.host, { yaml, registrationWaitMs: 50 })

  const { legacyDocumentState } = await import('./helpers.mjs')
  const state = await legacyDocumentState(world.home)
  assert.equal(state.importedText, FLOWLET_LEGACY_YAML)
})
