import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectModelOptions, bareModelName, ownerConfigId } from '../app/utils/model-options.js'

test('a RunningHub config without a model ID is selectable by config and visible as the default', () => {
  const options = collectModelOptions([
    { id: 7, provider: 'openai', name: 'Image API', model: ['gpt-image-2'], priority: 1, is_active: true },
    { id: 12, provider: 'runninghub', name: 'ComfyUI 工作流', model: [], priority: 20, is_active: true },
  ])
  assert.equal(options[0].model, 'ComfyUI 工作流')
  assert.equal(ownerConfigId(options, options[0].key), 12)
  assert.equal(bareModelName(options[0].key), '')
  assert.equal(options[1].model, 'gpt-image-2')
})

test('multiple RunningHub configs keep distinct choices without inventing model IDs', () => {
  const options = collectModelOptions([
    { id: 12, provider: 'runninghub', name: 'Workflow A', model: [], priority: 2, is_active: true },
    { id: 13, provider: 'runninghub', name: 'Workflow B', model: '[]', priority: 1, is_active: true },
  ])
  assert.deepEqual(options.map(option => option.configId), [12, 13])
  assert.notEqual(options[0].key, options[1].key)
  assert.equal(bareModelName(options[1].key), '')
})
