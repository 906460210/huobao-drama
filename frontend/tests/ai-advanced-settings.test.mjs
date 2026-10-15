import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const page = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')

test('DeepSeek and RunningHub appear as configurable providers', () => {
  assert.match(page, /deepseek:\s*\{[^}]*https:\/\/api\.deepseek\.com/s)
  assert.match(page, /image:\s*\{[\s\S]*runninghub:\s*\{/)
  assert.match(page, /video:\s*\{[\s\S]*runninghub:\s*\{/)
  assert.match(page, /2109907990638850050/)
  assert.match(page, /modelEndpoint/)
})

test('RunningHub mappings expose source and upload controls', () => {
  assert.match(page, /referenceImages\[0\]/)
  assert.match(page, /referenceImageUrls\[0\]/)
  assert.match(page, /v-model="mapping\.source"/)
  assert.match(page, /v-model="mapping\.upload"/)
  assert.match(page, /nodeMappings/)
  assert.match(page, /modelMappings/)
})

test('Agent prompt update includes independently selected text config and model', () => {
  assert.match(page, /agentForm\.config_id/)
  assert.match(page, /agentForm\.model/)
  assert.match(page, /config_id:\s*agentForm\.config_id/)
  assert.match(page, /model:\s*agentForm\.model/)
})

test('RunningHub offers configuration guidance without a billable test button', () => {
  assert.match(page, /cfgForm\.provider !== 'runninghub'/)
  assert.match(page, /Enterprise Shared Key/)
})
