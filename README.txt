FinCalc CB — Financial Calculator Suite
=========================================

WHAT THIS IS
------------
A single offline web app (HTML/CSS/JS) covering every calculator you asked for:
  - Basic / scientific calculator
  - Loan & EMI (reducing balance, fixed rate, floating/repo-linked rate with
    mid-tenure rate-change support, flat-rate comparison, full amortization
    schedule)
  - Income tax — old vs new regime, FY 2026-27 (AY 2027-28), with comparison
  - GST calculator (current GST 2.0 slabs: 0/5/18/40%, CGST/SGST/IGST split)
    and a general VAT calculator (for fuel/alcohol, which stay outside GST)
  - Savings / FD / RD calculator
  - Mutual fund SIP, lumpsum, and "required SIP for a target corpus"
  - PPF, NSC, KVP, Sukanya Samriddhi Yojana, and SCSS calculators
  - Settings screen showing live/manual RBI repo rate and scheme rates,
    with automatic daily updates once hosted on GitHub (see below) —
    manual editing always available too
  - CSV export (opens directly in Excel) and PDF export (via Print → Save as
    PDF) on every calculator
  - English, Hindi, and Gujarati

It runs entirely in the browser, on the device, with no data ever leaving
the phone/PC — there's no backend and nothing is uploaded anywhere.

IMPORTANT — HOW THIS DIFFERS FROM AN APP-STORE APP
----------------------------------------------------
This is a Progressive Web App (PWA), not a compiled native binary. That was
a deliberate choice explained at the start of our chat: I can't compile and
sign a Play Store .apk/.aab, an App Store .ipa (needs Xcode on a Mac), or a
Microsoft Store .msix from this environment. A PWA is the fastest way to get
you something that actually works, right now, on Android, iOS, and Windows —
installed to the home screen/desktop, full-screen, and usable offline. If you
later want genuine app-store listings, this same code (mainly index.html,
css/, js/) is a reasonable starting point for a Flutter/React Native wrapper,
but that's a separate, larger project with its own toolchain requirements.

HOW TO RUN IT
-------------
Easiest: double-click index.html to open it in any browser. Everything
works, except installing it as an "app" (Chrome/Safari require the page to
be served over http/https, not opened as a bare file, before they'll offer
"Add to Home Screen"/"Install").

To get the installable/offline experience:
  1. Put this whole folder somewhere it can be served over http(s). Easiest
     free options: GitHub Pages, Netlify, Vercel (drag-and-drop the folder),
     or just run a local server, e.g. from inside this folder:
         python3 -m http.server 8000
     then open http://localhost:8000 in a browser on that device.
  2. Android/Chrome: menu (⋮) → "Install app" or "Add to Home screen".
  3. iOS/Safari: Share icon → "Add to Home Screen".
  4. Windows/Edge or Chrome: click the install icon in the address bar.

Once installed, it opens full-screen like a native app and keeps working
without an internet connection (the service worker caches all the files).

UPDATING RATES
---------------
This now has two modes:

1. AUTOMATIC (once you've hosted it on GitHub — see below): a scheduled
   job checks the official RBI and India Post rate pages once a day and
   commits an updated rates.json. The app fetches that file every time it
   loads. Settings → "Automatic Rate Updates" shows whether it's working
   and when each rate was last verified.

2. MANUAL (always available, and the only option if you haven't set up
   GitHub hosting, or if you're offline): Settings → "Current Rates
   (editable)" — same as before.

If the automatic check fails for any reason (a site is down, or RBI/India
Post change their page layout and the scraper can no longer read it), the
app does NOT silently show a wrong number — it just keeps the last known
value and the Settings page will show a "last verified X days ago"
warning once it's been more than 10 days. Manual entry always overrides
whatever was auto-fetched, for that session.

SETTING UP AUTOMATIC UPDATES (GitHub Pages + Actions, free)
--------------------------------------------------------------
This whole folder is already a working GitHub repo layout — it includes
.github/workflows/update-rates.yml and scraper/scrape_rates.py, which
together do the daily check. To turn it on:

  1. Create a new repository on github.com (public or private, either
     works — https://github.com/new).
  2. Push everything in this folder to that repo (drag-and-drop upload
     on github.com works fine for a one-time push, or use git normally:
     `git init && git add . && git commit -m "FinCalc CB" && git remote
     add origin <your-repo-url> && git push -u origin main`).
  3. Enable GitHub Pages: repo Settings → Pages → "Deploy from a branch"
     → branch: main, folder: / (root) → Save. GitHub will give you a URL
     like https://<username>.github.io/<repo-name>/ — that's your
     installable app link (see "HOW TO RUN IT" above for the install
     steps on each platform).
  4. IMPORTANT — allow the workflow to commit: repo Settings → Actions →
     General → scroll to "Workflow permissions" → select "Read and write
     permissions" → Save. Without this one setting, the daily job will
     run but its commit-and-push step will fail with a permissions error
     (it can still read the site fine, it just can't save the result).
  5. Trigger it once by hand to confirm it works immediately, rather than
     waiting for the next scheduled run: Actions tab → "Update rates.json"
     (left sidebar) → "Run workflow" button → Run workflow. After ~30
     seconds, refresh the page — you should see a green checkmark, and
     rates.json's "last updated" timestamp in the repo will have moved.
  6. After that, it runs on its own every day at 04:17 UTC (~09:47 IST).
     You can watch its history any time under the Actions tab.

If step 5 shows a red X: click into the run to see which step failed.
The most common cause is step 4 being skipped (permissions), which shows
up as a 403 error on the "git push" step specifically — everything before
that (the actual scraping) will show as green even when the commit fails.

DEFAULTS SHIPPED IN THIS BUILD (used until the first live check runs)
--------------------------------------------------------------------------
  - RBI repo rate: 5.25% (as of the August 2026 MPC meeting)
  - PPF 7.1%, NSC 7.7%, KVP 7.5% (matures in 115 months), SSY 8.2%,
    SCSS 8.2%, POMIS 7.4% — all officially notified for Jul-Sep 2026.
  - Income tax slabs: FY 2026-27 (AY 2027-28), per Budget 2026.
  - GST: current GST 2.0 slabs (0%, 5%, 18%, 40%).
A seed rates.json with these same values ships in this folder so the
Settings page has something real to show on day one, before the
scheduled job has run even once.

VERIFICATION
------------
Every formula (EMI, amortization, both tax regimes with Section 87A rebate
and marginal relief, GST/VAT, SIP/lumpsum, PPF/NSC/KVP/SSY/SCSS) was
independently computed in Python first, then the JavaScript port was
checked against those numbers. The rate-scraper's parsing logic was tested
against the real, actually-fetched content of both source pages (not
guessed HTML), plus deliberately broken/garbled versions of those pages to
confirm it rejects bad data instead of publishing it. The full app — all
8 views, every calculator, language switching, manual rate edits, and the
live-rate fetch itself (success, network failure, 404, malformed JSON,
out-of-range values, and stale data) — was run end-to-end in a headless
browser. 93/93 checks passed across all of this before it was handed to
you.

DISCLAIMER
----------
All figures are for planning purposes only, not tax, legal, or investment
advice. For anything you're about to file or act on, confirm with a
chartered accountant, your bank, or the official government calculator.
