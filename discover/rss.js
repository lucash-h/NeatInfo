// Minimal RSS/Atom parser using regex. No npm dependency.
// Extracts title, link, description, pubDate from each <item> or <entry>.

export async function parseRss(url, sourceName) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'NeatInfo/2.0 (discovery bot; +personal)' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const xml = await res.text();
  const items = [];

  // RSS <item> blocks
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of rssItems) {
    items.push(parseBlock(block, sourceName));
  }

  // Atom <entry> blocks (if no RSS items found)
  if (!items.length) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const block of atomEntries) {
      items.push(parseAtomEntry(block, sourceName));
    }
  }

  return items.filter(i => i.url && i.title);
}

function parseBlock(block, sourceName) {
  return {
    title: extractTag(block, 'title'),
    url: extractTag(block, 'link') || extractGuid(block),
    summary: stripHtml(extractTag(block, 'description') || '').slice(0, 500),
    source: sourceName,
    author: extractTag(block, 'dc:creator') || extractTag(block, 'author'),
    published_at: parseDate(extractTag(block, 'pubDate') || extractTag(block, 'dc:date')),
  };
}

function parseAtomEntry(block, sourceName) {
  const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return {
    title: extractTag(block, 'title'),
    url: linkMatch ? linkMatch[1] : null,
    summary: stripHtml(extractTag(block, 'summary') || extractTag(block, 'content') || '').slice(0, 500),
    source: sourceName,
    author: extractTag(block, 'name'),
    published_at: parseDate(extractTag(block, 'published') || extractTag(block, 'updated')),
  };
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractGuid(xml) {
  const m = xml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
  if (!m) return null;
  const val = m[1].trim();
  return val.startsWith('http') ? val : null;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
