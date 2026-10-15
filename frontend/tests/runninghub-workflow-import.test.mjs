import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inspectRunninghubWorkflow } from '../app/utils/runninghubWorkflowImport.mjs'

test('lists real node IDs and input names from an exported ComfyUI API-format workflow', () => {
  const nodes = inspectRunninghubWorkflow(JSON.stringify({
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'a scene', clip: ['4', 1] } },
    3: { class_type: 'KSampler', inputs: { seed: 123, steps: 20 } },
    9: { class_type: 'SaveImage', inputs: {} },
    extra: { inputs: { ignored: true } },
  }))

  assert.deepEqual(nodes, [
    { nodeId: '3', classType: 'KSampler', inputNames: ['seed', 'steps'] },
    { nodeId: '6', classType: 'CLIPTextEncode', inputNames: ['text', 'clip'] },
    { nodeId: '9', classType: 'SaveImage', inputNames: [] },
  ])
  assert.equal(JSON.stringify(nodes).includes('a scene'), false)
})

test('rejects non API-format JSON instead of inferring node mappings', () => {
  for (const source of ['not json', '{}', '{"nodes":[{"id":6,"inputs":{"text":"x"}}]}', '[]']) {
    assert.throws(() => inspectRunninghubWorkflow(source), /API 格式/)
  }
})

test('settings imports locally and requires an explicit task source for every added mapping', () => {
  const page = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
  assert.match(page, /type="file"[^>]*accept="\.json,application\/json"[^>]*@change="importRunninghubWorkflow"/)
  assert.match(page, /inspectRunninghubWorkflow\(await file\.text\(\)\)/)
  assert.match(page, /addImportedRunninghubMapping\(node\.nodeId, fieldName\)/)
  assert.match(page, /nodeId, fieldName, source: ''/)
  assert.match(page, /仅在本页读取/)
})
test('read-only inspection sends the current unsaved workflow config without logging its key', async () => {
  const { aiConfigAPI } = await import('../app/composables/useApi.ts')
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const logs = []
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200, json: async () => ({ data: { prompt: '{"6":{"inputs":{"text":"private"}}}' } }) }
  }
  console.log = (...items) => logs.push(items)
  try {
    const result = await aiConfigAPI.inspectRunninghubWorkflow({
      base_url: 'https://www.runninghub.cn',
      api_key: 'secret-only-in-memory',
      workflow_id: '2109907990638850050',
    })
    assert.equal(request.url, '/api/v1/ai-configs/runninghub/workflow-json')
    assert.equal(request.options.method, 'POST')
    assert.deepEqual(JSON.parse(request.options.body), {
      base_url: 'https://www.runninghub.cn',
      api_key: 'secret-only-in-memory',
      workflow_id: '2109907990638850050',
    })
    assert.equal(result.prompt.includes('private'), true)
    assert.equal(JSON.stringify(logs).includes('secret-only-in-memory'), false)
    assert.equal(JSON.stringify(logs).includes('private'), false)
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
  }
})