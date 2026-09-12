"""Pull work, compute Stage 1 features, push them back.

Runs nightly in GitHub Actions. Not in a Worker: the feature pass loops over
megabytes of text, and the free plan allows 10ms of CPU per invocation -- the
lesson V1-32 learned expensively, where a base64 decode loop measured 14ms and
`wrangler dev` could never have revealed it.

    python pipeline/client.py --base https://neatinfo.example.workers.dev
    python pipeline/client.py --dry-run          # compute, print, send nothing

Auth is the same x-discover-key header the candidate ingest uses, from
NEATINFO_DISCOVER_KEY. One machine credential rather than two.

Resumable and idempotent by construction: the Worker hands out only articles
that have no features at this version, so an interrupted run leaves the rest
outstanding and a re-run is a no-op once everything is computed. It will be
interrupted -- Actions runners are killed, networks fail -- and that must be
ordinary rather than a problem.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

from features import VERSION, feature_row


def load_dotenv(path: str) -> dict[str, str]:
    """Read app/.env, the way scripts/seed-articles.mjs does.

    In Actions the values come from repo secrets and this finds nothing, which
    is correct -- .env is gitignored and never reaches a runner. Locally it
    means the key is typed once into a file rather than onto a command line,
    where it would land in shell history and in the process list.
    """
    out: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip()] = value
    return out

# Cloudflare's edge rejects urllib's default "Python-urllib/3.x" with a 403
# and error 1010 -- a browser-signature block, before the request ever reaches
# the Worker. Found by running this against production rather than localhost,
# which is the only place it happens. scripts/gather-candidates.mjs sets a UA
# for the same reason.
USER_AGENT = "NeatInfo-pipeline/1.0 (personal reading tracker; single user)"

BATCH = 25
# Raw HTML is fetched per article and is the slow part; be polite to our own
# Worker rather than opening fifty sockets at once.
PAUSE_SECONDS = 0.2


class ApiError(RuntimeError):
    pass


def request(url: str, key: str, method: str = "GET", body: dict | None = None, accept_404: bool = False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-discover-key", key)
    req.add_header("user-agent", USER_AGENT)
    req.add_header("accept", "application/json, */*")
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            if res.headers.get("content-type", "").startswith("application/json"):
                return json.loads(raw)
            return raw
    except urllib.error.HTTPError as err:
        if accept_404 and err.code == 404:
            return None
        detail = err.read().decode(errors="replace")[:200]
        raise ApiError(f"{method} {url} -> HTTP {err.code} {detail}") from err
    except urllib.error.URLError as err:
        raise ApiError(f"{method} {url} -> {err.reason}") from err


def fetch_raw_html(base: str, key: str, article_id: int) -> str | None:
    """The raw capture, or None.

    A 404 here is ordinary: a pasted article, a fetch that failed, a page over
    the 2 MB cap. Roughly one in six. Features degrade to text-only rather than
    the article being skipped.
    """
    body = request(f"{base}/api/articles/{article_id}/raw", key, accept_404=True)
    if body is None:
        return None
    return body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body)


def run(base: str, key: str, dry_run: bool = False, limit: int | None = None) -> int:
    base = base.rstrip("/")
    done = 0

    while True:
        work = request(f"{base}/api/pipeline/work?version={VERSION}&limit={BATCH}", key)
        articles = work.get("articles") or []
        if not articles:
            print(f"Nothing left to do at {VERSION}.")
            break

        print(f"{len(articles)} article(s) this batch, {work.get('remaining', 0)} outstanding.")

        rows = []
        for article in articles:
            html = None
            if article.get("raw_html_key"):
                try:
                    html = fetch_raw_html(base, key, article["id"])
                except ApiError as err:
                    # One unreadable capture must not end the run.
                    print(f"  #{article['id']}: raw fetch failed ({err}); text-only")
            row = feature_row(article, html)
            rows.append(row)
            title = (article.get("title") or "")[:48]
            print(f"  #{article['id']:>4} {row['score']:>5.1f}  {title}  [{row['explain']}]")
            time.sleep(PAUSE_SECONDS)

        done += len(rows)

        if dry_run:
            print("  (dry run -- nothing sent)")
        else:
            result = request(
                f"{base}/api/pipeline/features", key, method="POST",
                body={"version": VERSION, "features": rows},
            )
            print(f"  stored {result.get('accepted', 0)}")

        if limit and done >= limit:
            print(f"Stopping at --limit {limit}.")
            break
        if dry_run:
            # Without writes the work queue never shrinks, so one batch is all
            # a dry run can honestly do.
            break

    return done


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute Stage 1 features for NeatInfo articles.")
    parser.add_argument("--base", default=os.environ.get("NEATINFO_API_URL", "http://localhost:8787"))
    parser.add_argument("--dry-run", action="store_true", help="compute and print, send nothing")
    parser.add_argument("--limit", type=int, default=None, help="stop after this many articles")
    args = parser.parse_args()

    # Environment first, so a one-off run against another instance needs no
    # edit; then app/.env for everyday local use.
    env_file = load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
    key = os.environ.get("NEATINFO_DISCOVER_KEY") or env_file.get("NEATINFO_DISCOVER_KEY") or env_file.get("DISCOVER_KEY", "")
    if not key:
        print(
            "No pipeline key. Set NEATINFO_DISCOVER_KEY, or put it in app/.env.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    if args.base == parser.get_default("base"):
        args.base = env_file.get("NEATINFO_BASE") or args.base

    started = time.time()
    try:
        done = run(args.base, key, dry_run=args.dry_run, limit=args.limit)
    except ApiError as err:
        print(str(err), file=sys.stderr)
        raise SystemExit(1) from err
    print(f"\n{done} article(s) in {time.time() - started:.1f}s at version {VERSION}.")


if __name__ == "__main__":
    main()
