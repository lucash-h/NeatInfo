import { useState, useCallback, useRef, useEffect } from 'react';
import { useApp } from '../AppContext';
import { metaLine, needsText } from '../helpers';
import TtsPlayer from './TtsPlayer';

export default function Reader() {
  const { openArticle: a, close, resolve, toggleStar, saveNote, fillArticle, refetch } = useApp();
  const [fillText, setFillText] = useState('');
  const [busy, setBusy] = useState(false);
  const noteTimer = useRef();
  const pendingNote = useRef(null);
  const saveNoteRef = useRef(saveNote);
  saveNoteRef.current = saveNote;
  const [noteValue, setNoteValue] = useState(a?.notes || '');

  // G8: the note used to be an uncontrolled `defaultValue`, so stepping j/l
  // left the previous article's note on screen. It is keyed to the article
  // now, and a debounced edit is flushed before the article changes under it.
  useEffect(() => {
    setNoteValue(a?.notes || '');
    setFillText('');
    return () => {
      clearTimeout(noteTimer.current);
      const queued = pendingNote.current;
      pendingNote.current = null;
      if (queued) saveNoteRef.current(queued.id, queued.value);
    };
  }, [a?.id]);

  const handleNoteChange = useCallback((e) => {
    const val = e.target.value;
    const id = a.id;
    setNoteValue(val);
    pendingNote.current = { id, value: val };
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => {
      pendingNote.current = null;
      saveNoteRef.current(id, val);
    }, 800);
  }, [a]);

  if (!a) {
    return (
      <section className="reader" hidden={typeof window !== 'undefined' && window.innerWidth < 1100}>
        <div className="reader-bar">
          <span />
        </div>
        <div className="reader-body">
          <div className="reader-placeholder">
            <span>Pick something from the list to read it here.</span>
            <span>Opening an article is what records opened_at — the difference between
              "I read it and got distracted" and "I never clicked it."</span>
          </div>
        </div>
        <div className="reader-foot" />
      </section>
    );
  }

  const paragraphs = (a.body_text || '').split(/\n{2,}/).filter(Boolean);
  const isNew = a.status === 'new';

  return (
    <section className="reader">
      <div className="reader-bar">
        <button className="link-btn reader-back" onClick={close}>‹ Back</button>
        <div className="reader-actions">
          {isNew ? (
            <>
              <button className="btn btn-primary desk-btn" onClick={() => resolve(a.id, 'kept', false)}>Keep</button>
              <button className="btn btn-icon desk-btn" onClick={() => resolve(a.id, 'kept', true)}>★</button>
              <button className="btn desk-btn" onClick={() => resolve(a.id, 'dismissed', false)}>Dismiss</button>
            </>
          ) : (
            <button
              className="btn btn-icon desk-btn"
              aria-pressed={String(Boolean(a.favorite))}
              onClick={() => toggleStar(a.id, !a.favorite)}
            >★</button>
          )}
        </div>
        <span className="eyebrow">
          {isNew ? (a.opened_at ? 'opened · undecided' : 'new') : a.status}
        </span>
        <span className="keyhint">K keep · S star · X dismiss · J / L move</span>
      </div>

      <div className="reader-body">
        <div className="reader-inner">
          <div className="card-meta">{metaLine(a)}</div>
          <h2 className="reader-title">{a.title}</h2>

          {a.url && (
            <a className="source-link" href={a.url} target="_blank" rel="noreferrer noopener">
              Open the original ↗
            </a>
          )}

          {a.body_text && <TtsPlayer article={a} />}

          {paragraphs.length ? (
            paragraphs.map((p, i) => <p key={i} className="para">{p}</p>)
          ) : (
            <p className="card-summary">
              {a.summary || 'No text was captured for this one.'}
            </p>
          )}

          {/* Never a dead end: an item whose fetch failed is completed here,
              by retrying or by pasting the text. §3 "Pull" */}
          {needsText(a) && (
            <div className="fill-block">
              <span className="eyebrow">This one has no text yet</span>
              <p className="field-hint">
                {a.fetch_status ? `The fetch came back "${a.fetch_status}".` : 'The page was never fetched.'}
                {' '}Try again, or paste the text in and it fills in this same item — nothing is re-added.
              </p>
              {a.url && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={async () => { setBusy(true); await refetch(a.id); setBusy(false); }}
                >Try fetching again</button>
              )}
              <textarea
                className="input textarea"
                rows={5}
                placeholder="Paste the article text"
                value={fillText}
                onChange={e => setFillText(e.target.value)}
              />
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy || !fillText.trim()}
                onClick={async () => {
                  setBusy(true);
                  await fillArticle(a.id, { body_text: fillText });
                  setBusy(false);
                }}
              >Save the text</button>
            </div>
          )}

          <div className="note-block">
            <span className="eyebrow">Note</span>
            <textarea
              key={a.id}
              className="input textarea"
              placeholder="Why this mattered — searchable later"
              value={noteValue}
              onChange={handleNoteChange}
            />
          </div>
        </div>
      </div>

      <div className="reader-foot">
        {isNew ? (
          <>
            <button className="btn btn-primary btn-tall" style={{ flex: 1 }} onClick={() => resolve(a.id, 'kept', false)}>Keep</button>
            <button className="btn btn-icon btn-tall" style={{ width: 56 }} onClick={() => resolve(a.id, 'kept', true)}>★</button>
            <button className="btn btn-tall" style={{ flex: 1 }} onClick={() => resolve(a.id, 'dismissed', false)}>Dismiss</button>
          </>
        ) : (
          <button
            className="btn btn-icon btn-tall"
            aria-pressed={String(Boolean(a.favorite))}
            onClick={() => toggleStar(a.id, !a.favorite)}
          >★</button>
        )}
      </div>
    </section>
  );
}
