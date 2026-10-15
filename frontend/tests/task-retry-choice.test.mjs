import { test } from 'node:test'
import assert from 'node:assert/strict'
import { videoRetryAction } from '../app/utils/task-recovery.js'

test('failed RunningHub tasks with an existing remote ID resume instead of creating another task', () => {
  assert.equal(videoRetryAction({ provider: 'runninghub', status: 'failed', task_id: 'remote-1' }), 'resume')
  assert.equal(videoRetryAction({ provider: 'runninghub', status: 'failed', result_url: 'https://example.com/result.mp4' }), 'resume')
})

test('ambiguous RunningHub submissions require review before a new paid request', () => {
  assert.equal(videoRetryAction({ provider: 'runninghub', status: 'failed' }), 'review')
  assert.equal(videoRetryAction({ provider: 'minimax', status: 'failed' }), 'generate')
})
