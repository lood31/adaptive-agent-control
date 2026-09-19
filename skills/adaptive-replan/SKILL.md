---
name: adaptive-replan
description: Use when new evidence changes the objective, scope, assumptions, dependencies, or ordering of an active plan.
---

# Adaptive Replan

Use this skill when the active plan no longer explains the evidence or when local fixes are not converging.

1. Call `control_assess` with `check: "trajectory"`, passing the stale assumption as `hypothesis` and only evidence references as `evidence`.
2. Continue only if controller arbitration returns `REPLAN`; it may prefer `REFLECT` or `CONTINUE`.
3. State which evidence made the plan stale.
4. Classify existing steps as **keep**, **discard**, or **revise**; explain the dependency change briefly.
5. Add only the smallest missing steps needed to reach the goal.
6. Hand the revised proposal to the existing Pi plan flow; do not silently rewrite or bypass plan mode.

If `control_assess` is unavailable, perform the same rubric manually and label the result **unassessed by a Decision Provider**.

A single ordinary failure is not enough to rewrite a plan. Do not start `/plan`, change files, or discard user constraints solely because this skill was loaded.
