import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'

const isolatedData = mkdtempSync(join(tmpdir(), 'huobao-task-recovery-'))
process.env.SQLITE_PATH = join(isolatedData, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = isolatedData
const { db, getInsertId, schema } = await import('../src/db/index.ts')
const { resumeTask } = await import('../src/services/generation.ts')

async function addTask(fields) {
  const timestamp = new Date().toISOString()
  const result = await db.insert(schema.sysTask).values({
    type: 'image', provider: 'runninghub', prompt: 'test', model: '',
    params: '{}', status: 'failed', createdAt: timestamp, updatedAt: timestamp,
    ...fields,
  })
  return getInsertId(result)
}

async function waitForStatus(id, wanted) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (row?.status === wanted) return row
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Task ${id} did not reach ${wanted}`)
}

test('resume downloads a saved remote result without creating another generation', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const resultUrl = 'https://example.test/result.png'
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url) !== resultUrl) throw new Error(`Unexpected generation request: ${url}`)
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>')
  }
  try {
    const id = await addTask({ taskId: 'remote-1', resultUrl })
    assert.equal(await resumeTask(id), 'resumed')
    const row = await waitForStatus(id, 'completed')
    assert.equal(row.resultUrl, resultUrl)
    assert.deepEqual(calls, [resultUrl])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('startup marks an ambiguous submission failed without sending it again', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('No network request expected') }
  try {
    const id = await addTask({ status: 'processing', taskId: null, resultUrl: null })
    assert.equal(await resumeTask(id, { fromStartup: true }), 'not-recoverable')
    const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    assert.equal(row.status, 'failed')
    assert.match(row.errorMsg, /不会自动重新提交/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('resume endpoint refuses a task without a remote ID or saved result', async () => {
  const { default: tasksApp } = await import('../src/routes/tasks.ts')
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('No network request expected') }
  try {
    const id = await addTask({ taskId: null, resultUrl: null })
    const response = await tasksApp.request(`/${id}/resume`, { method: 'POST' })
    assert.equal(response.status, 400)
    const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    assert.equal(row.status, 'failed')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('concurrent resume calls claim one existing task and download once', async () => {
  const originalFetch = globalThis.fetch
  const resultUrl = 'https://example.test/concurrent.png'
  let release
  const gate = new Promise(resolve => { release = resolve })
  let downloads = 0
  globalThis.fetch = async (url) => {
    assert.equal(String(url), resultUrl)
    downloads++
    await gate
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
  }
  try {
    const id = await addTask({ taskId: 'remote-concurrent', resultUrl })
    const states = await Promise.all([resumeTask(id), resumeTask(id)])
    assert.deepEqual(states.sort(), ['already-running', 'resumed'])
    release()
    await waitForStatus(id, 'completed')
    assert.equal(downloads, 1)
  } finally {
    release()
    globalThis.fetch = originalFetch
  }
})
