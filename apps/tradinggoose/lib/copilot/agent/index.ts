// Export the main client and types

export type { SimAgentRequest, SimAgentResponse } from './client'
export { SimAgentClient, simAgentClient } from './client'
export {
  COPILOT_API_NOT_CONFIGURED_MESSAGE,
  COPILOT_API_URL_SETTING,
  COPILOT_API_VERSION,
} from './constants'

// Import for default export
import { simAgentClient } from './client'

// Re-export for convenience
export default simAgentClient
