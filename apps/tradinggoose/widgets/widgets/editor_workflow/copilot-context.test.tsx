/**
 * @vitest-environment jsdom
 */

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GlobalCopilotContextProvider,
  useGlobalCopilotCurrentContext,
} from '@/global-navbar/copilot-context'
import { getPublicCopy } from '@/i18n/public-copy'
import type { ChatContext } from '@/stores/copilot/types'
import { workflowEditorWidget } from './index'

vi.mock('next-intl', () => ({
  useLocale: () => 'es',
  useMessages: () => getPublicCopy('es'),
}))

vi.mock('lucide-react', () => ({
  Workflow: () => <svg />,
}))

vi.mock('@/components/ui/loading-agent', () => ({
  LoadingAgent: () => <div>loading</div>,
}))

let mockWorkflowWidgetState: any = {
  resolvedWorkflowId: 'wf-1',
  resolvedWorkflowName: 'Alpha',
  hasLoadedWorkflows: true,
  loadError: null,
  isLoading: false,
  workflowIds: ['wf-1'],
}

vi.mock('@/widgets/hooks/use-workflow-widget-state', () => ({
  useWorkflowWidgetState: () => mockWorkflowWidgetState,
}))

vi.mock('@/widgets/widgets/components/workflow-dropdown', () => ({
  WorkflowDropdown: () => <div>workflow-dropdown</div>,
}))

vi.mock('@/widgets/widgets/editor_workflow/components/workflow-controlbar', () => ({
  WorkflowWidgetControlBar: () => <div>control-bar</div>,
}))

vi.mock('@/widgets/widgets/editor_workflow/components/workflow-toolbar', () => ({
  WorkflowToolbar: () => <div>toolbar</div>,
}))

vi.mock('@/widgets/widgets/editor_workflow/context/workflow-ui-context', () => ({
  WorkflowUIConfigProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/widgets/widgets/editor_workflow/components/workflow-editor-app', () => ({
  __esModule: true,
  default: () => <div>editor-app</div>,
}))

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function CurrentContextProbe() {
  const context = useGlobalCopilotCurrentContext()
  return <div data-testid='current-context'>{context ? JSON.stringify(context) : ''}</div>
}

const renderWidgetProps = {
  channelId: 'pair-red',
  context: { workspaceId: 'ws-1' },
  params: { workflowId: 'wf-1' },
  widget: { key: 'editor_workflow', params: { workflowId: 'wf-1' } },
  panelId: 'panel-1',
} as any

describe('workflow editor copilot context', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    mockWorkflowWidgetState = {
      resolvedWorkflowId: 'wf-1',
      resolvedWorkflowName: 'Alpha',
      hasLoadedWorkflows: true,
      loadError: null,
      isLoading: false,
      workflowIds: ['wf-1'],
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  const readPublishedContext = (): ChatContext | null => {
    const text = container.querySelector('[data-testid="current-context"]')?.textContent
    return text ? (JSON.parse(text) as ChatContext) : null
  }

  const renderEditor = async (children: ReactNode) => {
    await act(async () =>
      root.render(<GlobalCopilotContextProvider>{children}</GlobalCopilotContextProvider>)
    )
  }

  const renderEditorOnly = async () => {
    await renderEditor(
      <>
        {createElement(workflowEditorWidget.component, renderWidgetProps)}
        <CurrentContextProbe />
      </>
    )
  }

  it('publishes the open workflow as the current copilot context', async () => {
    await renderEditorOnly()

    expect(readPublishedContext()).toEqual({
      kind: 'current_workflow',
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      label: 'Alpha',
    })
  })

  it('falls back to the workflow id label when the workflow has no name', async () => {
    mockWorkflowWidgetState.resolvedWorkflowName = null

    await renderEditorOnly()

    expect(readPublishedContext()).toEqual({
      kind: 'current_workflow',
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      label: 'wf-1',
    })
  })

  it('republishes the newly selected workflow after a selection switch', async () => {
    await renderEditorOnly()
    expect(readPublishedContext()).toMatchObject({ workflowId: 'wf-1' })

    mockWorkflowWidgetState = {
      resolvedWorkflowId: 'wf-2',
      resolvedWorkflowName: 'Beta',
      hasLoadedWorkflows: true,
      loadError: null,
      isLoading: false,
      workflowIds: ['wf-1', 'wf-2'],
    }
    await renderEditorOnly()

    expect(readPublishedContext()).toEqual({
      kind: 'current_workflow',
      workflowId: 'wf-2',
      workspaceId: 'ws-1',
      label: 'Beta',
    })
  })

  it('clears the published context when the editor unmounts', async () => {
    await renderEditorOnly()
    expect(readPublishedContext()).not.toBeNull()

    await renderEditor(<CurrentContextProbe />)

    expect(readPublishedContext()).toBeNull()
  })

  it('publishes nothing while no workflow is selected', async () => {
    mockWorkflowWidgetState = {
      resolvedWorkflowId: null,
      resolvedWorkflowName: null,
      hasLoadedWorkflows: true,
      loadError: null,
      isLoading: false,
      workflowIds: ['wf-1'],
    }

    await renderEditorOnly()

    expect(readPublishedContext()).toBeNull()
  })

  it('clears the published context when the selection is removed while mounted', async () => {
    await renderEditorOnly()
    expect(readPublishedContext()).toMatchObject({ workflowId: 'wf-1' })

    mockWorkflowWidgetState = {
      resolvedWorkflowId: null,
      resolvedWorkflowName: null,
      hasLoadedWorkflows: true,
      loadError: null,
      isLoading: false,
      workflowIds: [],
    }
    await renderEditorOnly()

    expect(readPublishedContext()).toBeNull()
  })
})
