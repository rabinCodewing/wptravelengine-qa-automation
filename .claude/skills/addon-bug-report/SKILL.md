---
name: addon-bug-report
description: Find, verify and report bugs in a WP Travel Engine add-on through its QA Report — read the add-on's whole source for functional bugs, write them as curated findings (data/addons/<slug>/qa-report.json), reproduce each one on the QA site, write click-by-click UI steps and a plain-language "what the user experiences" section, then prepare GitHub issues for the add-on's own repo that a HUMAN previews and files from the runner UI. Use when the user says "scan the repo for bugs", "find bugs in <add-on>", "is there no issue in <add-on>?", "verify this issue", "I can't reproduce this", "give steps to reproduce in the UI", "write the bug report", "prepare/draft the issues", "send the issues to <repo> but don't send automatically", "mark what's already filed on GitHub", or pastes a finding's steps and asks where/how. Never files, edits or closes a GitHub issue itself, and never changes the add-on's code.
---

# Add-on bug reports (QA Report workflow)

Turns "read the add-on and tell me what's broken" into **verified, reproducible
GitHub issues** in the add-on's own repo — prepared by you, **sent by the user**.
Builds on the `addon-qa` skill (which sets up the suite, `config/addons.js`
entry, `repo`/`bugRepo` and the empty `qa-report.json`).

## Golden rules

- **Never send anything to GitHub.** You prepare; the user previews and clicks **File issue › File to GitHub** in `npm run ui`. No `gh issue create`, no API POSTs, no closing/editing issues — even if asked to "send", prepare drafts and point to the button unless the user explicitly says to post it now.
- **Never change the add-on or WP Travel Engine code.** The clone in `data/addons/<slug>/repo` is read-only reference. Don't "fix" bugs you find.
- **"Scan the repo" means read every source file for real bugs**, not only run pattern scanners. `npm run doctor` and Re-scan are extras.
- **Only `confirmed` = reproduced on the QA site** (`FRONTEND_URL`, e.g. http://rabin.local). Everything from reading code starts `unverified`. If it doesn't reproduce, move it to `checkedNotIssues` with what you tried — don't keep it as a finding.
- **Steps are for a human in a browser**: menus, tabs, buttons, what to type, what to look at. No REST calls, curl, stubs or code in steps. Verify every UI path yourself before writing it — wrong labels (e.g. a "New York" Sensors preset that doesn't exist) waste the tester's time.
- **Use QA fixtures and put them back.** Reproduce on `QA <Name>` trips; restore anything you change (durations, settings) and delete throwaway trips. Never touch real trips/bookings. Intercept-and-abort add-to-cart/payment requests unless the user wants a real (Stripe test-mode) booking.
- **Admit mistakes in the report.** When a finding or a step was wrong, correct it and say so (e.g. counts, labels).

## Where things live

| What | Where |
| --- | --- |
| Curated findings (the QA Report) | `data/addons/<slug>/qa-report.json` (gitignored) |
| Issue drafts (exact title/body) | `data/addons/<slug>/issue-drafts/<id>.md` |
| Add-on source (read-only) | `data/addons/<slug>/repo` |
| Issue target repo | `bugRepo` in `config/addons.js` |
| Helper CLI | `node scripts/qaReport.js <validate|status|drafts|sync> <slug>` |
| Issue title/body builder | `scripts/doctor/github.js` (`previewIssue`, `fileIssue`, `listIssues`) |
| Finding → issue mapping, GitHub matching | `scripts/repoAudit.js` (`reportFindingForIssue`, `matchIssues`) |
| UI (QA Report tab) | `scripts/addonsUi.html` / `addonsUi.js` → `npm run ui` › add-on › **QA Report** |

## Workflow

### 1. Read the whole add-on
Clone/pull (`addon-qa` step 1, or **Re-scan repo**). Read every PHP file under
`includes/` and every JS/JSX file under `src/` (skip `dist/`, `vendor/`). Look for
functional bugs, not just security patterns: state not reset, errors swallowed,
timezone/date handling, unvalidated input, wrong defaults, translation gaps,
`&&`/`||` slips, cache keys missing ids, missing `ABSPATH` guards. Also run
`npm run doctor -- --repo <slug>` and fold real hits in. Check the repo's existing
issues first so you don't re-report closed/known ones.

### 2. Write findings into `qa-report.json`
One object per bug in `findings` (schema below). Rules:
- `id` `XX-NNN` (add-on initials), stable forever — it becomes the `DOC-<id>` tag that matches issues.
- `title` ≤ 90 characters (the issue title is cut there), states the user-visible problem.
- `scanPattern` = a regex that matches one line in the first `location` file, so Re-scan can show "in source" / "not found" (fixed).
- `status: "unverified"` until step 3.

Then: `node scripts/qaReport.js validate <slug>` (fields, title length, steps
style, every scanPattern matches) and **Re-scan repo** in the UI.

### 3. Reproduce on the QA site
Use the add-on's QA trips (build what's missing — `addon-qa`). Drive it the way a
person would; exploratory Playwright scripts go in the **scratchpad**, not `tests/`.
- Record what you saw in `evidence` (trip name, inputs, what appeared). Set `status: "confirmed"`.
- Try the path a tester would use too (e.g. trip editor instead of REST) — a bug confirmed only over REST must be re-checked in the UI before writing UI steps.
- Doesn't reproduce → remove from `findings`, add a sentence to `checkedNotIssues` ("AT-022 (client prices): not an issue — … checkout still $1000").
- Bugs the site can't show (missing add-on, translation, other role) stay `unverified`; say what setup is needed in step 1 of `steps`.
- Every confirmed bug can also get a `test.fail()` regression test in the suite's "Known bugs" section (see `addon-qa`).

### 4. Write `steps` and `userExperience`
**`steps`** — numbered UI path a tester can follow cold:
1. Where to start (full URL or `wp-admin › Trips › Trips › hover "QA …" › Edit › Meta Boxes › General`).
2. Exact labels as they appear on the site (button text, tab names, field suffixes).
3. Any setup (browser setting, role, add-on) **first**, with a way to check it worked.
4. An **"Observe:"** step (what's wrong) and a final **"Expected:"** step.
5. If you changed a QA fixture, a last step to restore it.

**`userExperience`** — 3–7 plain-language bullets: what's on screen, what the
person does, what happens, why it hurts (lost booking, wrong day, looks broken),
who notices. No code terms beyond what's needed. Add a "Testing note" bullet if a
browser tool is involved.

Browser recipes that work (Brave/Chrome/Edge are the same DevTools):
- **Network failure**: DevTools › **Network** › throttling dropdown "No throttling" → **Offline**, then click. (Network request blocking is hard to find in new Chrome/Brave.)
- **Timezone**: DevTools › ⋮ › More tools › **Sensors** › Location → **San Francisco / Mountain View / São Paulo** (west of UTC) or **Tokyo/Mumbai/Berlin**. There is **no "New York"**. Check in Console: `Intl.DateTimeFormat().resolvedOptions().timeZone`. Override only lasts while DevTools is open; reload after setting it. Windows alternative: change the time zone, then **quit Brave from the system tray** (it keeps running) and reopen.
- **Prefer a scenario that shows harm** — e.g. click a departure whose previous day is *also* a departure, so the wrong day is pre-selected, not just "no date".
- The user is in Nepal (UTC+5:45): timezone bugs west of UTC are invisible without the override.

### 5. Prepare the issues (don't send)
```
node scripts/qaReport.js validate <slug>
node scripts/qaReport.js drafts <slug>   # issue-drafts/<id>.md, confirmed + unfiled only
```
Tell the user: `npm run ui` › add-on › **QA Report** › open the finding ›
**Preview issue** (exact repo/title/body) › **File issue** opens an in-card
confirmation › **File to GitHub**. The title/body are built by the same code that
files, so drafts == what gets posted. Restart `npm run ui` after changing scripts.

### 6. Keep "filed" in sync
Issues get filed by the button *or* by hand on GitHub. The QA Report auto-syncs
(read-only) when opened, matching by `DOC-<id>` tag or title, and refreshes
open/closed. From the CLI: `node scripts/qaReport.js sync <slug>` then `status`.
The user can also link one by hand: open the finding › **Already on GitHub? Link it**.

## Finding schema

```json
{
  "id": "AT-001",
  "title": "Time slot isn't cleared when date or travellers change, so Book Now books without a slot",
  "severity": "high",                     // critical | high | medium | low | info
  "status": "confirmed",                  // confirmed | unverified
  "category": "Booking / time slots",
  "location": [{ "file": "src/public/js/App.jsx", "line": 135, "note": "why this line" }],
  "scanPattern": "selectedDate: availableDates\\.includes\\(selectedDate\\)",
  "impact": "Technical cause and consequence (for developers).",
  "userExperience": ["Plain-language bullets (for everyone)."],
  "evidence": "What you saw on the QA site: trip, inputs, result.",
  "steps": ["UI steps…", "Observe: …", "Expected: …"],
  "fix": "Suggested fix (never applied by you).",
  "issue": { "number": 57, "url": "…", "state": "open", "source": "tool|github|manual" }  // written by the UI/sync, not by hand
}
```
Issue body order: severity/rule → evidence → **Impact** → **What the user experiences** → **Steps** → **Fix** → footer with `DOC-<id>`.

## Answering "where will it file?"
Read `bugRepo` for the add-on in `config/addons.js`; confirm access read-only:
`curl -s -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/<bugRepo>`
(`has_issues`, `permissions.push/triage`). Preview and the confirmation both show the repo.
