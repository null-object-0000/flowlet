import React, { Component, type ReactNode } from "react";
import type { AppError } from "./AppError";
import { toAppError } from "../../platform/tauri/client";

type Props = {
  children: ReactNode;
  fallback?: (error: AppError, retry: () => void) => ReactNode;
};

type State = {
  error: AppError | null;
};

/** Application-level error boundary. Catches render-phase crashes and
 *  surfaces them as AppError instead of a blank screen. Async query/mutation
 *  errors are handled by TanStack Query and should NOT rely on this. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(err: unknown): State {
    return { error: toAppError(err, "render_error") };
  }

  retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.retry);
    return null;
  }
}
