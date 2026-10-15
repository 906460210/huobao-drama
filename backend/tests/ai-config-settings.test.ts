import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'huobao-ai-config-'))
process.env.SQLITE_PATH = join(dir, 'test.sqlite3')

const { default: app } = await import('../src/routes/aiConfigs.ts')

test('RunningHub workflow settings round trip and survive a temperature update', async () => {
  const runninghub = {
    mode: 'workflow',
    workflowId: '2109907990638850050',
    nodeMappings: [{ nodeId: '42', fieldName: 'image', source: 'firstFrameUrl', upload: true }],
    outputNodeId: '99',
  }
  const create = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'image', provider: 'runninghub', name: 'RH image',
      base_url: 'https://www.runninghub.cn', api_key: 'test-only-key', model: [],
      settings: { runninghub },
    }),
  })
  assert.equal(create.status, 201)
  const created = (await create.json()).data
  assert.deepEqual(created.settings.runninghub, runninghub)

  const update = await app.request(`/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ temperature: 0.7 }),
  })
  assert.equal(update.status, 200)
  const read = await app.request(`/${created.id}`)
  const saved = (await read.json()).data
  assert.deepEqual(saved.settings.runninghub, runninghub)
  assert.equal(saved.temperature, 0.7)
  assert.equal(saved.settings.temperature, 0.7)
})

test('RunningHub model mapping settings round trip without replacing unrelated settings', async () => {
  const create = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'video', provider: 'runninghub', name: 'RH video',
      base_url: 'https://www.runninghub.cn', api_key: 'test-only-key', model: [],
      settings: { other: 'keep-me', runninghub: { mode: 'workflow', workflowId: '2109907990638850050' } },
    }),
  })
  assert.equal(create.status, 201)
  const id = (await create.json()).data.id
  const modelConfig = {
    mode: 'model',
    modelEndpoint: '/openapi/v2/model/example',
    modelMappings: [{ fieldName: 'imageUrl', source: 'firstFrameUrl', upload: true }],
  }
  const update = await app.request(`/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { runninghub: modelConfig } }),
  })
  assert.equal(update.status, 200)
  const read = await app.request(`/${id}`)
  const saved = (await read.json()).data
  assert.equal(saved.settings.other, 'keep-me')
  assert.deepEqual(saved.settings.runninghub, modelConfig)
})

test('invalid RunningHub mode is rejected before writing', async () => {
  const response = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'image', provider: 'runninghub',
      settings: { runninghub: { mode: 'unsupported' } },
    }),
  })
  assert.equal(response.status, 400)
})

test('DeepSeek saves a custom model ID, key, and Base URL', async () => {
  const response = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'text', provider: 'deepseek', name: 'DeepSeek custom',
      base_url: 'https://example.invalid/deepseek/v1',
      api_key: 'placeholder-not-a-real-key', model: ['custom-deepseek-model'],
    }),
  })
  assert.equal(response.status, 201)
  const config = (await response.json()).data
  assert.equal(config.provider, 'deepseek')
  assert.equal(config.base_url, 'https://example.invalid/deepseek/v1')
  assert.equal(config.api_key, 'placeholder-not-a-real-key')
  assert.deepEqual(config.model, ['custom-deepseek-model'])
})

test('DeepSeek connection probe is a read-only models request', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string, options: RequestInit }> = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options || {} })
    return new Response('{"data":[]}', { status: 200 })
  }
  try {
    const response = await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service_type: 'text', provider: 'deepseek',
        base_url: 'https://example.invalid/deepseek/v1',
        api_key: 'placeholder-not-a-real-key',
        model: ['custom-deepseek-model'],
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.method, 'GET')
    assert.equal(calls[0].url, 'https://example.invalid/deepseek/v1/models')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('RunningHub connection probe never creates a task', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('must not call') }
  try {
    const response = await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service_type: 'image', provider: 'runninghub',
        base_url: 'https://www.runninghub.cn',
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(called, false)
    const data = (await response.json()).data
    assert.equal(data.reachable, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
