const DAY_MS = 86400000;

export function daysSince(iso) {
  const then = new Date(iso);
  then.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((now - then) / DAY_MS);
}

export function readMinutes(article) {
  if (!article.word_count) return null;
  return Math.max(1, Math.round(article.word_count / 230));
}

export function metaLine(article) {
  const parts = [article.source];
  const when = article.published_at || article.added_at;
  if (when) {
    const d = new Date(when);
    if (!Number.isNaN(d.getTime())) {
      parts.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    }
  }
  const mins = readMinutes(article);
  if (mins) parts.push(`${mins} min`);
  return parts.join(' · ');
}

export function ageLabel(article) {
  const days = daysSince(article.added_at);
  if (days <= 0) return 'added today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

export function lapseInfo(article, lapseWindowDays) {
  const days = daysSince(article.added_at);
  if (days <= 0) return null;
  const left = lapseWindowDays - days;
  return {
    label: left <= 0 ? 'lapsing' : `lapses in ${left}d`,
    urgent: left <= 4,
  };
}
