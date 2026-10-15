import assert from 'node:assert/strict'
import test from 'node:test'
import { planTaskRecovery, pollFetchOptions } from '../src/services/task-recovery.ts'

test('a saved result is downloaded without submitting another generation', () => {
  assert.equal(planTaskRecovery({ status: 'failed', taskId: 'remote-1', resultUrl: 'https://example.com/result.png', params: '{}' }), 'download')
})

test('a saved remote task is queried, never submitted again', () => {
  assert.equal(planTaskRecovery({ status: 'processing', taskId: 'remote-1', resultUrl: null, params: '{"configId":7}' }), 'poll')
})

test('an ambiguous submission without remote ID is not repeated', () => {
  assert.equal(planTaskRecovery({ status: 'processing', taskId: null, resultUrl: null, params: '{"configId":7}' }), 'fail')
})

test('a completed task is left alone', () => {
  assert.equal(planTaskRecovery({ status: 'completed', taskId: 'remote-1', resultUrl: 'https://example.com/result.png', params: '{}' }), 'skip')
})

test('poll requests preserve the JSON body required by RunningHub V2', () => {
  const init = pollFetchOptions({
    url: 'https://www.runninghub.cn/openapi/v2/query',
    method: 'POST',
    headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: { taskId: 'remote-1' },
  }, 1000)
  assert.equal(init.method, 'POST')
  assert.deepEqual(JSON.parse(init.body), { taskId: 'remote-1' })
})

test('credentialed RunningHub polling rejects cross-origin redirects', () => {
  const init = pollFetchOptions({ method: 'POST', headers: { Authorization: 'Bearer secret' }, body: { taskId: 'remote-1' } }, 1000, true)
  assert.equal(init.redirect, 'error')
})
