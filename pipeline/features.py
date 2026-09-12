"""Stage 1 of the V2 ladder: features derived by counting.

No AI call, no embeddings, no labels required -- which is the point. Measured
against the live archive there is one keep and zero dismissals, so Stages 2 and
4 have nothing to learn from yet. These are the features Stage 4 will train on
when there are labels, so computing them now is not throwaway work; it is the
only part of the pipeline that is not blocked.

Every signal here is a *proxy*, and each one is written down with what it is
proxying for and what would disprove it. From the design report, §8 Stage 1:

    Specificity density   numbers, dates, entities per 100 words
    Primary-source links  links to papers and filings vs to other news
    Hype ratio            "revolutionary", "could", "may" vs concrete claims
    Original vs aggregation   does it cite another news article as its source
    Structural markers    methodology sections, tables, figures

Two rules carried from §8 and enforced here rather than remembered:

  * The score sorts, it never filters. Nothing in this module drops an article.
  * The score must be explainable in one line -- `explain()` produces that
    line, and it is stored beside the number. An unexplained score gets
    ignored within a week, because when it is wrong you cannot tell whether it
    is wrong this time or wrong generally.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

# Bumped whenever a signal changes meaning. The Worker keys features on
# (article_id, version), so a bump re-computes the corpus rather than
# overwriting scores that were produced by different arithmetic.
VERSION = "stage1-2026.09.12"

# ---------------------------------------------------------------- vocabulary

# Words that promise significance instead of stating it. Deliberately small and
# boring: a long list looks thorough and mostly adds noise, and every entry
# here should be one you would defend individually.
HYPE = (
    "revolutionary", "game-changing", "game changing", "groundbreaking",
    "breakthrough", "disruptive", "unprecedented", "paradigm shift",
    "transformative", "supercharge", "skyrocket", "seismic", "explosive",
    "stunning", "mind-blowing", "insane", "crazy", "massive leap",
)

# Hedges. Not bad in themselves -- honest writing hedges -- but a piece that is
# mostly hedge and no number is usually speculation about a thing rather than
# a report of it.
HEDGE = (
    "could", "may", "might", "reportedly", "rumored", "rumoured",
    "is said to", "appears to", "suggests that", "potentially", "possibly",
    "expected to", "poised to", "set to",
)

# Hosts whose presence in a link means the piece is pointing at a primary
# source rather than at other coverage.
PRIMARY_HOSTS = (
    "arxiv.org", "doi.org", "acm.org", "ieee.org", "nature.com",
    "science.org", "pubmed.ncbi.nlm.nih.gov", "biorxiv.org", "ssrn.com",
    "openreview.net", "github.com", "huggingface.co", "sec.gov",
    "federalregister.gov", "europa.eu", "nist.gov", "who.int",
)
PRIMARY_SUFFIXES = (".gov", ".edu", ".int")

# Hosts that are other people's reporting. A piece whose only outbound links
# are these is commenting on coverage rather than on the thing itself.
NEWS_HOSTS = (
    "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com",
    "bloomberg.com", "reuters.com", "nytimes.com", "wsj.com", "ft.com",
    "cnbc.com", "businessinsider.com", "venturebeat.com", "axios.com",
    "theinformation.com", "engadget.com", "gizmodo.com", "zdnet.com",
    "technologyreview.com", "theguardian.com", "bbc.co.uk", "bbc.com",
)

DATE_PATTERNS = (
    r"\b\d{4}-\d{2}-\d{2}\b",
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b",
    r"\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b",
    r"\b(?:19|20)\d{2}\b",
)

STRUCTURE_MARKERS = (
    "methodology", "method", "dataset", "experimental setup", "ablation",
    "we evaluate", "we train", "baseline", "limitations", "related work",
    "appendix", "reproduc",
)

_WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*")
_SENTENCE = re.compile(r"[^.!?]+[.!?]*")
_NUMBER = re.compile(r"(?<![\w-])\d[\d,.]*\s*(?:%|percent|bn|billion|million|k\b)?")
_DATE = re.compile("|".join(DATE_PATTERNS), re.I)
_HREF = re.compile(r"""<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']""", re.I)
_TAG = re.compile(r"<(table|figure|h2|h3|blockquote|code|pre)\b", re.I)

# A crude stand-in for named-entity recognition: capitalised runs that are not
# sentence-initial. Real NER wants spaCy, which is a few hundred megabytes and
# a Docker image; this is the cheap version, and Stage 5's blind evaluation is
# what decides whether the feature earns the upgrade.
_ENTITY = re.compile(r"(?<![.!?]\s)(?<!^)\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b", re.M)


@dataclass
class Features:
    """The signals, plus the score and the one-line reason."""

    words: int = 0
    sentences: int = 0
    numbers_per_100w: float = 0.0
    dates_per_100w: float = 0.0
    entities_per_100w: float = 0.0
    hype_per_1000w: float = 0.0
    hedge_per_1000w: float = 0.0
    links_total: int = 0
    links_primary: int = 0
    links_news: int = 0
    primary_link_ratio: float = 0.0
    structure_markers: int = 0
    structural_tags: int = 0
    avg_sentence_words: float = 0.0
    score: float = 0.0
    explain: str = ""
    notes: list[str] = field(default_factory=list)

    def payload(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d.pop("score", None)
        d.pop("explain", None)
        return d


def _per(count: int, words: int, unit: int) -> float:
    if words <= 0:
        return 0.0
    return round(count * unit / words, 3)


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def _is_primary(host: str) -> bool:
    if not host:
        return False
    if any(host == h or host.endswith("." + h) for h in PRIMARY_HOSTS):
        return True
    return host.endswith(PRIMARY_SUFFIXES)


def _is_news(host: str) -> bool:
    return bool(host) and any(host == h or host.endswith("." + h) for h in NEWS_HOSTS)


def count_phrases(text_lower: str, phrases: tuple[str, ...]) -> int:
    """Phrase occurrences, counted on word boundaries where the phrase allows.

    Substring counting would score "maybe" as a hedge because it contains
    "may", which is exactly the kind of quiet wrongness that makes a whole
    feature untrustworthy.
    """
    total = 0
    for phrase in phrases:
        pattern = r"\b" + re.escape(phrase).replace(r"\ ", r"\s+") + r"\b"
        total += len(re.findall(pattern, text_lower))
    return total


def extract(body_text: str, raw_html: str | None = None, source_host: str = "") -> Features:
    """Compute the signals for one article.

    `raw_html` is optional: link and structural analysis need it, and roughly
    one article in six has no capture (a 403, a paste, a page over the size
    cap). Those get text-only features and a note saying so, rather than zeros
    that would read as "no links" instead of "not known".
    """
    text = (body_text or "").strip()
    f = Features()
    if not text:
        f.explain = "no text to analyse"
        f.notes.append("empty body")
        return f

    lower = text.lower()
    words = _WORD.findall(text)
    f.words = len(words)
    sentences = [s for s in _SENTENCE.findall(text) if s.strip()]
    f.sentences = len(sentences)
    f.avg_sentence_words = round(f.words / f.sentences, 2) if f.sentences else 0.0

    f.numbers_per_100w = _per(len(_NUMBER.findall(text)), f.words, 100)
    f.dates_per_100w = _per(len(_DATE.findall(text)), f.words, 100)
    f.entities_per_100w = _per(len(set(_ENTITY.findall(text))), f.words, 100)
    f.hype_per_1000w = _per(count_phrases(lower, HYPE), f.words, 1000)
    f.hedge_per_1000w = _per(count_phrases(lower, HEDGE), f.words, 1000)
    f.structure_markers = count_phrases(lower, STRUCTURE_MARKERS)

    if raw_html:
        hosts = [_host(h) for h in _HREF.findall(raw_html)]
        # Self-links are navigation, not citation.
        outbound = [h for h in hosts if h and h != source_host]
        f.links_total = len(outbound)
        f.links_primary = sum(1 for h in outbound if _is_primary(h))
        f.links_news = sum(1 for h in outbound if _is_news(h))
        cited = f.links_primary + f.links_news
        f.primary_link_ratio = round(f.links_primary / cited, 3) if cited else 0.0
        f.structural_tags = len(_TAG.findall(raw_html))
    else:
        f.notes.append("no raw capture; link and structure signals unavailable")

    f.score, f.explain = score(f, has_html=bool(raw_html))
    return f


def score(f: Features, has_html: bool = True) -> tuple[float, str]:
    """A transparent 0-100 score, and the one line that explains it.

    Weights are stated, not learned. They are a starting point and they are
    almost certainly wrong in detail -- that is what Stage 2's keep-rate
    baseline and Stage 5's blind evaluation are for. What matters now is that
    the number is reproducible and that its reason is legible.
    """
    parts: list[tuple[str, float]] = []

    # Concreteness. Numbers and dates are the cheapest evidence that a piece is
    # reporting something rather than gesturing at it.
    concrete = min(f.numbers_per_100w / 3.0, 1.0) * 25
    parts.append(("specific", concrete))

    entities = min(f.entities_per_100w / 6.0, 1.0) * 10
    parts.append(("named", entities))

    # Hype counts against, hedging counts against more mildly.
    hype_penalty = -min(f.hype_per_1000w / 2.0, 1.0) * 20
    hedge_penalty = -min(f.hedge_per_1000w / 12.0, 1.0) * 10
    parts.append(("hype", hype_penalty))
    parts.append(("hedged", hedge_penalty))

    if has_html:
        # Pointing at papers and filings rather than at other coverage.
        primary = f.primary_link_ratio * 25
        parts.append(("primary-sourced", primary))
        depth = min(f.structural_tags / 12.0, 1.0) * 5
        parts.append(("structured", depth))
    else:
        # Absent evidence is not evidence of absence: without a capture the
        # link signals are unknown, so the score is rebalanced onto what is
        # known rather than silently penalising the article for a failed fetch.
        parts.append(("no-capture", 15.0))

    method = min(f.structure_markers / 4.0, 1.0) * 15
    parts.append(("methodical", method))

    total = 50 + sum(v for _, v in parts) - 25
    total = max(0.0, min(100.0, total))

    # The explanation names the two strongest contributors in either direction,
    # which is what makes a wrong score debuggable rather than merely wrong.
    ranked = sorted(parts, key=lambda kv: abs(kv[1]), reverse=True)
    reasons = [f"{name} {value:+.0f}" for name, value in ranked[:3] if abs(value) >= 1]
    line = ", ".join(reasons) if reasons else "nothing distinctive"
    if not has_html:
        line += "; no raw capture"
    return round(total, 1), line


def feature_row(article: dict[str, Any], raw_html: str | None) -> dict[str, Any]:
    """The payload shape the Worker's /api/pipeline/features route expects."""
    f = extract(
        article.get("body_text") or "",
        raw_html,
        source_host=_host(article.get("url") or ""),
    )
    return {
        "article_id": article["id"],
        "score": f.score,
        "explain": f.explain,
        "payload": f.payload(),
    }
