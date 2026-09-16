"""
FinCalc CB — rate scraper.

Pulls the current RBI repo rate and the current small-savings scheme rates
from two official government pages and writes rates.json. Designed to run
daily via GitHub Actions (see .github/workflows/update-rates.yml).

Sources (both plain HTML, no JS rendering needed):
  - RBI homepage "Current Rates" widget (Policy Repo Rate)
  - India Post "Saving Schemes" page (PPF, NSC, KVP, SCSS, SSY, POMIS)

Design principle: never let a broken/changed page silently corrupt the
published rates. Every extracted value is range-checked before being
accepted; if a value is missing or out of a sane range, that field is
left out of the update and the previous known-good value in rates.json
is preserved (see main() below).
"""
import re
import json
import sys
from datetime import datetime, timezone

RBI_URL = "https://www.rbi.org.in/Home.aspx/Home.aspx/home.aspx"
INDIA_POST_URL = "https://app.indiapost.gov.in/banking-services/saving"

USER_AGENT = (
    "FinCalcCB-RateUpdater/1.0 (+https://github.com/; daily automated check "
    "of publicly published rates for an offline financial calculator app; "
    "contact via repo issues)"
)

BOUNDS = {
    "repoRate": (2.0, 12.0),
    "ppf": (4.0, 12.0),
    "nsc": (4.0, 12.0),
    "kvp": (4.0, 12.0),
    "ssy": (4.0, 12.0),
    "scss": (4.0, 12.0),
    "pomis": (4.0, 12.0),
}
KVP_MONTHS_BOUNDS = (80, 140)


def html_to_text(html):
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style"]):
            tag.decompose()
        return soup.get_text(separator="\n")
    except ImportError:
        text = re.sub(r"<[^>]+>", "\n", html)
        return text


def _number_near(text, heading_pattern, window):
    m = re.search(heading_pattern, text, re.IGNORECASE)
    if not m:
        return None
    segment = text[m.end(): m.end() + window]
    num_m = re.search(r"(\d+\.\d+|\d+)\s*%", segment)
    if not num_m:
        return None
    try:
        return float(num_m.group(1))
    except ValueError:
        return None


def _in_bounds(value, bounds_key):
    if value is None:
        return False
    lo, hi = BOUNDS[bounds_key]
    return lo <= value <= hi


def parse_repo_rate(text):
    """Returns float or None."""
    value = _number_near(text, r"Policy Repo Rate", window=150)
    return value if _in_bounds(value, "repoRate") else None


def parse_scheme_rates(text):
    result = {}

    ppf = _number_near(text, r"Public Provident Fund Account\s*\(PPF\)", window=400)
    if _in_bounds(ppf, "ppf"):
        result["ppf"] = ppf

    nsc = _number_near(text, r"National Savings Certificates.*?\(NSC\)", window=400)
    if _in_bounds(nsc, "nsc"):
        result["nsc"] = nsc

    scss = _number_near(text, r"Senior Citizens Savings Scheme Account\s*\(SCSS\)", window=400)
    if _in_bounds(scss, "scss"):
        result["scss"] = scss

    ssy = _number_near(text, r"Sukanya Samriddhi Account\s*\(SSA\)", window=400)
    if _in_bounds(ssy, "ssy"):
        result["ssy"] = ssy

    pomis = _number_near(text, r"National Savings Monthly Income Account\s*\(MIS\)", window=400)
    if _in_bounds(pomis, "pomis"):
        result["pomis"] = pomis

    kvp_heading = re.search(r"Kisan Vikas Patra\s*\(KVP\)", text, re.IGNORECASE)
    if kvp_heading:
        segment = text[kvp_heading.end(): kvp_heading.end() + 600]
        rate_m = re.search(r"(\d+\.\d+|\d+)\s*%", segment)
        months_m = re.search(r"doubles?\s+in\s+(\d+)\s+months", segment, re.IGNORECASE)
        if rate_m:
            kvp_rate = float(rate_m.group(1))
            if _in_bounds(kvp_rate, "kvp"):
                result["kvp"] = kvp_rate
        if months_m:
            months = int(months_m.group(1))
            lo, hi = KVP_MONTHS_BOUNDS
            if lo <= months <= hi:
                result["kvpMonths"] = months

    return result


def build_output(previous, repo_rate, scheme_rates, repo_ok, schemes_found):
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = dict(previous) if previous else {}

    if repo_ok:
        out["repoRate"] = repo_rate
        out["repoLastVerified"] = now
    for key, val in scheme_rates.items():
        out[key] = val
    if scheme_rates:
        out["schemesLastVerified"] = now

    out["generatedAt"] = now
    out["sources"] = {
        "repoRate": RBI_URL,
        "schemes": INDIA_POST_URL
    }
    out["status"] = {
        "repoRateOk": repo_ok,
        "schemesFoundThisRun": sorted(scheme_rates.keys())
    }
    return out


def fetch(url, attempts=3, timeout=60, backoff_seconds=5):
    import urllib.request
    import time

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
    }
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as e:
            last_error = e
            print(f"  attempt {attempt}/{attempts} for {url} failed: {e}", file=sys.stderr)
            if attempt < attempts:
                time.sleep(backoff_seconds)
    raise last_error


def main(output_path="rates.json"):
    try:
        with open(output_path, "r", encoding="utf-8") as f:
            previous = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        previous = {}

    repo_ok = False
    repo_rate = None
    try:
        rbi_html = fetch(RBI_URL)
        repo_rate = parse_repo_rate(html_to_text(rbi_html))
        repo_ok = repo_rate is not None
    except Exception as e:
        print(f"WARNING: repo rate fetch/parse failed: {e}", file=sys.stderr)
    print(f"RBI repo rate: {'verified at ' + str(repo_rate) + '%' if repo_ok else 'FAILED — see warning above'}", file=sys.stderr)

    scheme_rates = {}
    try:
        # India Post (app.indiapost.gov.in) is confirmed, as of Sept 2026, to
        # be unreachable from GitHub Actions runners specifically — every
        # connection attempt times out at the TCP level (verified with both
        # curl and urllib, at 30s and 60s, across multiple separate runs).
        # This is not a slowness problem retries can fix, so we fail fast
        # (one short attempt) rather than burn ~3 minutes of Actions time
        # every day on a connection that's never going to succeed. If this
        # ever changes (India Post infrastructure change, GitHub egress IP
        # range change, etc.), bump attempts back up to 3 / timeout to 60.
        post_html = fetch(INDIA_POST_URL, attempts=1, timeout=15)
        scheme_rates = parse_scheme_rates(html_to_text(post_html))
    except Exception as e:
        print(f"WARNING: scheme rates fetch/parse failed: {e}", file=sys.stderr)
    print(f"India Post scheme rates: {'verified (' + str(len(scheme_rates)) + ' fields)' if scheme_rates else 'FAILED — known GitHub Actions network issue, see comment above'}", file=sys.stderr)

    expected_scheme_keys = {"ppf", "nsc", "kvp", "kvpMonths", "ssy", "scss", "pomis"}
    missing = expected_scheme_keys - set(scheme_rates.keys())
    if missing:
        print(f"WARNING: could not verify these scheme fields this run "
              f"(keeping previous values): {sorted(missing)}", file=sys.stderr)
    if not repo_ok:
        print("WARNING: could not verify repo rate this run "
              "(keeping previous value)", file=sys.stderr)

    output = build_output(previous, repo_rate, scheme_rates, repo_ok, scheme_rates.keys())

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Wrote {output_path}: {json.dumps(output, indent=2, ensure_ascii=False)}")

    if not repo_ok and not scheme_rates:
        print("ERROR: both sources failed completely.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
