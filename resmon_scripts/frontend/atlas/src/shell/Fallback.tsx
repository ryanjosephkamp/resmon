import { Component, type ReactNode } from 'react';

interface Props {
  /** Drawing is tried again when this changes: another address, another file. */
  resetKey: string;
  fallback: (error: Error) => ReactNode;
  children: ReactNode;
}

/**
 * What stands in for a part of the window that throws while it is drawn.
 * Without one, React takes the whole window down with the part that failed,
 * and a reload opens the same address and fails the same way.
 */
export class Fallback extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
