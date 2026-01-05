# GitHub Actions CI Guide

This file documents the GitHub Actions workflows in this repo for running the test suite with and without Postgres. It assumes GitHub-hosted runners and a minimal, reliable setup.

## Minimal Steps (Concept)

These are the two minimal flows. Both rely on a `.env.test` file and run serially.

In-memory:

```yaml
steps:
  - run: |
      cat > .env.test <<'EOF'
      NODE_ENV=test
      LOG_LEVEL=warn
      DATABASE_URL=
      ALLOWED_ORIGINS=
      ALLOW_CREDENTIALS=false
      RATE_LIMIT_WINDOW_MS=900000
      RATE_LIMIT_MAX=100
      EOF
  - run: node --test --test-concurrency=1 --env-file=.env.test
```

Postgres:

```yaml
steps:
  - run: |
      cat > .env.test <<'EOF'
      NODE_ENV=test
      LOG_LEVEL=warn
      DATABASE_URL=postgres://tasks:tasks@localhost:5432/tasks_test
      ALLOWED_ORIGINS=
      ALLOW_CREDENTIALS=false
      RATE_LIMIT_WINDOW_MS=900000
      RATE_LIMIT_MAX=100
      EOF
  - run: node --test --test-concurrency=1 --env-file=.env.test
```

## GitHub Actions Workflows in This Repo

This repo uses two workflows:

- `.github/workflows/ci.yml`: in-memory tests on push and pull request.
- `.github/workflows/ci-postgres.yml`: Postgres tests on manual trigger (`workflow_dispatch`).

Both workflows:

- use Node.js `20.12.2`.
- run `npm ci`.
- create a `.env.test` file.
- run `node --test --test-concurrency=1 --env-file=.env.test`.

### Notes

- The Postgres workflow provisions a service container and uses `DATABASE_URL=postgres://tasks:tasks@localhost:5432/tasks_test`.
- The in-memory workflow intentionally leaves `DATABASE_URL` unset so Postgres tests are skipped.
- Serial test execution is required because the HTTP tests mutate shared `app.locals`/module cache state.

### Troubleshooting

- **Postgres not ready**: Increase `--health-interval` or `--health-retries` in `.github/workflows/ci-postgres.yml`.
- **Auth failures**: Double-check `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and the `DATABASE_URL` string.
- **Node version mismatch**: Ensure `actions/setup-node` matches the workflow version (`20.12.2`).
- **`npm ci` fails**: Confirm `package-lock.json` exists and is in sync with `package.json`.
- **Re-run failed jobs**: In the GitHub Actions UI, open the run and click **Re-run jobs** or **Re-run failed jobs**. See https://docs.github.com/en/actions/managing-workflow-runs/re-running-workflows-and-jobs
