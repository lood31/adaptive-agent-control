---
name: adaptive-replan
description: Use when new evidence changes the objective, scope, assumptions, dependencies, or ordering of an active plan.
---

# Adaptive Replan

Use this skill when the active plan no longer explains the evidence or when local fixes are not converging.

1. Call `control_assess` with `check: "replan"` when the tool is available.
2. State which evidence made the plan stale.
3. Classify existing steps as **keep**, **discard**, or ** revise**; explain the dependency change briefly.
4. Add only the smallest missing steps needed to reach the goal.
5. Hand the revised proposal to the existing Pi plan flow; do not silently rewrite or bypass plan mode.

If `control_assess` is unavailable, perform the same rubric manually and label the result **unassessed by a Decision Provider**.

A single ordinary failure is not enough to rewrite a plan. Do not start `/plan`, change files, or discard user constraints solely because this skill was loaded.
