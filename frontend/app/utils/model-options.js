/** Model choices from active configs, including provider configs without model IDs. */
export function configModels(cfg) {
  const raw = cfg?.model
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter(Boolean)
  try { const m = JSON.parse(raw); return Array.isArray(m) ? m.filter(Boolean) : [m].filter(Boolean) } catch { return [raw].filter(Boolean) }
}

export function collectModelOptions(cfgs) {
  const seen = new Set()
  const out = []
  const sorted = [...cfgs].filter(c => c.is_active).sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const c of sorted) {
    const models = configModels(c)
    // RunningHub workflows and model APIs are selected by config, not a guessed model ID.
    if (c.provider === 'runninghub' && !models.length) {
      out.push({ key: `runninghub/config-${c.id}`, model: c.name || 'RunningHub',
        provider: c.provider, configId: c.id, configName: c.name || c.provider })
      continue
    }
    for (const m of models) {
      const key = `${c.provider}/${m}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, model: m, provider: c.provider, configId: c.id, configName: c.name || c.provider })
    }
  }
  return out
}

export function bareModelName(key) {
  if (!key || /^runninghub\/config-\d+$/.test(key)) return ''
  const i = key.indexOf('/')
  return i >= 0 ? key.slice(i + 1) : key
}

export function ownerConfigId(options, key) {
  return key ? (options.find(o => o.key === key)?.configId || undefined) : undefined
}

export function hasMultiConfigs(options) {
  return new Set(options.map(o => o.configId)).size > 1
}
