/**
 * There is deliberately no default base URL for the remote Copilot service.
 *
 * It used to fall back to a hosted host when nothing was configured, which meant
 * an unconfigured deployment sent workflow state, block settings and chat
 * contexts to a third party without anyone choosing to. Reaching a service you
 * do not run should be something you switch on, not something you forget to
 * switch off, so callers now require an explicit URL and fail with a message
 * naming the setting when it is missing.
 *
 * Set it under System Services -> Copilot API (`baseUrl`), or COPILOT_API_URL.
 */
export const COPILOT_API_URL_SETTING =
  'System Services -> Copilot API (baseUrl), or COPILOT_API_URL'

export const COPILOT_API_NOT_CONFIGURED_MESSAGE =
  `The remote Copilot service is not configured, so this request was not sent. ` +
  `Set a base URL under ${COPILOT_API_URL_SETTING} if you run one.`

export const COPILOT_API_VERSION = '1.0'
