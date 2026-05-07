import { getAgentContext } from '../../utils/agentContext.js'

/**
 * The main conversation thread does not run under an AsyncLocalStorage agent
 * context. Subagents and teammates always do, so this gives us a clean split
 * between "fork semantics" and "main agent default backgrounding".
 */
export function shouldForceMainAgentAsyncSpawn(): boolean {
  return getAgentContext() === undefined
}
