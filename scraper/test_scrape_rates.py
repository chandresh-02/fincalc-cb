"""Test scrape_rates.py parsing logic against saved real-page fixtures
(positive tests) and deliberately broken/garbled content (negative tests,
proving the safety net rejects bad data instead of publishing it)."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from scrape_rates import parse_repo_rate, parse_scheme_rates, build_output

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")

pass_count = 0
fail_count = 0


def check(label, cond):
    global pass_count, fail_count
    print(("PASS " if cond else "FAIL ") + label)
    if cond:
        pass_count += 1
    else:
        fail_count += 1


def read_fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


# ---- Positive tests: real fetched page content ----
rbi_text = read_fixture("rbi_homepage_sample.txt")
repo = parse_repo_rate(rbi_text)
check(f"RBI fixture: repo rate parsed as 5.25 (got {repo})", repo == 5.25)

post_text = read_fixture("indiapost_saving_sample.txt")
schemes = parse_scheme_rates(post_text)
check(f"India Post fixture: ppf == 7.1 (got {schemes.get('ppf')})", schemes.get("ppf") == 7.1)
check(f"India Post fixture: nsc == 7.7 (got {schemes.get('nsc')})", schemes.get("nsc") == 7.7)
check(f"India Post fixture: scss == 8.2 (got {schemes.get('scss')})", schemes.get("scss") == 8.2)
check(f"India Post fixture: ssy == 8.2 (got {schemes.get('ssy')})", schemes.get("ssy") == 8.2)
check(f"India Post fixture: pomis == 7.4 (got {schemes.get('pomis')})", schemes.get("pomis") == 7.4)
check(f"India Post fixture: kvp == 7.5 (got {schemes.get('kvp')})", schemes.get("kvp") == 7.5)
check(f"India Post fixture: kvpMonths == 115 (got {schemes.get('kvpMonths')})", schemes.get("kvpMonths") == 115)
check("India Post fixture: exactly 7 fields found", len(schemes) == 7)

# ---- Negative tests: broken / changed pages must NOT produce garbage ----
broken_text = read_fixture("broken_page_sample.txt")
check("Broken page: repo rate parse returns None", parse_repo_rate(broken_text) is None)
check("Broken page: scheme rates parse returns empty dict", parse_scheme_rates(broken_text) == {})

garbled_kvp = read_fixture("garbled_kvp_sample.txt")
kvp_result = parse_scheme_rates(garbled_kvp)
check("Garbled KVP page: no kvp rate extracted from a reference number", "kvp" not in kvp_result)
check("Garbled KVP page: no kvpMonths extracted", "kvpMonths" not in kvp_result)

# ---- Sanity-bounds rejection: a value outside plausible range is rejected ----
out_of_range_text = "Policy Repo Rate : 47.00%"
check("Out-of-range repo rate (47%) is rejected", parse_repo_rate(out_of_range_text) is None)

# ---- build_output merge behaviour: partial failure preserves old values ----
previous = {
    "repoRate": 5.25, "ppf": 7.1, "nsc": 7.7, "kvp": 7.5, "kvpMonths": 115,
    "ssy": 8.2, "scss": 8.2, "pomis": 7.4,
    "repoLastVerified": "2026-08-01T00:00:00+00:00",
    "schemesLastVerified": "2026-08-01T00:00:00+00:00"
}
# Simulate: repo rate scrape failed this run, schemes succeeded with a changed PPF rate
merged = build_output(previous, None, {"ppf": 7.2, "nsc": 7.7, "kvp": 7.5, "kvpMonths": 115,
                                        "ssy": 8.2, "scss": 8.2, "pomis": 7.4},
                       repo_ok=False, schemes_found=["ppf", "nsc", "kvp", "kvpMonths", "ssy", "scss", "pomis"])
check("Partial-failure merge: stale repoRate preserved from previous run", merged["repoRate"] == 5.25)
check("Partial-failure merge: repoLastVerified NOT bumped (still stale)",
      merged["repoLastVerified"] == "2026-08-01T00:00:00+00:00")
check("Partial-failure merge: updated ppf value applied", merged["ppf"] == 7.2)
check("Partial-failure merge: schemesLastVerified bumped to now",
      merged["schemesLastVerified"] != "2026-08-01T00:00:00+00:00")
check("Partial-failure merge: status.repoRateOk is False", merged["status"]["repoRateOk"] is False)

print(f"\n{pass_count} passed, {fail_count} failed")
sys.exit(1 if fail_count else 0)
