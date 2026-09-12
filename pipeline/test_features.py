"""Tests for Stage 1 feature extraction.

The weights in `score()` are stated, not learned, and the absolute numbers they
produce are arbitrary -- asserting them would pin down a decision nobody has
justified yet. So these tests assert *ordering* and *direction*: a paper should
out-score a hype post, hedging should cost, a missing capture should not be
punished as though it were a missing citation.

Run: python -m pytest pipeline/ -q
"""

from __future__ import annotations

import pytest

from features import (
    VERSION,
    count_phrases,
    extract,
    feature_row,
)

# --------------------------------------------------------------- fixtures
#
# Three real article shapes rather than lorem ipsum, because every signal here
# is about the texture of prose and synthetic text has none.

PAPER = """
We evaluate a 7B parameter model on 12 benchmarks, training for 340,000 steps
on 2.1 trillion tokens. On 2026-02-03 we released the checkpoints.

Methodology. Each run used 64 A100 GPUs for 18 hours. We report mean and
standard deviation over 5 seeds. The baseline reaches 61.4% accuracy; our
method reaches 68.9%, an improvement of 7.5 points.

Limitations. The dataset covers English only, and the ablation in Appendix B
shows the gain narrows to 2.1 points without the retrieval component.
"""

PAPER_HTML = """
<html><body><article>
<p>We evaluate a 7B parameter model.</p>
<table><tr><td>61.4</td></tr></table>
<figure><img src="chart.png"></figure>
<h2>Methodology</h2>
<a href="https://arxiv.org/abs/2401.00001">prior work</a>
<a href="https://doi.org/10.1000/xyz">the dataset paper</a>
<a href="https://github.com/example/repo">code</a>
<a href="https://www.nature.com/articles/x">related result</a>
</article></body></html>
"""

HYPE = """
This groundbreaking, revolutionary breakthrough could change everything. The
unprecedented model may potentially disrupt the industry, and insiders say it
is poised to transform how we work. Sources reportedly suggest that the
stunning results might arrive soon, and the game-changing implications are
expected to be massive.
"""

HYPE_HTML = """
<html><body><article>
<p>This groundbreaking breakthrough could change everything.</p>
<a href="https://techcrunch.com/2026/01/01/a-story">TechCrunch reported</a>
<a href="https://www.theverge.com/2026/01/02/b-story">The Verge said</a>
</article></body></html>
"""

PLAIN = """
The company announced a new product on Tuesday. It will be available in three
regions at launch, with pricing starting at 20 dollars a month. The product
replaces an older tool that the company retired in 2025.
"""


def features_for(text, html=None, host=""):
    return extract(text, html, source_host=host)


# ------------------------------------------------------------------ counting


def test_counts_words_and_sentences():
    f = features_for("One two three. Four five.")
    assert f.words == 5
    assert f.sentences == 2
    assert f.avg_sentence_words == pytest.approx(2.5)


def test_empty_text_is_handled_rather_than_crashing():
    f = features_for("")
    assert f.words == 0
    assert f.score == 0
    assert "no text" in f.explain
    # An article with no body is a real state -- a failed fetch that was never
    # pasted in -- not an error.


def test_phrase_counting_respects_word_boundaries():
    # The bug this guards: "maybe" contains "may", and substring counting would
    # score it as a hedge. One quietly wrong signal discredits the whole score.
    assert count_phrases("maybe maybe maybe", ("may",)) == 0
    assert count_phrases("it may work", ("may",)) == 1
    assert count_phrases("it is said to work", ("is said to",)) == 1


def test_numbers_and_dates_are_found_in_real_prose():
    f = features_for(PAPER)
    assert f.numbers_per_100w > 3
    assert f.dates_per_100w > 0


def test_entity_proxy_ignores_sentence_openers():
    # "The" starting a sentence is not a named entity. The proxy is crude, but
    # it should not be crude in this particular way.
    f = features_for("The cat sat. The dog stood.")
    assert f.entities_per_100w == 0


# ------------------------------------------------------------------- links


def test_primary_and_news_links_are_told_apart():
    f = features_for(PAPER, PAPER_HTML, host="example.org")
    assert f.links_primary >= 4
    assert f.links_news == 0
    assert f.primary_link_ratio == 1.0

    g = features_for(HYPE, HYPE_HTML, host="example.org")
    assert g.links_news >= 2
    assert g.links_primary == 0
    assert g.primary_link_ratio == 0.0


def test_self_links_are_not_citations():
    html = '<a href="https://example.com/other">more</a><a href="https://arxiv.org/abs/1">paper</a>'
    f = features_for(PLAIN, html, host="example.com")
    assert f.links_total == 1
    assert f.links_primary == 1


def test_government_and_academic_domains_count_as_primary():
    html = '<a href="https://www.sec.gov/filing">filing</a><a href="https://mit.edu/paper">paper</a>'
    f = features_for(PLAIN, html, host="example.com")
    assert f.links_primary == 2


# ------------------------------------------------------------------ ordering
#
# The assertions that actually matter.


def test_a_paper_outscores_a_hype_post():
    paper = features_for(PAPER, PAPER_HTML, host="example.org")
    hype = features_for(HYPE, HYPE_HTML, host="example.org")
    assert paper.score > hype.score
    # And by a margin that is not noise.
    assert paper.score - hype.score > 20


def test_hype_and_hedging_cost_something():
    plain = features_for(PLAIN)
    hyped = features_for(PLAIN + " " + HYPE)
    assert hyped.score < plain.score


def test_methodology_language_helps():
    plain = features_for(PLAIN)
    methodical = features_for(PLAIN + " Methodology. We evaluate the baseline dataset. Limitations apply.")
    assert methodical.score >= plain.score


def test_a_missing_capture_is_not_punished_as_a_missing_citation():
    # Roughly one article in six has no raw capture -- a 403, a paste, a page
    # over the size cap. Scoring those as "zero primary sources" would rank a
    # good article down for a failed fetch, which is a judgement about our
    # plumbing rather than about the writing.
    with_html = features_for(PAPER, PAPER_HTML, host="example.org")
    without = features_for(PAPER)
    assert abs(with_html.score - without.score) < 20
    assert "no raw capture" in without.explain
    assert without.notes


# ------------------------------------------------------------------- explain


def test_every_score_carries_a_reason():
    for text, html in ((PAPER, PAPER_HTML), (HYPE, HYPE_HTML), (PLAIN, None)):
        f = features_for(text, html, host="example.org")
        assert f.explain
        assert len(f.explain) < 200


def test_the_reason_names_what_drove_it():
    hype = features_for(HYPE, HYPE_HTML, host="example.org")
    assert "hype" in hype.explain or "hedged" in hype.explain


def test_score_stays_within_bounds():
    for text, html in ((PAPER, PAPER_HTML), (HYPE, HYPE_HTML), (PLAIN, None), ("", None)):
        f = features_for(text, html)
        assert 0 <= f.score <= 100


# -------------------------------------------------------------- the payload


def test_feature_row_matches_what_the_worker_expects():
    row = feature_row({"id": 42, "body_text": PAPER, "url": "https://example.org/a"}, PAPER_HTML)
    assert row["article_id"] == 42
    assert isinstance(row["score"], float)
    assert isinstance(row["explain"], str)
    assert "numbers_per_100w" in row["payload"]
    # score and explain are columns of their own; duplicating them inside the
    # payload would give two places for one fact to be wrong.
    assert "score" not in row["payload"]
    assert "explain" not in row["payload"]


def test_version_is_stated():
    assert VERSION.startswith("stage1-")
