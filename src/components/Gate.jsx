import { useState } from 'react';
import { api } from '../api';

export default function Gate({ onAuth }) {
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const passphrase = e.target.elements.passphrase.value;
    try {
      await api('/api/session', {
        method: 'POST',
        body: JSON.stringify({ passphrase }),
      });
      onAuth();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={handleSubmit}>
        <h1 className="gate-title">NeatInfo</h1>
        <p className="gate-note">One passphrase. Nothing to sign up for.</p>
        <input
          className="input"
          name="passphrase"
          type="password"
          autoComplete="current-password"
          placeholder="Passphrase"
          required
        />
        {error && <p className="gate-error">{error}</p>}
        <button className="btn btn-primary" type="submit">Enter</button>
      </form>
    </div>
  );
}
