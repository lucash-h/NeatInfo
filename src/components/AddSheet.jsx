import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../AppContext';
import { needsText } from '../helpers';

export default function AddSheet({ visible, onClose }) {
  const { load, switchSurface, toast, open, fillArticle } = useApp();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [notice, setNotice] = useState(null);
  const [showPaste, setShowPaste] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dupArticle, setDupArticle] = useState(null);
  // Set when the paste is destined for an item that already exists rather than
  // for a new row -- the case the duplicate guard used to make unreachable.
  const [fillTarget, setFillTarget] = useState(null);

  if (!visible) return null;

  function reset() {
    setUrl(''); setText(''); setTitle(''); setSource('');
    setNotice(null); setShowPaste(false); setDupArticle(null); setFillTarget(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();

    // §3 "Pull": pasting the text of an item whose fetch failed fills in the
    // existing row instead of being refused as a duplicate.
    if (fillTarget) {
      if (!text.trim()) return;
      setSubmitting(true);
      const article = await fillArticle(fillTarget.id, { title, source, body_text: text });
      setSubmitting(false);
      if (!article) return;
      reset();
      onClose();
      return;
    }

    if (!url && !text) return;
    setSubmitting(true);
    setNotice(null);
    setDupArticle(null);

    try {
      const result = await api('/api/articles', {
        method: 'POST',
        body: JSON.stringify({ url, text, title, source }),
      });

      if (result.status === 409) {
        setDupArticle(result.article);
        if (needsText(result.article)) {
          // Never a dead end, even on the second attempt.
          setNotice(
            `Already here — "${result.article.title}" (${result.article.status}), and its text never arrived. ` +
            `Paste it below and it will fill in that item.`
          );
          setFillTarget(result.article);
          setTitle(result.article.title);
          setShowPaste(true);
        } else {
          setNotice(`Already here — "${result.article.title}" (${result.article.status}).`);
        }
        load();
        return;
      }

      if (result.bodyTruncated) {
        toast('Added — the text was long, so only the first 512 KB was kept');
      }

      if (result.fetchError) {
        toast('Added — but the page could not be read');
        setNotice(`${result.fetchError}. The item is saved with its URL; paste the text to fill it in.`);
        setShowPaste(true);
        setFillTarget(result.article);
        setTitle(result.article.title);
        load();
        return;
      }

      reset();
      onClose();
      toast('Added to today');
      switchSurface('today');
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleScrimClick(e) {
    if (e.target === e.currentTarget) { reset(); onClose(); }
  }

  const submitLabel = submitting
    ? (fillTarget ? 'Saving…' : 'Fetching…')
    : fillTarget ? 'Fill in the existing item'
    : showPaste ? 'Add article'
    : 'Fetch and add';

  return (
    <div className="sheet-scrim" onClick={handleScrimClick}>
      <form className="sheet" onSubmit={handleSubmit}>
        <div className="sheet-head">
          <span className="sheet-title">Add to today</span>
          <button className="link-btn muted" type="button" onClick={() => { reset(); onClose(); }}>Cancel</button>
        </div>

        <input className="input" type="url" inputMode="url" autoComplete="off" placeholder="Paste a URL"
          value={url} onChange={e => setUrl(e.target.value)} autoFocus />

        {notice && (
          <div className="notice">
            {notice}
            {dupArticle && (
              <button className="link-btn" type="button" onClick={() => { reset(); onClose(); open(dupArticle.id); }}>
                Open it
              </button>
            )}
          </div>
        )}

        <button className="btn btn-primary btn-tall" type="submit" disabled={submitting}>
          {submitLabel}
        </button>

        <div className="sheet-alt">
          <span className="sheet-alt-q">Behind a login wall, or a PDF?</span>
          <button className="link-btn" type="button" onClick={() => setShowPaste(!showPaste)}>
            Paste the text instead →
          </button>
          {showPaste && (
            <div className="paste-fields">
              <input className="input" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} />
              <input className="input" placeholder="Source" value={source} onChange={e => setSource(e.target.value)} />
              <textarea className="input textarea" rows={6} placeholder="Paste the article text"
                value={text} onChange={e => setText(e.target.value)} />
            </div>
          )}
          <span className="sheet-alt-note">A failed fetch still creates the item with its URL. Never a dead end.</span>
        </div>
      </form>
    </div>
  );
}
