/**
 * Every tool's parameters go to the model as an OpenAI function schema, and the
 * spec requires `type: "object"`. Some servers check and some do not, so a tool
 * with a union argument type worked against SGLang for months and then made a
 * strict provider refuse the entire request - failing every tool at once, with a
 * message naming whichever one it validated first.
 */
import { describe, expect, it } from 'vitest'
import { getCopilotRuntimeToolManifest } from '@/lib/copilot/runtime-tool-manifest'

describe('the tool manifest', () => {
  it('gives every tool an object parameter schema', async () => {
    const manifest = await getCopilotRuntimeToolManifest()

    const notObjects = manifest.tools
      .filter((tool) => tool.parameters !== undefined && tool.parameters.type !== 'object')
      .map((tool) => `${tool.name}: type=${JSON.stringify(tool.parameters?.type)}`)

    expect(notObjects).toEqual([])
  })

  it('keeps the union branches of the tools that have them', async () => {
    const manifest = await getCopilotRuntimeToolManifest()

    // These four are discriminated unions (personal vs workspace scope). The
    // fix adds `type` alongside `oneOf`; it must not flatten the branches away.
    for (const name of [
      'read_environment_variables',
      'set_environment_variables',
      'read_oauth_credentials',
      'read_credentials',
    ]) {
      const tool = manifest.tools.find((candidate) => candidate.name === name)
      expect(tool, `${name} missing from manifest`).toBeDefined()
      expect(tool?.parameters?.type).toBe('object')
      expect(Array.isArray(tool?.parameters?.oneOf), `${name} lost its branches`).toBe(true)
    }
  })
})
