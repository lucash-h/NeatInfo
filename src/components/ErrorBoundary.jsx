import { Component } from 'react';

// A render error anywhere below this leaves a blank white page, which is the
// one failure mode §9.1 says the app must not have. React only offers class
// components for this, so this file is the app's single class component.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // No telemetry in a single-user app; the console is the log. §9.8
    console.error('NeatInfo crashed while rendering:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="crash">
        <h2 className="crash-title">Something in the app broke.</h2>
        <p className="crash-note">
          Nothing was lost — the archive lives in the database, not in this page.
          Reload to carry on, and export a copy if it keeps happening.
        </p>
        <p className="crash-detail">{String(this.state.error?.message || this.state.error)}</p>
        <div className="crash-actions">
          <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
          <a className="btn" href="/api/export">Export JSON</a>
        </div>
      </div>
    );
  }
}
