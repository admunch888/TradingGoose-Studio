'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('WidgetRenderBoundary')

type WidgetRenderBoundaryProps = {
  /** Identifies the failing widget/slot in the log line and the on-screen message. */
  label: string
  message: string
  retryLabel: string
  retryingLabel?: string
  children: ReactNode
}

type WidgetRenderBoundaryState = {
  error: Error | null
}

/**
 * Keeps a single misbehaving widget from taking the whole workspace down.
 *
 * Widget bodies and header slots are rendered by WidgetSurface with no boundary
 * between them and the dashboard, so any throw inside one widget unmounts the
 * entire surface - the user loses the dashboard, not just that widget, and the
 * picker they would use to switch away goes with it.
 *
 * The error is rendered IN the panel rather than only logged: a deployed build
 * shows a generic "Something went wrong" page, which tells the operator nothing
 * and cannot be diagnosed without opening DevTools before reproducing.
 */
export class WidgetRenderBoundary extends Component<
  WidgetRenderBoundaryProps,
  WidgetRenderBoundaryState
> {
  public state: WidgetRenderBoundaryState = { error: null }

  public static getDerivedStateFromError(error: Error): WidgetRenderBoundaryState {
    return { error }
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error(`Widget "${this.props.label}" failed to render`, error, info.componentStack)
  }

  private readonly handleRetry = () => {
    this.setState({ error: null })
  }

  public render() {
    const { error } = this.state
    if (!error) {
      return this.props.children
    }

    const frames = (error.stack ?? '').split('\\n').slice(1, 4).join('\\n')

    return (
      <div
        className='flex h-full w-full flex-col items-center justify-center gap-2 overflow-auto p-4 text-center'
        role='alert'
        aria-atomic='true'
      >
        <p className='font-medium text-destructive text-xs'>{this.props.message}</p>
        <p className='font-mono text-[10px] text-muted-foreground'>
          {this.props.label}: {error.message}
        </p>
        {frames ? (
          <pre className='max-w-full whitespace-pre-wrap text-left font-mono text-[9px] text-muted-foreground/80'>
            {frames}
          </pre>
        ) : null}
        <Button type='button' variant='outline' size='sm' onClick={this.handleRetry}>
          {this.props.retryingLabel ?? this.props.retryLabel}
        </Button>
      </div>
    )
  }
}
