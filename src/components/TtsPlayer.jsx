import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../api';
import { useApp } from '../AppContext';
import { getPlayer, setEngine, webSpeechEngine, workersAudioEngine } from '../tts';

// The UI knows only `speak / pause / resume / stop` and a progress fraction,
// which is what lets §6's Tier 2 (R2 audio + Media Session) replace the engine
// underneath without this file changing.
export default function TtsPlayer({ article }) {
  const { toast } = useApp();
  const [player, setPlayer] = useState(getPlayer);
  const [playing, setPlaying] = useState(false);
  const [voice, setVoice] = useState(null);   // 'server' | 'device', once known
  const fillRef = useRef();

  const setProgress = useCallback((fraction) => {
    if (fillRef.current) fillRef.current.style.width = `${Math.round(fraction * 100)}%`;
  }, []);

  // Stepping to another article must not leave the previous one talking. §6/G8
  useEffect(() => {
    setPlaying(false);
    setProgress(0);
    setVoice(null);
    return () => {
      player.stop();
    };
  }, [article.id, player, setProgress]);

  const toggle = useCallback(async () => {
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

    // Server audio when the Worker can produce it, the browser's own voice when
    // it cannot -- too long, no AI binding, or a generation failure. Tier 1
    // stays as the floor deliberately: it works offline and needs no account,
    // and losing that to a remote dependency would be a downgrade. §6
    let active = player;
    let usingServer = false;

    const server = workersAudioEngine({ articleId: article.id, fetchJson: api });
    if (server.available) {
      const units = await server.prepare(null, { articleId: article.id }).catch(() => null);
      // The engine caches what prepare() fetched, so the player asking again
      // when it starts speaking costs nothing.
      if (units?.length) {
        active = setEngine(server);
        usingServer = true;
      }
    }
    if (!usingServer) active = setEngine(webSpeechEngine());

    setPlayer(active);
    setVoice(usingServer ? 'server' : 'device');

    const started = await active.speak(`${article.title}. ${article.body_text || ''}`, {
      onProgress: setProgress,
      onEnd: () => { setPlaying(false); setProgress(1); },
      // Silence with the button reset and no explanation is the failure this
      // whole task was about; the watchdog's message has to reach the reader.
      // V1-31
      onError: (err) => {
        setPlaying(false);
        setProgress(0);
        if (err?.message) toast(err.message);
      },
    });
    if (!started) return;
    setPlaying(true);
    api(`/api/articles/${article.id}/listen`, { method: 'POST' }).catch(() => {});
  }, [article, player, setProgress, toast]);

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
          {!player.supported
            ? 'This browser has no speech synthesis'
            : voice === 'server'
              ? 'Listen · generated voice'
              : voice === 'device'
                ? 'Listen · device voice, in-page'
                : 'Listen'}
        </span>
      </div>
    </div>
  );
}
