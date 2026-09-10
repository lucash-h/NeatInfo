import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../api';
import { getPlayer } from '../tts';

// The UI knows only `speak / pause / resume / stop` and a progress fraction,
// which is what lets §6's Tier 2 (R2 audio + Media Session) replace the engine
// underneath without this file changing.
export default function TtsPlayer({ article }) {
  const player = getPlayer();
  const [playing, setPlaying] = useState(false);
  const fillRef = useRef();

  const setProgress = useCallback((fraction) => {
    if (fillRef.current) fillRef.current.style.width = `${Math.round(fraction * 100)}%`;
  }, []);

  // Stepping to another article must not leave the previous one talking. §6/G8
  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    return () => {
      player.stop();
    };
  }, [article.id, player, setProgress]);

  const toggle = useCallback(() => {
    if (!player.supported) return;

    if (player.status() === 'playing') {
      player.pause();
      setPlaying(false);
      return;
    }
    if (player.status() === 'paused') {
      player.resume();
      setPlaying(true);
      return;
    }

    const started = player.speak(`${article.title}. ${article.body_text || ''}`, {
      onProgress: setProgress,
      onEnd: () => { setPlaying(false); setProgress(1); },
      onError: () => setPlaying(false),
    });
    if (!started) return;
    setPlaying(true);
    api(`/api/articles/${article.id}/listen`, { method: 'POST' }).catch(() => {});
  }, [article, player, setProgress]);

  return (
    <div className="player">
      <button className="player-btn" onClick={toggle} disabled={!player.supported}>
        {playing ? '❙❙' : '▶'}
      </button>
      <div className="player-meter">
        <div className="player-track">
          <div className="player-fill" ref={fillRef} />
        </div>
        <span className="player-note">
          {player.supported ? 'Listen · device voice, in-page' : 'This browser has no speech synthesis'}
        </span>
      </div>
    </div>
  );
}
