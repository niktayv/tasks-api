# GitHub Actions CI Guide

This file shows a simple GitHub Actions setup for running the test suite with and without Postgres. It assumes you are using GitHub-hosted runners and want a minimal, reliable pipeline.

## Minimal Steps (Concept)

These are the two commands you want to run in CI. The first runs fast in-memory tests, the second runs Postgres-backed tests.

```yaml
steps:
  - run: npm test
  - run: DATABASE_URL="postgres://postgres:password@localhost:5432/tasks_dev" npm run test:pg
```

## GitHub Actions Example (with Postgres service)

1. Create a workflow file at `.github/workflows/ci.yml`.
2. Paste the workflow below.
3. Commit and push to GitHub. The workflow will run on every push and pull request.

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: password
          POSTGRES_DB: tasks_dev
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready -U postgres"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test
      - run: DATABASE_URL="postgres://postgres:password@localhost:5432/tasks_dev" npm run test:pg
```

### Notes

- The Postgres service is available on `localhost:5432` within the runner.
- The `DATABASE_URL` used in `npm run test:pg` must match the service credentials.
- If the Postgres service is slow to start, the health check settings ensure the runner waits before running tests.

### Troubleshooting

- **Postgres not ready**: Increase `--health-interval` or `--health-retries`, or add a small sleep before running tests.
- **Auth failures**: Double-check `POSTGRES_PASSWORD`, `POSTGRES_DB`, and the `DATABASE_URL` string.
- **Node version mismatch**: Ensure `actions/setup-node` uses a version compatible with `package.json` (`node >= 20.6`).
- **`npm ci` fails**: Confirm `package-lock.json` exists and is in sync with `package.json`.
- **Re-run failed jobs**: In the GitHub Actions UI, open the run and click **Re-run jobs** or **Re-run failed jobs**. See https://docs.github.com/en/actions/managing-workflow-runs/re-running-workflows-and-jobs
