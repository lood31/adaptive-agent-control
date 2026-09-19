---
name: adaptive-replan
description: Use when new evidence changes the objective, scope, assumptions, dependencies, or ordering of an active plan.
---

# Adaptive Replan

Use this skill when the active plan no longer explains the evidence or when local fixes are not converging.

1. Call `control_assess` with `check: "trajectory"`, passing the stale assumption as `hypothesis` and only evidence references as `evidence`.
2. Treat controller arbitration as advice, not permission. Prefer its suggested `REPLAN`, `REFLECT`, or `CONTINUE` when consistent with current evidence. A concrete change in requirements or invalidated dependency can justify a minimal replan even when the controller returns `CONTINUE`; explain the evidence, and preserve user approval boundaries.
3. State which evidence made the plan stale.
4. Classify existing steps as **keep**, **discard**, or **revise**; explain the dependency change briefly.
5. Add only the smallest missing steps needed to reach the goal.
6. Hand the revised proposal to the existing Pi plan flow; do not silently rewrite or bypass plan mode.

If `control_assess` is unavailable, fails, or returns empty signals / `provider_error:*` (including disabled or cooldown assessments), perform the same rubric manually and label the result **unassessed by a Decision Provider**. A fail-open `CONTINUE` is not evidence that the plan remains valid. Do not repeatedly retry the provider instead of doing the work.

A single ordinary failure is not enough to rewrite a plan. Do not start `/plan`, change files, or discard user constraints solely because this skill was loaded.
