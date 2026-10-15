import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { STORAGE_ROOT } from '../src/utils/paths'
import { getImageAdapter, getVideoAdapter } from '../src/services/adapters/registry'
import type { AIConfig } from '../src/services/adapters/types'

const workflowConfig: AIConfig = {
  provider: 'runninghub', baseUrl: 'https://www.runninghub.cn', apiKey: 'test-key', model: '',
  settings: { runninghub: { mode: 'workflow', nodeMappings: [
    { nodeId: '6', fieldName: 'text', source: 'prompt' },
    { nodeId: '14', fieldName: 'image', source: 'referenceImages[0]' },
  ] } },
}

test('workflow V2 uses configured nodes and default workflow ID', async () => {
  const request = await getImageAdapter('runninghub').buildGenerateRequest(workflowConfig, {
    id: 1, prompt: '画一座山', referenceImages: JSON.stringify(['api/reference.png']),
  })
  assert.equal(request.url, 'https://www.runninghub.cn/openapi/v2/run/workflow/2109907990638850050')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(request.body, { nodeInfoList: [
    { nodeId: '6', fieldName: 'text', fieldValue: '画一座山' },
    { nodeId: '14', fieldName: 'image', fieldValue: 'api/reference.png' },
  ] })
})

test('video workflow keeps custom ID and numeric node values', async () => {
  const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
    mode: 'workflow', workflowId: '1234567890123456789', nodeMappings: [
      { nodeId: '7', fieldName: 'text', source: 'prompt' },
      { nodeId: '8', fieldName: 'seed', source: 'seed' },
      { nodeId: '9', fieldName: 'image', source: 'firstFrameUrl' },
    ],
  } } }
  const request = await getVideoAdapter('runninghub').buildGenerateRequest(config, {
    id: 2, prompt: '镜头推进', seed: 42, firstFrameUrl: 'api/frame.png',
  })
  assert.equal(request.url, 'https://www.runninghub.cn/openapi/v2/run/workflow/1234567890123456789')
  assert.deepEqual(request.body.nodeInfoList, [
    { nodeId: '7', fieldName: 'text', fieldValue: '镜头推进' },
    { nodeId: '8', fieldName: 'seed', fieldValue: 42 },
    { nodeId: '9', fieldName: 'image', fieldValue: 'api/frame.png' },
  ])
})

test('model V2 requires an explicit endpoint and maps fields without a guessed SKU', async () => {
  const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
    mode: 'model', modelEndpoint: '/openapi/v2/example/official-image-sku', modelMappings: [
      { fieldName: 'prompt', source: 'prompt' },
      { fieldName: 'imageUrls', source: 'referenceImages' },
    ],
  } } }
  const request = await getImageAdapter('runninghub').buildGenerateRequest(config, {
    id: 3, prompt: '山', referenceImages: JSON.stringify(['https://example.com/ref.png']),
  })
  assert.equal(request.url, 'https://www.runninghub.cn/openapi/v2/example/official-image-sku')
  assert.deepEqual(request.body, { prompt: '山', imageUrls: ['https://example.com/ref.png'] })
  await assert.rejects(async () => getImageAdapter('runninghub').buildGenerateRequest({
    ...config, settings: { runninghub: { mode: 'model', modelMappings: [{ fieldName: 'prompt', source: 'prompt' }] } },
  }, { id: 4, prompt: '山' }), /modelEndpoint/)
})

test('empty workflow mapping is rejected before a paid request', async () => {
  await assert.rejects(async () => getImageAdapter('runninghub').buildGenerateRequest({
    ...workflowConfig, settings: { runninghub: { mode: 'workflow', nodeMappings: [] } },
  }, { id: 5, prompt: '山' }), /nodeMappings/)
})

test('V2 query uses bearer POST and taskId JSON', () => {
  const request = getVideoAdapter('runninghub').buildPollRequest(workflowConfig, 'task-123')
  assert.equal(request.url, 'https://www.runninghub.cn/openapi/v2/query')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(request.body, { taskId: 'task-123' })
})

test('V2 response selects image/video outputs by media type and configured node', () => {
  const result = { status: 'SUCCESS', results: [
    { nodeId: '10', outputType: 'png', url: 'https://example.com/preview.png' },
    { nodeId: '11', outputType: 'mp4', url: 'https://example.com/video.mp4' },
    { nodeId: '12', outputType: 'mp4', url: 'https://example.com/other.mp4' },
  ] }
  assert.deepEqual(getImageAdapter('runninghub').parsePollResponse(result), {
    status: 'completed', imageUrl: 'https://example.com/preview.png',
  })
  assert.deepEqual(getVideoAdapter('runninghub').parsePollResponse(result, {
    ...workflowConfig, settings: { runninghub: { outputNodeId: '12' } },
  }), { status: 'completed', videoUrl: 'https://example.com/other.mp4' })
  assert.deepEqual(getVideoAdapter('runninghub').parsePollResponse({ status: 'QUEUED' }), { status: 'pending' })
  assert.deepEqual(getVideoAdapter('runninghub').parsePollResponse({
    status: 'FAILED', errorCode: '803', errorMessage: 'bad node',
  }), { status: 'failed', error: '[803] bad node' })
})

test('explicit upload maps the returned fileName into workflow nodes', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    return new Response(JSON.stringify({ code: 0, data: {
      fileName: 'openapi/uploaded.png', download_url: 'https://example.com/uploaded.png',
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const config: AIConfig = { ...workflowConfig, settings: { runninghub: { mode: 'workflow', nodeMappings: [
      { nodeId: '14', fieldName: 'image', source: 'referenceImages[0]', upload: true },
    ] } } }
    const request = await getImageAdapter('runninghub').buildGenerateRequest(config, {
      id: 6, referenceImages: JSON.stringify(['data:image/png;base64,aGVsbG8=']),
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'https://www.runninghub.cn/openapi/v2/media/upload/binary')
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer test-key')
    assert.ok(calls[0]?.init.body instanceof FormData)
    assert.deepEqual(request.body.nodeInfoList, [
      { nodeId: '14', fieldName: 'image', fieldValue: 'openapi/uploaded.png' },
    ])
  } finally { globalThis.fetch = originalFetch }
})

test('model endpoint accepts official version dots but rejects an external URL', async () => {
  const adapter = getVideoAdapter('runninghub')
  const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
    mode: 'model', modelEndpoint: '/openapi/v2/example/wan-2.7/image-to-video',
    modelMappings: [{ fieldName: 'prompt', source: 'prompt' }],
  } } }
  const request = await adapter.buildGenerateRequest(config, { id: 7, prompt: 'walk' })
  assert.equal(request.url, 'https://www.runninghub.cn/openapi/v2/example/wan-2.7/image-to-video')
  await assert.rejects(async () => adapter.buildGenerateRequest({ ...config, settings: { runninghub: {
    mode: 'model', modelEndpoint: 'https://attacker.example/collect',
    modelMappings: [{ fieldName: 'prompt', source: 'prompt' }],
  } } }, { id: 8, prompt: 'walk' }), /modelEndpoint/)
})

test('RunningHub rejects unsafe base URLs before attaching the bearer key', () => {
  const adapter = getImageAdapter('runninghub')
  assert.throws(() => adapter.buildPollRequest({ ...workflowConfig,
    baseUrl: 'https://runninghub.cn@attacker.example',
  }, 'task-1'), /baseUrl/)
  assert.throws(() => adapter.buildPollRequest({ ...workflowConfig,
    baseUrl: 'http://www.runninghub.cn',
  }, 'task-1'), /baseUrl/)
  assert.throws(() => adapter.buildPollRequest({ ...workflowConfig,
    baseUrl: 'https://www.runninghub.cn?redirect=https://attacker.example',
  }, 'task-1'), /baseUrl/)
})

test('model upload uses download_url and never sends bearer auth when reading source URL', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    if (calls.length === 1) return new Response('image', { status: 200, headers: { 'Content-Type': 'image/png' } })
    return new Response(JSON.stringify({ code: '0', data: {
      fileName: 'openapi/uploaded.png', download_url: 'https://example.com/uploaded.png',
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
      mode: 'model', modelEndpoint: '/openapi/v2/example/image-sku',
      modelMappings: [{ fieldName: 'imageUrl', source: 'imageUrl', upload: true }],
    } } }
    const request = await getVideoAdapter('runninghub').buildGenerateRequest(config, {
      id: 9, imageUrl: 'https://example.com/original.png',
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.url, 'https://example.com/original.png')
    assert.equal(calls[0]?.init.headers, undefined)
    assert.equal(calls[1]?.url, 'https://www.runninghub.cn/openapi/v2/media/upload/binary')
    assert.deepEqual(request.body, { imageUrl: 'https://example.com/uploaded.png' })
  } finally { globalThis.fetch = originalFetch }
})

test('configured mapping rejects an unavailable source before running a paid task', async () => {
  await assert.rejects(async () => getImageAdapter('runninghub').buildGenerateRequest({
    ...workflowConfig, settings: { runninghub: { mode: 'workflow', nodeMappings: [
      { nodeId: '6', fieldName: 'text', source: 'prompt' },
      { nodeId: '14', fieldName: 'image', source: 'referenceImages[0]' },
    ] } },
  }, { id: 10, prompt: '山' }), /referenceImages\[0\]/)
})

test('configured output node accepts the documented V2 results without nodeId', () => {
  const result = { status: 'SUCCESS', results: [
    { outputType: 'png', url: 'https://example.com/final.png' },
  ] }
  assert.deepEqual(getImageAdapter('runninghub').parsePollResponse(result, {
    ...workflowConfig, settings: { runninghub: { outputNodeId: '12' } },
  }), { status: 'completed', imageUrl: 'https://example.com/final.png' })
})

test('configured output node does not silently save another node result', () => {
  const result = { status: 'SUCCESS', results: [
    { nodeId: '11', outputType: 'mp4', url: 'https://example.com/other.mp4' },
  ] }
  assert.deepEqual(getVideoAdapter('runninghub').parsePollResponse(result, {
    ...workflowConfig, settings: { runninghub: { outputNodeId: '12' } },
  }), { status: 'failed', error: 'RunningHub success response lacks video result' })
})

test('media upload keeps the extension from a signed view URL', async () => {
  const originalFetch = globalThis.fetch
  let uploadedName = ''
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return new Response('image', { status: 200, headers: { 'Content-Type': 'image/png' } })
    uploadedName = ((init.body as FormData).get('file') as File).name
    return new Response(JSON.stringify({ code: 0, data: { fileName: 'openapi/image.png' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
      mode: 'workflow', nodeMappings: [
        { nodeId: '14', fieldName: 'image', source: 'referenceImages[0]', upload: true },
      ],
    } } }
    await getImageAdapter('runninghub').buildGenerateRequest(config, {
      id: 11, referenceImages: JSON.stringify(['https://example.com/view?filename=input.png']),
    })
    assert.equal(uploadedName, 'input.png')
  } finally { globalThis.fetch = originalFetch }
})

test('V2 upload accepts the documented English code 200 and lowercase filename', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 200, message: 'success', data: {
    filename: 'openapi/english.png', download_url: 'https://example.com/english.png',
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    const source = 'data:image/png;base64,aGVsbG8='
    const workflow: AIConfig = { ...workflowConfig, settings: { runninghub: {
      mode: 'workflow', nodeMappings: [
        { nodeId: '14', fieldName: 'image', source: 'referenceImages[0]', upload: true },
      ],
    } } }
    const workflowRequest = await getImageAdapter('runninghub').buildGenerateRequest(workflow, {
      id: 12, referenceImages: JSON.stringify([source]),
    })
    assert.deepEqual(workflowRequest.body.nodeInfoList, [
      { nodeId: '14', fieldName: 'image', fieldValue: 'openapi/english.png' },
    ])
    const model: AIConfig = { ...workflowConfig, settings: { runninghub: {
      mode: 'model', modelEndpoint: '/openapi/v2/example/image', modelMappings: [
        { fieldName: 'imageUrl', source: 'imageUrl', upload: true },
      ],
    } } }
    const modelRequest = await getVideoAdapter('runninghub').buildGenerateRequest(model, {
      id: 13, imageUrl: source,
    })
    assert.deepEqual(modelRequest.body, { imageUrl: 'https://example.com/english.png' })
  } finally { globalThis.fetch = originalFetch }
})

test('RunningHub ignores unsafe result URLs even if their output type matches', () => {
  const adapter = getVideoAdapter('runninghub')
  for (const url of [
    'file:///etc/private.mp4',
    'http://127.0.0.1/private.mp4',
    'https://user:pass@example.com/private.mp4',
  ]) {
    const result = { status: 'SUCCESS', results: [{ outputType: 'mp4', url }] }
    assert.deepEqual(adapter.parsePollResponse(result), {
      status: 'failed', error: 'RunningHub success response lacks video result',
    })
    assert.equal(adapter.extractVideoUrl(result), null)
  }
})

test('model mappings build nested fields required by model-specific V2 APIs', async () => {
  const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
    mode: 'model', modelEndpoint: '/openapi/v2/example/model', modelMappings: [
      { fieldName: 'input.prompt', source: 'prompt' },
      { fieldName: 'parameters.duration', source: 'duration' },
    ],
  } } }
  const request = await getVideoAdapter('runninghub').buildGenerateRequest(config, {
    id: 14, prompt: 'walk', duration: 5,
  })
  assert.deepEqual(request.body, { input: { prompt: 'walk' }, parameters: { duration: 5 } })
})

test('model mappings reject prototype properties', async () => {
  const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
    mode: 'model', modelEndpoint: '/openapi/v2/example/model', modelMappings: [
      { fieldName: '__proto__.polluted', source: 'prompt' },
    ],
  } } }
  await assert.rejects(async () => getImageAdapter('runninghub').buildGenerateRequest(config, {
    id: 15, prompt: 'safe',
  }), /fieldName/)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('generic media outputType is accepted for matching result URLs', () => {
  const image = getImageAdapter('runninghub').parsePollResponse({ status: 'SUCCESS', results: [
    { outputType: 'image', url: 'https://example.com/signed-image' },
  ] })
  const video = getVideoAdapter('runninghub').parsePollResponse({ status: 'SUCCESS', results: [
    { outputType: 'video', url: 'https://example.com/signed-video' },
  ] })
  assert.deepEqual(image, { status: 'completed', imageUrl: 'https://example.com/signed-image' })
  assert.deepEqual(video, { status: 'completed', videoUrl: 'https://example.com/signed-video' })
})

test('model mappings accept documented hash field names and configured value conversions', async () => {
  const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
    mode: 'model', modelEndpoint: '/openapi/v2/example/model', modelMappings: [
      { fieldName: '272##image', source: 'imageUrl' },
      { fieldName: '79##text', source: 'prompt' },
      { fieldName: 'duration', source: 'duration', valueType: 'string' },
      { fieldName: 'resolution', source: 'resolution', valueMap: { '1080p': '1080P' } },
      { fieldName: 'seed', source: '$constant', constant: '42', valueType: 'number' },
    ],
  } } }
  const request = await getVideoAdapter('runninghub').buildGenerateRequest(config, {
    id: 18, imageUrl: 'https://example.com/source.png', prompt: 'portrait',
    duration: 5, resolution: '1080p',
  })
  assert.deepEqual(request.body, {
    '272##image': 'https://example.com/source.png', '79##text': 'portrait',
    duration: '5', resolution: '1080P', seed: 42,
  })
})

test('local reference video is uploaded by explicit mapping without a public base URL', async () => {
  const filename = `test-${randomUUID()}.mp4`
  await fs.mkdir(STORAGE_ROOT, { recursive: true })
  await fs.writeFile(path.join(STORAGE_ROOT, filename), Buffer.from('video'))
  const originalFetch = globalThis.fetch
  let uploadedFilename: string | undefined
  globalThis.fetch = async (_url, init) => {
    uploadedFilename = ((init?.body as FormData).get('file') as File).name
    return new Response(JSON.stringify({ code: 0, data: { fileName: 'openapi/video.mp4' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
      mode: 'workflow', nodeMappings: [
        { nodeId: '7', fieldName: 'video', source: 'referenceVideoUrls[0]', upload: true },
      ],
    } } }
    const request = await getVideoAdapter('runninghub').buildGenerateRequest(config, {
      id: 19, referenceVideoUrls: JSON.stringify([`static/${filename}`]),
    })
    assert.equal(uploadedFilename, filename)
    assert.deepEqual(request.body.nodeInfoList, [
      { nodeId: '7', fieldName: 'video', fieldValue: 'openapi/video.mp4' },
    ])
  } finally {
    globalThis.fetch = originalFetch
    await fs.unlink(path.join(STORAGE_ROOT, filename))
  }
})

test('local media without upload mapping fails before creating a paid task', async () => {
  const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
    mode: 'workflow', nodeMappings: [
      { nodeId: '7', fieldName: 'video', source: 'referenceVideoUrls[0]' },
    ],
  } } }
  await assert.rejects(async () => getVideoAdapter('runninghub').buildGenerateRequest(config, {
    id: 20, referenceVideoUrls: JSON.stringify(['static/videos/reference.mp4']),
  }), /requires upload/)
})

test('model API results ignore a workflow-only output node setting', () => {
  const config: AIConfig = { ...workflowConfig, settings: { runninghub: {
    mode: 'model', outputNodeId: '99',
  } } }
  const result = getImageAdapter('runninghub').parsePollResponse({
    status: 'SUCCESS', results: [{ nodeId: '2', outputType: 'png', url: 'https://example.com/result.png' }],
  }, config)
  assert.deepEqual(result, { status: 'completed', imageUrl: 'https://example.com/result.png' })
})
