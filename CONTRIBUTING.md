# Contributing

Keep the example fictional, deterministic, and offline-testable. Do not add
credentials, customer content, private URLs, repository history, generated
dependency directories, or project-specific schema assumptions.

Use Node.js `>=20.19.0 <25`, npm, Git, and the POSIX tools listed in the README.
From a pristine checkout run:

```bash
node scripts/verify-manifest.mjs
npm ci --ignore-scripts
npm run check
```

Add fake-transport tests for every live workflow change. Tests must never use
real credentials or contact Contentful. Keep production preparation read-only,
keep production execution behind its exact candidate confirmation, and cover
failed journal states and recovery behavior when either contract changes.

Update documentation and both lockfiles when their contracts change. Regenerate
`.public-reference-manifest.json` last, then verify it from a clean Git clone or
archive copy. Do not commit `.tmp/`, `node_modules/`, Gatsby `.cache/`, or
Gatsby `public/`.
