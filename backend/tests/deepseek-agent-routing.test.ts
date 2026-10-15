import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const workspace = mkdtempSync(path.join(tmpdir(), 'huobao-agent-routing-'))
mkdirSync(path.join(workspace, 'prompts'))
process.env.WORKSPACE_PATH = workspace
process.env.SQLITE_PATH = ':memory:'
after(() => rmSync(workspace, { recursive: true, force: true }))

test('DeepSeek is an allowed text provider with a normalized custom base URL', async () => {
  const { isOfficialProvider, getTextProviderBaseUrl } = await import('../src/services/ai.js')
  assert.equal(isOfficialProvider('text', 'deepseek'), true)
  assert.equal(isOfficialProvider('image', 'deepseek'), false)
  assert.equal(getTextProviderBaseUrl({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'custom-id' }), 'https://api.deepseek.com/v1')
  assert.equal(getTextProviderBaseUrl({ provider: 'deepseek', baseUrl: 'https://proxy.example/deepseek/v1/', apiKey: 'test', model: 'custom-id' }), 'https://proxy.example/deepseek/v1')
})

test('AI config lookup retains its ID and workflow settings without leaking them into temperature', async () => {
  const { db, schema, getInsertId } = await import('../src/db/index.js')
  const { getConfigById, getActiveConfig } = await import('../src/services/ai.js')
  const inserted = await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-only', model: JSON.stringify(['custom-id']), settings: JSON.stringify({ temperature: 0.4, workflowId: '123', nodeMapping: { prompt: '6.text' } }),
    priority: 999, isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  })
  const id = getInsertId(inserted)
  for (const config of [await getConfigById(id), await getActiveConfig('text')]) {
    assert.equal(config?.id, id)
    assert.equal(config?.model, 'custom-id')
    assert.equal(config?.temperature, 0.4)
    assert.deepEqual(config?.settings, { temperature: 0.4, workflowId: '123', nodeMapping: { prompt: '6.text' } })
  }
  const { eq } = await import('drizzle-orm')
  await db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, id))
  assert.equal(await getConfigById(id), null)
  assert.equal((await getConfigById(id, { includeInactive: true }))?.id, id)
})

test('Agent prompt metadata round trips independent config and model selection', async () => {
  const { parsePromptFile, serializePromptFile } = await import('../src/agents/prompts.js')
  const raw = serializePromptFile({ name: '剧本改写', model: 'user-model-id', configId: 42, instructions: 'write a scene' })
  assert.deepEqual(parsePromptFile(raw), { name: '剧本改写', model: 'user-model-id', configId: 42, instructions: 'write a scene' })
})

test('editing Agent instructions preserves existing model and config when omitted', async () => {
  const promptPath = path.join(workspace, 'prompts', 'script_rewriter.md')
  writeFileSync(promptPath, '---\nname: 剧本改写\nmodel: "user-model-id"\nconfig_id: 42\n---\n\nOriginal instructions\n')
  const { default: app } = await import('../src/routes/prompts.js')
  const response = await app.request('/script_rewriter', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '剧本改写', system_prompt: 'Updated instructions' }),
  })
  assert.equal(response.status, 200)
  const { parsePromptFile } = await import('../src/agents/prompts.js')
  assert.deepEqual(parsePromptFile(readFileSync(promptPath, 'utf8')), {
    name: '剧本改写', model: 'user-model-id', configId: 42, instructions: 'Updated instructions',
  })
})

test('Agent prompt API accepts an explicit text config and custom model ID', async () => {
  const { db, schema, getInsertId } = await import('../src/db/index.js')
  const id = getInsertId(await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'deepseek', name: 'Agent DeepSeek', baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-only', model: JSON.stringify(['config-default']), priority: 1, isActive: true,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }))
  const { default: app } = await import('../src/routes/prompts.js')
  const response = await app.request('/script_rewriter', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system_prompt: 'Updated instructions', model: 'my-custom-model', config_id: id }),
  })
  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(json.data?.model, 'my-custom-model')
  assert.equal(json.data?.config_id, id)
  const getResponse = await app.request('/script_rewriter')
  const getJson = await getResponse.json()
  assert.equal(getJson.data?.model, 'my-custom-model')
  assert.equal(getJson.data?.config_id, id)
})

test('saving a translated Agent prompt also persists its model selection in the base metadata', async () => {
  const { default: app } = await import('../src/routes/prompts.js')
  const { parsePromptFile } = await import('../src/agents/prompts.js')
  const { db, schema, getInsertId } = await import('../src/db/index.js')
  const configId = getInsertId(await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'deepseek', name: 'Localized Agent', baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-only', model: JSON.stringify(['default']), priority: 1, isActive: true,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }))
  const basePath = path.join(workspace, 'prompts', 'script_rewriter.md')
  writeFileSync(basePath, '---\nname: 剧本改写\nmodel: "base-choice"\nconfig_id: ' + configId + '\n---\n\nBase instructions\n')
  const original = parsePromptFile(readFileSync(basePath, 'utf8'))
  const response = await app.request('/script_rewriter?lang=en', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system_prompt: 'English instructions', model: 'translated-choice', config_id: original.configId }),
  })
  assert.equal(response.status, 200)
  const base = parsePromptFile(readFileSync(basePath, 'utf8'))
  assert.equal(base.instructions, original.instructions)
  assert.equal(base.model, 'translated-choice')
  assert.equal(base.configId, original.configId)
  const localized = parsePromptFile(readFileSync(path.join(workspace, 'prompts', 'script_rewriter.en.md'), 'utf8'))
  assert.equal(localized.instructions, 'English instructions')
})

test('Agent resolves its own DeepSeek config and honors a request-level config override without a network call', async () => {
  const { db, schema, getInsertId } = await import('../src/db/index.js')
  const insertConfig = async (provider: string, model: string, baseUrl: string) => getInsertId(await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider, name: provider, baseUrl, apiKey: 'test-only', model: JSON.stringify([model]),
    priority: 1, isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }))
  const deepseekId = await insertConfig('deepseek', 'config-default', 'https://api.deepseek.com')
  const openaiId = await insertConfig('openai', 'request-default', 'https://api.openai.com')
  writeFileSync(path.join(workspace, 'prompts', 'script_rewriter.md'),
    '---\nname: 剧本改写\nmodel: "agent-custom-model"\nconfig_id: ' + deepseekId + '\n---\n\nAgent instructions\n')
  const { agentRegistry } = await import('../src/agents/index.js')
  const { buildAgentRequestContext } = await import('../src/agents/context.js')
  const agent = agentRegistry.script_rewriter
  const ownModel = await agent.getModel({ requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1 }) })
  assert.equal(ownModel.modelId, 'agent-custom-model')
  const requestedModel = await agent.getModel({ requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: openaiId }) })
  assert.equal(requestedModel.modelId, 'request-default')
})

test('declarative dispatch routes current Agents to their skills and rejects unknown types', async () => {
  const { getAgentDispatchRoute, resolveAgentTextSelection } = await import('../src/agents/dispatch.js')
  assert.deepEqual(getAgentDispatchRoute('storyboard_breaker')?.skillPrefixes, ['storyboard-breaker'])
  assert.equal(getAgentDispatchRoute('zenstory_future'), null)
  assert.equal(getAgentDispatchRoute('toString'), null)
  assert.deepEqual(resolveAgentTextSelection({ model: 'agent-model', configId: 4 }, { model: 'request-model' }), { configId: 4, model: 'request-model' })
  assert.deepEqual(resolveAgentTextSelection({ model: 'agent-model', configId: 4 }, { configId: 7 }), { configId: 7, model: undefined })
})
