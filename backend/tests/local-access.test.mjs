import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

test('backend accepts local traffic but does not expose API on other loopback addresses by default', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-local-access-'))
  const port = await freePort()
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HUOBAO_BIND_HOST: '',
      HUOBAO_DATA_DIR: tempRoot,
      SQLITE_PATH: path.join(tempRoot, 'smoke.sqlite3'),
      MYSQL_AUTO_IMPORT: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout.on('data', chunk => { output += chunk.toString() })
  server.stderr.on('data', chunk => { output += chunk.toString() })
  try {
    const deadline = Date.now() + 15_000
    let ready = false
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error('backend exited: ' + output)
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/v1/health', {
          signal: AbortSignal.timeout(1000),
        })
        if (response.ok) { ready = true; break }
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    assert.equal(ready, true, 'backend did not start: ' + output)
    await assert.rejects(fetch('http://127.0.0.2:' + port + '/api/v1/health', {
      signal: AbortSignal.timeout(2000),
    }), /fetch failed|aborted|timeout/i)
  } finally {
    server.kill()
    if (server.exitCode === null) await Promise.race([
      once(server, 'exit'),
      new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref() }),
    ])
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
