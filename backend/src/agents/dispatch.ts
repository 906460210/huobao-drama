/**
 * Declarative Agent dispatch metadata.
 *
 * Adding an Agent or a future external skill pack starts with one route here;
 * the runtime binds each route to its tool set and discovers skills by prefix.
 * No API credentials or user-specific model IDs belong in this table.
 */
export type AgentToolSet = 'script' | 'extract' | 'storyboard' | 'prompt'

export interface AgentDispatchRoute {
  toolSet: AgentToolSet
  skillPrefixes: readonly string[]
}

export const agentDispatchRoutes: Record<string, AgentDispatchRoute> = {
  script_rewriter: { toolSet: 'script', skillPrefixes: ['script-rewriter'] },
  extractor: { toolSet: 'extract', skillPrefixes: ['extractor'] },
  storyboard_breaker: { toolSet: 'storyboard', skillPrefixes: ['storyboard-breaker'] },
  prompt_generator: {
    toolSet: 'prompt',
    skillPrefixes: [
      'prompt-generator/character-prompt',
      'prompt-generator/scene-prompt',
      'prompt-generator/prop-prompt',
      'prompt-generator/video-prompt',
    ],
  },
}

export function getAgentDispatchRoute(agentType: string): AgentDispatchRoute | null {
  return Object.prototype.hasOwnProperty.call(agentDispatchRoutes, agentType)
    ? agentDispatchRoutes[agentType] : null
}

export interface AgentTextSelection {
  model?: string
  configId?: number
}

/**
 * A request-level selection wins over the Agent default. Selecting a different
 * config without a model uses that config's own default model.
 */
export function resolveAgentTextSelection(
  agent: AgentTextSelection,
  request: AgentTextSelection,
): AgentTextSelection {
  return {
    configId: request.configId ?? agent.configId,
    model: request.model || (request.configId ? undefined : agent.model || undefined),
  }
}
