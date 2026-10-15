/**
 * Agent prompt 管理路由 — 读写 workspace/prompts/<agent_type>[.<lang>].md
 * 文件操作 jail 在 backend/workspace/ 目录内（仿 skills 路由）
 * ?lang=en/ja/ko 读写语言变体；zh/缺省为基础版（历史行为）
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { skillsManagerWorkspace } from '../agents/skills.js'
import { validAgentTypes, DEFAULT_PROMPTS } from '../agents/index.js'
import { loadAgentPromptFile, loadBasePromptFile, serializePromptFile, promptFilePath } from '../agents/prompts.js'
import { getConfigById } from '../services/ai.js'

const app = new Hono()
const fsm = () => skillsManagerWorkspace.filesystem!

const checkType = (type: string) => validAgentTypes.includes(type)
const LANGS = ['zh', 'en', 'ja', 'ko']
const normalizeLang = (v?: string) => (v && LANGS.includes(v) ? v : 'zh')

// GET /prompts — 列出全部 Agent 的 prompt 状态（基础版口径；name/model 只属于基础版）
app.get('/', async (c) => {
  const list = await Promise.all(validAgentTypes.map(async (type) => {
    const file = await loadAgentPromptFile(type)
    return {
      agent_type: type,
      name: file?.name || DEFAULT_PROMPTS[type].name,
      model: file?.model || '',
      config_id: file?.configId ?? null,
      is_default: !file,
    }
  }))
  return success(c, list)
})

// GET /prompts/:type?lang= — 有效内容（语言变体优先，缺失回退基础版，再缺失回退代码默认）
// is_default=true 表示当前语言无独立文件（内容为回退版本），前端据此提示「跟随中文」
app.get('/:type', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, '未知的 Agent 类型')
  const lang = normalizeLang(c.req.query('lang'))
  const [file, base] = await Promise.all([
    loadAgentPromptFile(type, lang),
    lang === 'zh' ? Promise.resolve(null) : loadAgentPromptFile(type),
  ])
  // 非 zh 且变体不存在时 file 即基础版；通过路径再确认一次变体存在性
  const variantExists = lang !== 'zh' && await fsm().exists(promptFilePath(type, lang))
  if (file) {
    return success(c, {
      agent_type: type,
      lang,
      name: base?.name || file.name || DEFAULT_PROMPTS[type].name,
      model: base?.model || file.model,
      config_id: base?.configId ?? file.configId ?? null,
      system_prompt: file.instructions,
      is_default: lang === 'zh' ? false : !variantExists,
    })
  }
  return success(c, {
    agent_type: type,
    lang,
    name: DEFAULT_PROMPTS[type].name,
    model: '',
    config_id: null,
    system_prompt: DEFAULT_PROMPTS[type].instructions,
    is_default: true,
  })
})

// PUT /prompts/:type?lang= — 保存为 prompt 文件（lang 非 zh 写语言变体；model 只随基础版保存）
app.put('/:type', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, '未知的 Agent 类型')
  const body = await c.req.json()
  const lang = normalizeLang(c.req.query('lang') ?? body.lang)
  const instructions = String(body.system_prompt ?? '').trim()
  if (!instructions) return badRequest(c, 'system_prompt 必填')
  if (lang === 'zh') {
    const existing = await loadBasePromptFile(type)
    const name = String(body.name || existing?.name || DEFAULT_PROMPTS[type].name)
    // Prompt-only edits must not erase an Agent's independent model selection.
    const model = 'model' in body ? String(body.model ?? '').trim() : existing?.model || ''
    if (/[\r\n"]/u.test(model)) return badRequest(c, 'model 包含无效字符')
    const rawConfigId = 'config_id' in body ? body.config_id : existing?.configId
    const configId = rawConfigId === null || rawConfigId === undefined || rawConfigId === ''
      ? null : Number(rawConfigId)
    if (configId !== null && (!Number.isSafeInteger(configId) || configId <= 0)) {
      return badRequest(c, 'config_id 必须为有效文本配置 ID')
    }
    if ('config_id' in body && configId !== null && !await getConfigById(configId, { serviceType: 'text' })) {
      return badRequest(c, '文本配置不存在或未启用')
    }
    await fsm().writeFile(promptFilePath(type), serializePromptFile({ name, model, configId, instructions }), { recursive: true })
    return success(c, { agent_type: type, lang, name, model, config_id: configId, is_default: false })
  }
  // 语言变体只存本语言说明；模型选择始终写入基础版元数据，所有语言共享。
  const base = await loadBasePromptFile(type)
  const name = String(body.name || base?.name || DEFAULT_PROMPTS[type].name)
  let model = base?.model || ''
  let configId = base?.configId ?? null
  if ('model' in body || 'config_id' in body) {
    model = 'model' in body ? String(body.model ?? '').trim() : model
    if (/[\r\n"]/u.test(model)) return badRequest(c, 'model 包含无效字符')
    const rawConfigId = 'config_id' in body ? body.config_id : configId
    configId = rawConfigId === null || rawConfigId === undefined || rawConfigId === ''
      ? null : Number(rawConfigId)
    if (configId !== null && (!Number.isSafeInteger(configId) || configId <= 0)) {
      return badRequest(c, 'config_id 必须为有效文本配置 ID')
    }
    if ('config_id' in body && configId !== null && !await getConfigById(configId, { serviceType: 'text' })) {
      return badRequest(c, '文本配置不存在或未启用')
    }
    await fsm().writeFile(promptFilePath(type), serializePromptFile({
      name: base?.name || DEFAULT_PROMPTS[type].name,
      model,
      configId,
      instructions: base?.instructions || DEFAULT_PROMPTS[type].instructions,
    }), { recursive: true })
  }
  await fsm().writeFile(promptFilePath(type, lang), serializePromptFile({ name, model: '', instructions }), { recursive: true })
  return success(c, { agent_type: type, lang, name, model, config_id: configId, is_default: false })
})

// POST /prompts/:type/reset?lang= — 删除对应语言文件，回退（变体→基础版；基础版→代码默认）
app.post('/:type/reset', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, '未知的 Agent 类型')
  const lang = normalizeLang(c.req.query('lang'))
  const path = promptFilePath(type, lang)
  if (await fsm().exists(path)) await fsm().deleteFile(path)
  return success(c, { agent_type: type, lang, is_default: true })
})

export default app
