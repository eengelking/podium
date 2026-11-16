import { Component, type ReactNode } from "react";

// A lazy page whose script cannot be fetched (a tab left open across an upgrade, where the old file is gone, or a dropped connection) throws
// when it renders. Without a boundary that unmounts the whole console, so the failure stops here and says what to do (#754).
export class LazyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="none" role="alert">
        This page could not be loaded. Reload the tab to try again.
      </div>
    );
  }
}
