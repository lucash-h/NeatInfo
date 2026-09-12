import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../api';
import { useApp } from '../AppContext';
import { getPlayer, setEngine, webSpeechEngine, workersAudioEngine, chooseEngine } from '../tts';

// The UI knows only `speak / pause / resume / stop` and a progress fraction,
// which is what lets §6's Tier 2 (server-generated audio + Media Session)
// replace the engine
// underneath without this file changing.
export default function TtsPlayer({ article }) {
  const { toast } = useApp();
  // One player for the life of the app -- setEngine swaps the engine inside it
  // rather than minting a new one, so this reference, getPlayer() in
  // AppContext and the live player are always the same object.
  const player = getPlayer();
  const [playing, setPlaying] = useState(false);
  const [voice, setVoice] = useState(null);   // 'server' | 'device', once known
  const fillRef = useRef();
  // Guards against a double tap starting two generations: the second click
  // sees status 'idle' too, and each one costs neurons.
  const startingRef = useRef(false);

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

    // Server audio when the Worker can produce it, the browser's own voice
    // when it cannot. Tier 1 stays as the floor on purpose: it works offline
    // and needs no account, and losing speech entirely to a remote dependency
    // would be a downgrade whatever the voice quality. §6
    if (startingRef.current) return;
    startingRef.current = true;

    let chosen;
    try {
      chosen = await chooseEngine({
        articleId: article.id,
        fetchJson: api,
        makeServerEngine: (opts) => workersAudioEngine(opts),
        makeDeviceEngine: () => webSpeechEngine()
      });
    } finally {
      startingRef.current = false;
    }

    const active = setEngine(chosen.engine);
    setVoice(chosen.voice);

    const speakWith = (text) => active.speak(text, {
      onProgress: setProgress,
      onEnd: () => { setPlaying(false); setProgress(1); },
      onError: (err) => {
        setPlaying(false);
        setProgress(0);
        // A segment failing mid-article is the case the manifest cannot
        // predict -- a 502, a stalled download, the day's limit reached
        // between segments. Falling back here is what the spec promised and
        // what stops a retry regenerating everything from segment zero.
        if (chosen.voice === 'server') {
          const device = webSpeechEngine();
          if (device.available) {
            setEngine(device);
            setVoice('device');
            toast('Server audio failed — switching to the device voice.');
            setPlaying(true);
            getPlayer().speak(text, {
              onProgress: setProgress,
              onEnd: () => { setPlaying(false); setProgress(1); },
              onError: (e) => { setPlaying(false); if (e?.message) toast(e.message); }
            });
            return;
          }
        }
        if (err?.message) toast(err.message);
      }
    });

    const text = `${article.title}. ${article.body_text || ''}`;
    const started = await speakWith(text);
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
