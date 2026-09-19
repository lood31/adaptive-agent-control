---
name: adaptive-verification
description: Use before claiming completion, after a completion gate, or whenever a success criterion lacks current evidence.
---

# Adaptive Verification

Use this skill to replace completion claims with a claim-to-evidence check.

1. List each success criterion or material claim.
2. Map every item to current evidence: tests, diagnostics, file content, diff, or source-backed output.
3. Run the smallest relevant verification command or inspection for missing items.
4. Call `control_assess` with `check: "completion"` when the tool is available.
5. Complete only when every item is supported; otherwise report the exact missing evidence and continue.

If `control_assess` is unavailable, fails, or returns empty signals / `provider_error:*` (including disabled or cooldown assessments), perform the same rubric manually and label the result **unassessed by a Decision Provider**. A fail-open `CONTINUE` is not a verification pass. Finish only on current evidence; do not repeatedly retry the provider to obtain approval.

Self-report, an intended implementation, an old test run, and an expected output are not current evidence. Do not suppress failures or fabricate a passing result.
