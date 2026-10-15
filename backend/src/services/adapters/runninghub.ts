/** RunningHub V2 media and published ComfyUI workflow transport. */
import type {
  AIConfig, ImageGenerationRecord, ImageGenResponse, ImagePollResponse,
  ImageProviderAdapter, ProviderRequest, VideoGenerationRecord, VideoGenResponse,
  VideoPollResponse, VideoProviderAdapter,
} from './types'
import fs from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { joinProviderUrl } from './url'

const DEFAULT_WORKFLOW_ID = '2109907990638850050'
const IMAGE_TYPES = new Set(['image', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif', 'heic'])
const VIDEO_TYPES = new Set(['video', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'])
const JSON_ARRAY_FIELDS = new Set([
  'referenceImages', 'referenceImageUrls', 'referenceVideoUrls', 'referenceAudioUrls',
])

type MediaKind = 'image' | 'video'
type MediaRecord = ImageGenerationRecord | VideoGenerationRecord
interface ValueMapping {
  fieldName: string
  source: string
  upload?: boolean
  constant?: unknown
  valueType?: 'raw' | 'string' | 'number' | 'boolean' | 'json'
  valueMap?: Record<string, unknown>
}
interface NodeMapping extends ValueMapping { nodeId: string }
interface ModelMapping extends ValueMapping {}
interface RunningHubSettings {
  mode?: 'workflow' | 'model'
  workflowId?: string
  nodeMappings?: NodeMapping[]
  modelEndpoint?: string
  modelMappings?: ModelMapping[]
  outputNodeId?: string
}

function settings(config: AIConfig): RunningHubSettings {
  const value = config.settings?.runninghub
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RunningHub settings.runninghub is required')
  }
  if (value.mode && value.mode !== 'workflow' && value.mode !== 'model') {
    throw new Error('RunningHub mode must be workflow or model')
  }
  return value as RunningHubSettings
}

function endpoint(config: AIConfig, path: string): string {
  if (!config.baseUrl?.trim()) throw new Error('RunningHub baseUrl is required')
  if (!config.apiKey?.trim()) throw new Error('RunningHub apiKey is required')
  let base: URL
  try { base = new URL(config.baseUrl.trim()) }
  catch { throw new Error('RunningHub baseUrl must be an HTTPS URL') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('RunningHub baseUrl must be an HTTPS URL without credentials, query or fragment')
  }
  const url = new URL(joinProviderUrl(base.toString(), '/openapi/v2', path))
  if (url.origin !== base.origin) throw new Error('RunningHub endpoint must stay within baseUrl origin')
  return url.toString()
}

function headers(config: AIConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }
}

function sourceValue(record: MediaRecord, source: string): unknown {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*|\[\d+\])*$/.test(source)) {
    throw new Error(`Invalid RunningHub mapping source: ${source}`)
  }
  const parts = source.replace(/\[(\d+)\]/g, '.$1').split('.')
  const root = parts.shift()!
  let value: any = (record as unknown as Record<string, unknown>)[root]
  if (root === 'size' && typeof value === 'string' && parts.length) {
    const match = /^(\d+)x(\d+)$/i.exec(value)
    if (match) value = { width: Number(match[1]), height: Number(match[2]) }
  } else if (JSON_ARRAY_FIELDS.has(root) && typeof value === 'string') {
    try { value = JSON.parse(value) } catch { value = undefined }
  }
  for (const part of parts) value = value?.[part]
  return value
}

function usable(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' &&
    (!Array.isArray(value) || value.length > 0)
}

function fileNameFor(value: string, mime: string): string {
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      const raw = url.searchParams.get('filename') || decodeURIComponent(url.pathname.split('/').pop() || '')
      const name = raw.split(/[\\/]/).pop() || ''
      if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name
    } catch { /* use MIME fallback */ }
  }
  const suffix = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3',
    'audio/wav': 'wav', 'application/zip': 'zip' } as Record<string, string>)[mime] || 'bin'
  return `upload.${suffix}`
}

async function mediaBlob(value: string): Promise<{ blob: Blob; filename: string }> {
  if (value.startsWith('data:')) {
    const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(value)
    if (!match) throw new Error('RunningHub upload requires a base64 data URI')
    const mime = match[1]
    const bytes = Buffer.from(match[2], 'base64')
    return { blob: new Blob([new Uint8Array(bytes)], { type: mime }), filename: fileNameFor('', mime) }
  }
  if (/^\/?static\//.test(value)) {
    const relativePath = value.replace(/^\/?static\//, '')
    const root = await fs.realpath(STORAGE_ROOT)
    const filePath = await fs.realpath(path.resolve(root, relativePath))
    const relative = path.relative(root, filePath)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('RunningHub local upload must stay within static storage')
    }
    const bytes = await fs.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mime = ({
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
      '.flac': 'audio/flac', '.zip': 'application/zip',
    } as Record<string, string>)[ext] || 'application/octet-stream'
    return { blob: new Blob([new Uint8Array(bytes)], { type: mime }), filename: path.basename(filePath) }
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new Error('RunningHub upload source must be a local static path, HTTP(S) URL or base64 data URI')
  }
  const response = await fetch(value, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`RunningHub media fetch failed: HTTP ${response.status}`)
  const blob = await response.blob()
  return { blob, filename: fileNameFor(value, blob.type || 'application/octet-stream') }
}

/** Upload is opt-in per mapping. Workflow nodes receive fileName; model APIs receive download_url. */
async function uploadValue(config: AIConfig, input: unknown, mode: 'workflow' | 'model'): Promise<unknown> {
  if (Array.isArray(input)) return Promise.all(input.map(item => uploadValue(config, item, mode)))
  if (typeof input !== 'string') throw new Error('RunningHub upload mapping source must be media text')
  const { blob, filename } = await mediaBlob(input)
  const form = new FormData()
  form.append('file', blob, filename)
  const response = await fetch(endpoint(config, '/media/upload/binary'), {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form, redirect: 'error', signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`RunningHub upload failed: HTTP ${response.status}`)
  const result = await response.json() as any
  if (result?.code !== undefined && ![0, '0', 200, '200'].includes(result.code)) {
    throw new Error(`RunningHub upload failed: ${result.message || result.msg || result.code}`)
  }
  const uploaded = mode === 'workflow' ? (result?.data?.fileName || result?.data?.filename) : result?.data?.download_url
  if (typeof uploaded !== 'string' || !uploaded) {
    throw new Error(`RunningHub upload response lacks ${mode === 'workflow' ? 'fileName' : 'download_url'}`)
  }
  return uploaded
}

function hasLocalStatic(value: unknown): boolean {
  return typeof value === 'string' ? /^\/?static\//.test(value)
    : Array.isArray(value) && value.some(hasLocalStatic)
}

function convertedValue(value: unknown, mapping: ValueMapping): unknown {
  let mapped = value
  if (mapping.valueMap !== undefined) {
    if (!mapping.valueMap || typeof mapping.valueMap !== 'object' || Array.isArray(mapping.valueMap)) {
      throw new Error('RunningHub valueMap must be a JSON object')
    }
    const key = String(value)
    if (!Object.prototype.hasOwnProperty.call(mapping.valueMap, key)) {
      throw new Error('RunningHub valueMap has no entry for mapping source')
    }
    mapped = mapping.valueMap[key]
  }
  switch (mapping.valueType || 'raw') {
    case 'raw': return mapped
    case 'string': return String(mapped)
    case 'number': {
      const number = Number(mapped)
      if (!Number.isFinite(number)) throw new Error('RunningHub mapping value is not a number')
      return number
    }
    case 'boolean':
      if (mapped === true || mapped === 1 || mapped === 'true' || mapped === '1') return true
      if (mapped === false || mapped === 0 || mapped === 'false' || mapped === '0') return false
      throw new Error('RunningHub mapping value is not a boolean')
    case 'json':
      if (typeof mapped !== 'string') return mapped
      try { return JSON.parse(mapped) }
      catch { throw new Error('RunningHub mapping value is not valid JSON') }
    default: throw new Error('RunningHub valueType is invalid')
  }
}

async function mappedValue(config: AIConfig, record: MediaRecord, mapping: ValueMapping,
  mode: 'workflow' | 'model', cache: Map<string, unknown>): Promise<unknown> {
  const value = mapping.source === '$constant' ? mapping.constant : sourceValue(record, mapping.source)
  if (!usable(value)) throw new Error(`RunningHub mapping source ${mapping.source} has no value`)
  if (!mapping.upload && hasLocalStatic(value)) {
    throw new Error('RunningHub local media mapping requires upload')
  }
  let resolved = value
  if (mapping.upload) {
    const cacheKey = `${mode}:${mapping.source}:${String(value)}`
    if (!cache.has(cacheKey)) cache.set(cacheKey, await uploadValue(config, value, mode))
    resolved = cache.get(cacheKey)
  }
  return convertedValue(resolved, mapping)
}

function setMappedField(body: Record<string, unknown>, fieldName: string, value: unknown): void {
  const parts = fieldName.split('.')
  if (!parts.every(part => /^[A-Za-z0-9_#-]+$/.test(part)
    && !['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error('RunningHub model fieldName is invalid')
  }
  let target = body
  for (const part of parts.slice(0, -1)) {
    if (target[part] === undefined) target[part] = {}
    const next = target[part]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('RunningHub model fieldName conflicts with another mapping')
    }
    target = next as Record<string, unknown>
  }
  const last = parts.at(-1)!
  if (Object.prototype.hasOwnProperty.call(target, last)) {
    throw new Error('RunningHub model fieldName is duplicated')
  }
  target[last] = value
}

async function generateRequest(config: AIConfig, record: MediaRecord): Promise<ProviderRequest> {
  const options = settings(config)
  const mode = options.mode || 'workflow'
  const cache = new Map<string, unknown>()
  if (mode === 'workflow') {
    const workflowId = options.workflowId || DEFAULT_WORKFLOW_ID
    if (!/^\d+$/.test(workflowId)) throw new Error('RunningHub workflowId must contain digits only')
    if (!Array.isArray(options.nodeMappings) || !options.nodeMappings.length) {
      throw new Error('RunningHub nodeMappings must contain at least one entry')
    }
    const nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }> = []
    for (const item of options.nodeMappings) {
      if (!item || !/^\d+$/.test(String(item.nodeId)) || !item.fieldName?.trim() || !item.source?.trim()) {
        throw new Error('RunningHub nodeMappings require nodeId, fieldName and source')
      }
      const fieldValue = await mappedValue(config, record, item, mode, cache)
      if (usable(fieldValue)) nodeInfoList.push({ nodeId: String(item.nodeId), fieldName: item.fieldName, fieldValue })
    }
    if (!nodeInfoList.length) throw new Error('RunningHub nodeMappings produced no values')
    return {
      url: endpoint(config, `/run/workflow/${workflowId}`), method: 'POST',
      headers: headers(config), body: { nodeInfoList },
    }
  }

  const modelEndpoint = options.modelEndpoint?.trim()
  if (!modelEndpoint || !/^\/openapi\/v2\/[A-Za-z0-9/_.-]+$/.test(modelEndpoint) || modelEndpoint.split('/').includes('..') || modelEndpoint.split('/').includes('.')) {
    throw new Error('RunningHub modelEndpoint must be an explicit /openapi/v2/... path')
  }
  if (!Array.isArray(options.modelMappings) || !options.modelMappings.length) {
    throw new Error('RunningHub modelMappings must contain at least one entry')
  }
  const body: Record<string, unknown> = {}
  for (const item of options.modelMappings) {
    if (!item || !item.fieldName?.trim() || !item.source?.trim()) {
      throw new Error('RunningHub modelMappings require fieldName and source')
    }
    const fieldValue = await mappedValue(config, record, item, mode, cache)
    if (usable(fieldValue)) setMappedField(body, item.fieldName, fieldValue)
  }
  if (!Object.keys(body).length) throw new Error('RunningHub modelMappings produced no values')
  return {
    url: endpoint(config, modelEndpoint.slice('/openapi/v2'.length)), method: 'POST',
    headers: headers(config), body,
  }
}

function taskError(result: any): string {
  const code = result?.errorCode
  const message = result?.errorMessage || result?.message || 'RunningHub task failed'
  return code !== undefined && code !== null && code !== '' && code !== '0' && code !== 0
    ? `[${code}] ${message}` : String(message)
}

function hasErrorCode(result: any): boolean {
  const code = result?.errorCode
  return code !== undefined && code !== null && code !== '' && code !== '0' && code !== 0
}

function outputType(item: any): string {
  const declared = String(item?.outputType || '').toLowerCase().replace(/^.*\//, '').replace(/^\./, '')
  if (declared) return declared
  try { return new URL(String(item?.url)).pathname.split('.').pop()?.toLowerCase() || '' }
  catch { return '' }
}

function safeResultUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch { return false }
}

function resultUrl(result: any, kind: MediaKind, config?: AIConfig): string | null {
  const entries = Array.isArray(result?.results) ? result.results : []
  const outputNodeId = config?.settings?.runninghub?.mode === 'model'
    ? undefined : config?.settings?.runninghub?.outputNodeId
  const hasNodeIds = entries.some((item: any) =>
    item?.nodeId !== undefined && item?.nodeId !== null && item?.nodeId !== '')
  const candidates = outputNodeId && hasNodeIds
    ? entries.filter((item: any) => String(item?.nodeId) === String(outputNodeId)) : entries
  const allowed = kind === 'image' ? IMAGE_TYPES : VIDEO_TYPES
  const chosen = candidates.find((item: any) =>
    safeResultUrl(item?.url) && allowed.has(outputType(item)))
  return chosen?.url || null
}

function createdTask(result: any, kind: MediaKind): ImageGenResponse | VideoGenResponse {
  const status = String(result?.status || '').toUpperCase()
  if (status === 'FAILED' || status === 'CANCELED' || hasErrorCode(result)) throw new Error(taskError(result))
  if (result?.taskId) return { isAsync: true, taskId: String(result.taskId) }
  const url = resultUrl(result, kind)
  if (status === 'SUCCESS' && url) {
    return kind === 'image' ? { isAsync: false, imageUrl: url } : { isAsync: false, videoUrl: url }
  }
  throw new Error('RunningHub V2 response lacks taskId or matching result')
}

function pollResult(result: any, kind: MediaKind, config?: AIConfig): ImagePollResponse | VideoPollResponse {
  const status = String(result?.status || '').toUpperCase()
  if (status === 'FAILED' || status === 'CANCELED' || hasErrorCode(result)) {
    return { status: 'failed', error: taskError(result) }
  }
  if (status === 'QUEUED' || status === 'PENDING') return { status: 'pending' }
  if (status === 'RUNNING' || status === 'PROCESSING') return { status: 'processing' }
  if (status === 'SUCCESS') {
    const url = resultUrl(result, kind, config)
    if (!url) return { status: 'failed', error: `RunningHub success response lacks ${kind} result` }
    return kind === 'image'
      ? { status: 'completed', imageUrl: url }
      : { status: 'completed', videoUrl: url }
  }
  return { status: 'failed', error: `Unknown RunningHub task status: ${status || '(empty)'}` }
}

function pollRequest(config: AIConfig, taskId: string): ProviderRequest {
  if (!taskId) throw new Error('RunningHub taskId is required')
  return {
    url: endpoint(config, '/query'), method: 'POST', headers: headers(config), body: { taskId },
  }
}

export class RunningHubImageAdapter implements ImageProviderAdapter {
  provider = 'runninghub'
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord) { return generateRequest(config, record) }
  parseGenerateResponse(result: any): ImageGenResponse { return createdTask(result, 'image') as ImageGenResponse }
  buildPollRequest(config: AIConfig, taskId: string) { return pollRequest(config, taskId) }
  parsePollResponse(result: any, config?: AIConfig): ImagePollResponse {
    return pollResult(result, 'image', config) as ImagePollResponse
  }
  extractImageUrl(result: any): string | null { return resultUrl(result, 'image') }
  extractImageBase64(): null { return null }
}

export class RunningHubVideoAdapter implements VideoProviderAdapter {
  provider = 'runninghub'
  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord) { return generateRequest(config, record) }
  parseGenerateResponse(result: any): VideoGenResponse { return createdTask(result, 'video') as VideoGenResponse }
  buildPollRequest(config: AIConfig, taskId: string) { return pollRequest(config, taskId) }
  parsePollResponse(result: any, config?: AIConfig): VideoPollResponse {
    return pollResult(result, 'video', config) as VideoPollResponse
  }
  extractVideoUrl(result: any): string | null { return resultUrl(result, 'video') }
}
