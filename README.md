# Adaptive Agent Control

Adaptive Agent Control is a small, provider-neutral control plane for Pi agents. v0.1 ships one Pi extension and three reusable skills:

- `adaptive-reflection`
- `adaptive-replan`
- `adaptive-verification`

The extension observes runtime evidence, asks a replaceable decision provider for narrow signals, and lets deterministic policy choose `CONTINUE`, `REFLECT`, `REPLAN`, or `VERIFY`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run eval:fixtures
```

The default mode is `observe`. Set `.pi/adaptive-control.json` to `assist` or `enforce` only after reviewing fixture metrics. `enforce` gates `goal_control(action="complete")`; provider failures fail open and are recorded.

For live Jev calls, set `TYPESAFE_API_KEY` and run the opt-in live test command. The extension sends only redacted, bounded state and never persists the API key or full request payload.

## Local Pi loading

Build first, then install the package path or point Pi at `dist/src/pi/index.js`. The package manifest exposes the extension and `skills/` directory together.
