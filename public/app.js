// NeatInfo front end. Vanilla, no build step -- the whole thing is four files
// on a CDN plus one Worker.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  surface: 'today',
  filter: 'all',
  query: '',
  openId: null,
  data: { today: [], pending: [], archive: [], pendingTotal: 0, archiveTotal: 0, lapseWindowDays: 14 },
  article: null,
  speaking: false
};

/* ------------------------------------------------------------------ api */

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options
  });

  if (res.status === 401 && path !== '/api/session') {
    showGate();
    throw new Error('Not signed in.');
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw Object.assign(new Error(payload.error || `HTTP ${res.status}`), { payload, status: res.status });
  return { ...payload, status: res.status };
}

/* -------------------------------------------------------------- helpers */

// The server never guesses a timezone: the client hands it its own midnight.
// That is what makes Today correct without a cron. §2.6
function localDayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const dayMs = 86400000;

function daysSince(iso) {
  const then = new Date(iso);
  then.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((now - then) / dayMs);
}

function readMinutes(a) {
  if (!a.word_count) return null;
  return Math.max(1, Math.round(a.word_count / 230));
}

function metaLine(a) {
  const parts = [a.source];
  const when = a.published_at || a.added_at;
  if (when) {
    const d = new Date(when);
    if (!Number.isNaN(d.getTime())) {
      parts.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    }
  }
  const mins = readMinutes(a);
  if (mins) parts.push(`${mins} min`);
  return parts.join(' · ');
}

function ageLabel(a) {
  const days = daysSince(a.added_at);
  if (days <= 0) return 'added today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function lapseInfo(a) {
  const left = state.data.lapseWindowDays - daysSince(a.added_at);
  if (daysSince(a.added_at) <= 0) return null;
  return {
    label: left <= 0 ? 'lapsing' : `lapses in ${left}d`,
    urgent: left <= 4
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

/* ------------------------------------------------------------- triage UI */

function actionRow(a, { compact = false } = {}) {
  const row = el('div', 'actions');

  const keep = el('button', 'btn btn-keep', 'Keep');
  keep.addEventListener('click', () => resolve(a.id, 'kept', false));

  const star = el('button', 'btn btn-icon', '★');
  star.title = 'Keep and star';
  star.setAttribute('aria-pressed', String(Boolean(a.favorite)));
  star.addEventListener('click', () => resolve(a.id, 'kept', true));

  const dismiss = el('button', 'btn btn-dismiss', 'Dismiss');
  dismiss.addEventListener('click', () => resolve(a.id, 'dismissed', false));

  row.append(keep, star, dismiss);

  if (!compact) {
    const read = el('button', 'btn btn-icon', 'Read');
    read.style.fontSize = '13px';
    read.style.color = 'var(--secondary)';
    read.addEventListener('click', () => openArticle(a.id));
    row.append(read);
  }
  return row;
}

function articleCard(a, { showLapse = false } = {}) {
  const card = el('article', 'card');

  if (showLapse) {
    const head = el('div', 'card-head');
    head.append(el('span', 'card-meta', metaLine(a)));
    const lapse = lapseInfo(a);
    if (lapse) head.append(el('span', `chip${lapse.urgent ? ' urgent' : ''}`, lapse.label));
    card.append(head);
  } else {
    card.append(el('div', 'card-meta', metaLine(a)));
  }

  const title = el('h3', 'card-title', a.title);
  title.addEventListener('click', () => openArticle(a.id));
  title.style.cursor = 'pointer';
  card.append(title);

  if (showLapse) {
    const line = el('div', 'card-line');
    line.append(el('span', null, ageLabel(a)), el('span', null, '·'),
      el('span', null, a.opened_at ? 'opened, undecided' : 'never opened'));
    card.append(line);
  } else if (a.summary) {
    card.append(el('p', 'card-summary', a.summary));
  }

  if (a.fetch_status && a.fetch_status !== 'ok' && a.fetch_status !== 'pasted') {
    const warn = el('div', 'card-line');
    warn.append(el('span', null, 'no text captured — open the link, or paste it in'));
    card.append(warn);
  }

  card.append(actionRow(a));
  return card;
}

/* ------------------------------------------------------------- surfaces */

function renderToday(root) {
  const items = state.data.today;
  const stack = el('div', 'stack');

  const when = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  stack.append(el('div', 'dateline',
    `${when} · ${items.length} ${items.length === 1 ? 'item left' : 'items left'}`));

  if (!items.length) {
    const empty = el('div', 'empty');
    empty.append(
      el('span', 'empty-title', 'Today is clear.'),
      el('span', 'empty-note', 'Nothing left to decide. Paste a URL, or leave it — tomorrow is a different set.')
    );
    stack.append(empty);
  } else {
    items.forEach((a) => stack.append(articleCard(a)));
  }

  root.append(stack);
}

function renderPending(root) {
  const stack = el('div', 'stack');

  stack.append(el('p', 'surface-note',
    `Oldest first. Anything untouched for ${state.data.lapseWindowDays} days archives itself as lapsed — still searchable.`));

  const filters = el('div', 'filters');
  [['all', 'All'], ['opened', 'Opened'], ['unopened', 'Never opened']].forEach(([value, label]) => {
    const chip = el('button', 'filter', label);
    chip.setAttribute('aria-pressed', String(state.filter === value));
    chip.addEventListener('click', () => {
      state.filter = value;
      load();
    });
    filters.append(chip);
  });
  stack.append(filters);

  if (!state.data.pending.length) {
    stack.append(el('div', 'empty', 'Nothing waiting under this filter.'));
  } else {
    state.data.pending.forEach((a) => stack.append(articleCard(a, { showLapse: true })));
  }

  root.append(stack);
}

function renderArchive(root, { starredOnly = false } = {}) {
  const stack = el('div', 'stack');

  const search = el('input', 'input');
  search.type = 'search';
  search.placeholder = 'Search titles, body, notes';
  search.value = state.query;
  search.addEventListener('input', debounce(() => {
    state.query = search.value.trim();
    load({ keepFocus: 'search' });
  }, 250));
  stack.append(search);

  const rows = starredOnly ? state.data.archive.filter((a) => a.favorite) : state.data.archive;

  stack.append(el('div', 'dateline',
    `${rows.length} of ${state.data.archiveTotal} · nothing deleted`));

  rows.forEach((a) => {
    const row = el('button', 'archive-row');

    const head = el('div', 'card-line');
    head.append(el('span', `status-tag ${a.status}`, a.status));
    if (a.favorite) {
      const star = el('span', null, '★');
      star.style.color = 'var(--star)';
      star.style.fontSize = '13px';
      head.append(star);
    }

    row.append(head, el('span', 'archive-title', a.title), el('span', 'card-meta', metaLine(a)));
    row.addEventListener('click', () => openArticle(a.id));
    stack.append(row);
  });

  const foot = el('div', 'archive-foot');
  foot.append(el('span', null, 'Nothing is ever deleted, only demoted.'));
  const link = el('a', null, 'Export JSON');
  link.href = '/api/export';
  foot.append(link);
  stack.append(foot);

  root.append(stack);
}

function render() {
  $$('[data-surface]').forEach((btn) => {
    btn.setAttribute('aria-current', String(btn.dataset.surface === state.surface));
  });
  $$('[data-count="today"]').forEach((n) => { n.textContent = state.data.today.length; });
  $$('[data-count="pending"]').forEach((n) => { n.textContent = state.data.pendingTotal; });
  $$('[data-lapse-window]').forEach((n) => { n.textContent = state.data.lapseWindowDays; });

  const root = $('#surface');
  root.textContent = '';

  if (state.surface === 'today') renderToday(root);
  else if (state.surface === 'pending') renderPending(root);
  else if (state.surface === 'starred') renderArchive(root, { starredOnly: true });
  else renderArchive(root);

  renderTags();
  renderReader();
}

function renderTags() {
  const box = $('#rail-tags');
  if (!box) return;
  const names = new Set();
  ['today', 'pending', 'archive'].forEach((k) => {
    state.data[k].forEach((a) => (a.tags || []).forEach((t) => names.add(t)));
  });
  box.textContent = '';
  [...names].sort().slice(0, 12).forEach((name) => box.append(el('span', 'tag', name)));
}

/* --------------------------------------------------------------- reader */

function renderReader() {
  const panel = $('#reader');
  const body = $('#reader-body');
  const foot = $('#reader-foot');
  const actions = $('#reader-actions');

  body.textContent = '';
  foot.textContent = '';
  actions.textContent = '';

  const a = state.article;
  if (!a) {
    panel.hidden = true;
    const placeholder = el('div', 'reader-placeholder');
    placeholder.append(el('span', null, 'Pick something from the list to read it here.'));
    placeholder.append(el('span', null, 'Opening an article is what records opened_at — the difference between "I read it and got distracted" and "I never clicked it."'));
    body.append(placeholder);
    return;
  }

  panel.hidden = false;
  $('#reader-status').textContent = a.status === 'new'
    ? (a.opened_at ? 'opened · undecided' : 'new')
    : a.status;

  const inner = el('div', 'reader-inner');
  inner.append(el('div', 'card-meta', metaLine(a)));
  inner.append(el('h2', 'reader-title', a.title));

  if (a.url) {
    const link = el('a', 'source-link', 'Open the original ↗');
    link.href = a.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    inner.append(link);
  }

  if (a.body_text) inner.append(player(a));

  const paragraphs = (a.body_text || '').split(/\n{2,}/).filter(Boolean);
  if (paragraphs.length) {
    paragraphs.forEach((p) => inner.append(el('p', 'para', p)));
  } else {
    const none = el('p', 'card-summary',
      a.summary || 'No text was captured for this one. Open the original, or add it again by pasting the text.');
    inner.append(none);
  }

  const noteBlock = el('div', 'note-block');
  noteBlock.append(el('span', 'eyebrow', 'Note'));
  const note = el('textarea', 'input textarea');
  note.placeholder = 'Why this mattered — searchable later';
  note.value = a.notes || '';
  note.addEventListener('change', () => saveNote(a.id, note.value));
  noteBlock.append(note);
  inner.append(noteBlock);

  body.append(inner);

  // Phone: three decisions pinned to the bottom. Desktop: the same three in
  // the top bar, where the keyboard shortcuts live.
  if (a.status === 'new') {
    const keep = el('button', 'btn btn-primary btn-tall', 'Keep');
    keep.style.flex = '1';
    keep.addEventListener('click', () => resolve(a.id, 'kept', false));

    const star = el('button', 'btn btn-icon btn-tall', '★');
    star.style.width = '56px';
    star.addEventListener('click', () => resolve(a.id, 'kept', true));

    const dismiss = el('button', 'btn btn-tall', 'Dismiss');
    dismiss.style.flex = '1';
    dismiss.addEventListener('click', () => resolve(a.id, 'dismissed', false));

    foot.append(keep, star, dismiss);

    const dKeep = el('button', 'btn btn-primary desk-btn', 'Keep');
    dKeep.addEventListener('click', () => resolve(a.id, 'kept', false));
    const dStar = el('button', 'btn btn-icon desk-btn', '★');
    dStar.addEventListener('click', () => resolve(a.id, 'kept', true));
    const dDismiss = el('button', 'btn desk-btn', 'Dismiss');
    dDismiss.addEventListener('click', () => resolve(a.id, 'dismissed', false));
    actions.append(dKeep, dStar, dDismiss);
  } else {
    // Already resolved: the only decision left is whether it is worth keeping
    // around as a favourite.
    [`btn btn-icon desk-btn`, `btn btn-icon btn-tall`].forEach((cls, i) => {
      const star = el('button', cls, '★');
      star.setAttribute('aria-pressed', String(Boolean(a.favorite)));
      star.addEventListener('click', () => toggleStar(a.id, !a.favorite));
      (i === 0 ? actions : foot).append(star);
    });
  }
}

// Tier 1 TTS: the browser's own voice, in-page. It does not survive
// screen-lock on iOS -- server-side audio in R2 is the Tier 2 upgrade, and
// this player is the seam it drops into. §6
function player(a) {
  const box = el('div', 'player');
  const btn = el('button', 'player-btn', state.speaking ? '❙❙' : '▶');
  const meter = el('div', 'player-meter');
  const track = el('div', 'player-track');
  const fill = el('div', 'player-fill');
  track.append(fill);
  meter.append(track, el('span', 'player-note', 'Listen · device voice, in-page'));
  box.append(btn, meter);

  if (!('speechSynthesis' in window)) {
    btn.disabled = true;
    meter.lastChild.textContent = 'This browser has no speech synthesis';
    return box;
  }

  btn.addEventListener('click', () => {
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
      state.speaking = false;
      btn.textContent = '▶';
      return;
    }
    if (speechSynthesis.paused) {
      speechSynthesis.resume();
      state.speaking = true;
      btn.textContent = '❙❙';
      return;
    }

    const text = `${a.title}. ${a.body_text}`;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.addEventListener('boundary', (e) => {
      fill.style.width = `${Math.min(100, (e.charIndex / text.length) * 100)}%`;
    });
    utterance.addEventListener('end', () => {
      state.speaking = false;
      btn.textContent = '▶';
      fill.style.width = '100%';
    });
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
    state.speaking = true;
    btn.textContent = '❙❙';
    api(`/api/articles/${a.id}/listen`, { method: 'POST' }).catch(() => {});
  });

  return box;
}

/* --------------------------------------------------------------- actions */

async function openArticle(id) {
  state.openId = id;
  const { article } = await api(`/api/articles/${id}`);
  state.article = article;
  renderReader();
  if (!article.opened_at) {
    // One nullable timestamp on a real click. No scroll-depth heuristics. §2.3
    api(`/api/articles/${id}/open`, { method: 'POST' }).then(() => load({ quiet: true })).catch(() => {});
  }
}

function closeReader() {
  stopSpeech();
  state.openId = null;
  state.article = null;
  renderReader();
}

function stopSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  state.speaking = false;
}

async function resolve(id, status, favorite) {
  await api(`/api/articles/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ status, favorite })
  });
  toast(favorite ? 'Starred and archived' : status === 'kept' ? 'Kept' : 'Dismissed');

  // Desktop triage runs down a list, so resolving advances to the neighbour.
  // On a phone the reader is the whole screen -- being thrown into the next
  // article instead of back to the list is disorienting, so it doesn't.
  const wasOpen = state.openId === id;
  const next = wasOpen && isWide() ? neighbourOf(id) : null;
  if (wasOpen) closeReader();
  await load({ quiet: true });
  if (next) openArticle(next);
}

async function toggleStar(id, favorite) {
  await api(`/api/articles/${id}/star`, { method: 'POST', body: JSON.stringify({ favorite }) });
  await load({ quiet: true });
  if (state.openId === id) openArticle(id);
}

async function saveNote(id, notes) {
  await api(`/api/articles/${id}`, { method: 'PATCH', body: JSON.stringify({ notes }) });
  toast('Note saved');
}

function currentList() {
  if (state.surface === 'today') return state.data.today;
  if (state.surface === 'pending') return state.data.pending;
  if (state.surface === 'starred') return state.data.archive.filter((a) => a.favorite);
  return state.data.archive;
}

function neighbourOf(id) {
  const list = currentList();
  const index = list.findIndex((a) => a.id === id);
  if (index === -1) return null;
  const next = list[index + 1] || list[index - 1];
  return next ? next.id : null;
}

function isWide() {
  return window.matchMedia('(min-width: 1100px)').matches;
}

function step(delta) {
  const list = currentList();
  if (!list.length) return;
  const index = list.findIndex((a) => a.id === state.openId);
  const next = index === -1 ? 0 : Math.max(0, Math.min(list.length - 1, index + delta));
  openArticle(list[next].id);
}

/* ------------------------------------------------------------------ load */

async function load({ quiet = false, keepFocus = null } = {}) {
  const params = new URLSearchParams({
    dayStart: localDayStart(),
    filter: state.filter,
    q: state.surface === 'archive' || state.surface === 'starred' ? state.query : ''
  });

  const data = await api(`/api/feed?${params}`);
  state.data = data;
  render();

  if (keepFocus === 'search') {
    const input = $('#surface input[type="search"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  if (!quiet) window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- sheets */

function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }

async function submitAdd(event) {
  event.preventDefault();
  const button = $('#add-submit');
  const notice = $('#add-notice');
  const url = $('#add-url').value.trim();
  const text = $('#add-text').value.trim();

  if (!url && !text) return;

  button.disabled = true;
  button.textContent = 'Fetching…';
  notice.hidden = true;

  try {
    const result = await api('/api/articles', {
      method: 'POST',
      body: JSON.stringify({
        url,
        text,
        title: $('#add-title').value.trim(),
        source: $('#add-source').value.trim()
      })
    });

    if (result.status === 409) {
      // The duplicate notice sits on the primary path, not in an error state.
      notice.textContent = '';
      notice.append(el('span', null,
        `Already here — "${result.article.title}" (${result.article.status}). Open it instead?`));
      const open = el('button', 'link-btn', 'Open it');
      open.type = 'button';
      open.addEventListener('click', () => {
        closeSheet('#add-sheet');
        openArticle(result.article.id);
      });
      notice.append(open);
      notice.hidden = false;
      return;
    }

    if (result.fetchError) {
      toast('Added — but the page could not be read');
      notice.textContent = `${result.fetchError}. The item is saved with its URL; paste the text to fill it in.`;
      notice.hidden = false;
      $('#paste-fields').hidden = false;
      $('#add-title').value = result.article.title;
      return;
    }

    closeSheet('#add-sheet');
    $('#add-form').reset();
    $('#paste-fields').hidden = true;
    toast('Added to today');
    state.surface = 'today';
    await load();
  } catch (err) {
    notice.textContent = err.message;
    notice.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Fetch and add';
  }
}

async function submitSettings(event) {
  event.preventDefault();
  const value = Number($('#lapse-input').value);
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ lapseWindowDays: value }) });
  closeSheet('#settings-sheet');
  toast('Saved');
  await load({ quiet: true });
}

/* ------------------------------------------------------------------ gate */

function showGate() {
  $('#gate').hidden = false;
  $('#app').hidden = true;
}

async function submitGate(event) {
  event.preventDefault();
  const error = $('#gate-error');
  error.hidden = true;
  try {
    await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ passphrase: $('#gate-input').value })
    });
    $('#gate').hidden = true;
    $('#app').hidden = false;
    await load();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
}

/* ------------------------------------------------------------------ wire */

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action], [data-surface]');
  if (!target) return;

  if (target.dataset.surface) {
    state.surface = target.dataset.surface;
    state.query = '';
    load();
    return;
  }

  switch (target.dataset.action) {
    case 'open-add': openSheet('#add-sheet'); $('#add-url').focus(); break;
    case 'close-add': closeSheet('#add-sheet'); break;
    case 'toggle-paste': $('#paste-fields').hidden = !$('#paste-fields').hidden; break;
    case 'close-reader': closeReader(); break;
    case 'open-settings':
      $('#lapse-input').value = state.data.lapseWindowDays;
      openSheet('#settings-sheet');
      break;
    case 'close-settings': closeSheet('#settings-sheet'); break;
    case 'sign-out':
      api('/api/session', { method: 'DELETE' }).then(showGate);
      break;
  }
});

$$('.sheet-scrim').forEach((scrim) => {
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) scrim.hidden = true;
  });
});

$('#add-form').addEventListener('submit', submitAdd);
$('#settings-form').addEventListener('submit', submitSettings);
$('#gate-form').addEventListener('submit', submitGate);

// Keyboard triage. Desktop only in practice, and never while typing.
document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (event.key === 'Escape') {
    if (!$('#add-sheet').hidden) return closeSheet('#add-sheet');
    if (!$('#settings-sheet').hidden) return closeSheet('#settings-sheet');
    if (state.article) return closeReader();
  }

  if (!state.article || state.article.status !== 'new') {
    if (event.key === 'j') step(1);
    if (event.key === 'l') step(-1);
    return;
  }

  const id = state.article.id;
  if (event.key === 'k') { event.preventDefault(); resolve(id, 'kept', false); }
  if (event.key === 's') { event.preventDefault(); resolve(id, 'kept', true); }
  if (event.key === 'x') { event.preventDefault(); resolve(id, 'dismissed', false); }
  if (event.key === 'j') { event.preventDefault(); step(1); }
  if (event.key === 'l') { event.preventDefault(); step(-1); }
});

// Share-sheet / bookmarklet target: /?url=… lands straight in the add sheet.
function handleShareTarget() {
  const shared = new URLSearchParams(location.search).get('url');
  if (!shared) return;
  history.replaceState(null, '', '/');
  openSheet('#add-sheet');
  $('#add-url').value = shared;
}

async function boot() {
  const { authed } = await api('/api/session');
  if (!authed) return showGate();

  $('#gate').hidden = true;
  $('#app').hidden = false;
  await load();
  handleShareTarget();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot().catch(() => showGate());
