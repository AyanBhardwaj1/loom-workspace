import { Component, type ReactNode } from 'react'
import { Button } from './primitives'

/**
 * C8 — a pane-scoped error boundary: one crashing pane (log, sidebar,
 * history, palette) never takes the app down. The fallback states what
 * happened and offers the one useful action.
 */
export class PaneBoundary extends Component<
  { label: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[pane:${this.props.label}]`, error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="text-ui text-secondary">
            The {this.props.label} hit an error and stopped rendering.
          </div>
          <div className="max-w-md truncate font-mono text-small text-tertiary">{String(this.state.error.message)}</div>
          <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
            Reload pane
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
