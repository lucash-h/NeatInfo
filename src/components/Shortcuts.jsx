// V1-22: the help overlay for keyboard shortcuts, opened with `?`. Built on
// the same .sheet / .sheet-scrim idiom as AddSheet / SettingsSheet rather than
// a bespoke modal, and driven by the same visible/onClose prop pair.
const BINDINGS = [
  ['j', 'Next item'],
  ['k', 'Previous item'],
  ['e', 'Keep'],
  ['s', 'Star (keeps and favorites)'],
  ['x', 'Dismiss'],
  ['a', 'Add an article'],
  ['/', 'Search the archive'],
  ['?', 'Toggle this list'],
  ['Esc', 'Close whatever is open'],
];

export default function Shortcuts({ visible, onClose }) {
  if (!visible) return null;

  return (
    <div className="sheet-scrim" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="sheet-head">
          <span className="sheet-title">Keyboard shortcuts</span>
          <button className="link-btn muted" type="button" onClick={onClose}>Close</button>
        </div>
        <ul className="shortcut-list">
          {BINDINGS.map(([key, desc]) => (
            <li key={key} className="shortcut-row">
              <kbd className="kbd">{key}</kbd>
              <span>{desc}</span>
            </li>
          ))}
        </ul>
        <p className="field-hint">
          None of these fire while typing in a field, or while a sheet like this one is open.
        </p>
      </div>
    </div>
  );
}
