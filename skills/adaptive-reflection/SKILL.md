---
name: adaptive-reflection
description: Use when repeated failures, recurring errors, or low-yield retries suggest that an explicit assumption check may change the next action.
---

# Adaptive Reflection

Use this skill after a repeated failure or when the same strategy has produced no useful evidence.

1. Call `control_assess` with `check: "trajectory"`, passing the failing assumption as `hypothesis` and only evidence references as `evidence`.
2. Treat the returned action as controller arbitration; it may prefer `REPLAN` over `REFLECT`.
3. Name the failing assumption, not only the visible error.
4. Separate facts from guesses and identify the smallest conflicting evidence.
5. Choose one next action that materially differs from the failed approach.
6. Record the new evidence before attempting another correction.

If `control_assess` is unavailable, perform the same rubric manually and label the result **unassessed by a Decision Provider**. Do not call the same failed tool again without a changed hypothesis.

Do not turn “try it again” into reflection. Do not invent diagnostics, claim recovery without evidence, or execute unrelated cleanup.
