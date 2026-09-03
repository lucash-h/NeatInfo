import { useState, useRef, useCallback } from 'react';
import { api } from '../api';

export default function TtsPlayer({ article }) {
  const [playing, setPaused] = useState(false);
  const fillRef = useRef();

  const toggle = useCallback(() => {
    if (!('speechSynthesis' in window)) return;

    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
      setPaused(false);
      return;
    }
    if (speechSynthesis.paused) {
      speechSynthesis.resume();
      setPaused(true);
      return;
    }

    const text = `${article.title}. ${article.body_text}`;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.addEventListener('boundary', (e) => {
      if (fillRef.current) {
        fillRef.current.style.width = `${Math.min(100, (e.charIndex / text.length) * 100)}%`;
      }
    });
    utterance.addEventListener('end', () => {
      setPaused(false);
      if (fillRef.current) fillRef.current.style.width = '100%';
    });
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
    setPaused(true);
    api(`/api/articles/${article.id}/listen`, { method: 'POST' }).catch(() => {});
  }, [article]);

  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  return (
    <div className="player">
      <button className="player-btn" onClick={toggle} disabled={!supported}>
        {playing ? '❙❙' : '▶'}
      </button>
      <div className="player-meter">
        <div className="player-track">
          <div className="player-fill" ref={fillRef} />
        </div>
        <span className="player-note">
          {supported ? 'Listen · device voice, in-page' : 'This browser has no speech synthesis'}
        </span>
      </div>
    </div>
  );
}
