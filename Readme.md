# Tasks API (Single-File Implementation)

This project is a clean, production-leaning refactor of a basic Tasks API, intentionally kept in a single file for clarity and portability. It demonstrates better validation, error handling, logging, security hardening, and a repository abstraction while remaining easy to read and test.

## Purpose

- Provide a simple Tasks API with professional defaults.
- Show how to keep a single-file Express app maintainable.
- Support both in-memory storage (default) and Postgres without changing routes.

## Architecture

Everything lives in `server.js`, but it is organized by clear sections:

- **Security & parsing**: HTTP hardening via `helmet`, request body limits, and JSON parsing.
- **Response helpers**: JSend-style success/fail/error responses for consistent API output.
- **Validation & parsing**: input validation for request bodies and query parameters.
- **Repository pattern**: a shared interface with two implementations:
  - `InMemoryTaskRepository` (used when `DATABASE_URL` is not set)
  - `PostgresTaskRepository` (used when `DATABASE_URL` is set)
- **Routes**: versioned routes under `/v1` with pagination, filtering, sorting, and search.
- **Error handling**: structured logging and consistent error responses.
- **Graceful shutdown**: closes server and DB pool on SIGINT/SIGTERM.

## API Overview

Base URL: `http://localhost:3000`

- `GET /` health endpoint
- `GET /v1/tasks` list tasks with pagination/filtering
- `GET /v1/tasks/:id` fetch a task
- `POST /v1/tasks` create a task
- `PUT /v1/tasks/:id` update a task
- `DELETE /v1/tasks/:id` delete a task

Status codes (common cases):

- `GET /` -> `200`
- `GET /v1/tasks` -> `200`, `400` on invalid query params
- `GET /v1/tasks/:id` -> `200`, `400` on invalid id, `404` if not found
- `POST /v1/tasks` -> `201`, `400` on invalid payload
- `PUT /v1/tasks/:id` -> `200`, `400` on invalid id/payload, `404` if not found
- `DELETE /v1/tasks/:id` -> `200`, `400` on invalid id, `404` if not found

Query parameters for `GET /v1/tasks`:

- `limit` (default `20`, max `100`)
- `offset` (default `0`)
- `done` (`true` or `false`)
- `q` (case-insensitive substring match on title)
- `sort` (`id`, `title`, `done`)
- `order` (`asc`, `desc`)

## Response Format (JSend)

All routes respond in a JSend-style envelope.

Error envelope shape (consistent across `/v1` and global handlers):

```
{
  "status": "error",
  "message": "Internal server error"
}
```

Fail envelope shape (used for validation and not-found responses):

```
{
  "status": "fail",
  "code": 400,
  "message": "Invalid task payload.",
  "details": {
    "validation": [
      {
        "msg": "Invalid value",
        "param": "title",
        "location": "body"
      }
    ]
  }
}
```

Success example:

```
{
  "status": "success",
  "data": {
    "id": 1,
    "title": "Buy milk",
    "done": false
  }
}
```

List pagination example:

```
{
  "status": "success",
  "data": {
    "items": [
      { "id": 1, "title": "Buy bread", "done": false },
      { "id": 2, "title": "Buy milk", "done": false }
    ],
    "page": {
      "limit": 2,
      "offset": 0,
      "total": 3,
      "returned": 2,
      "hasMore": true
    },
    "filters": {
      "done": false,
      "q": "buy"
    },
    "sort": { "field": "title", "order": "asc" }
  }
}
```

Validation error example:

```
{
  "status": "fail",
  "code": 400,
  "message": "Invalid task payload.",
  "details": {
    "title": "Field \"title\" must be a non-empty string.",
    "done": "Field \"done\" must be a boolean."
  }
}
```

## cURL Usage

Health check:

```
curl http://localhost:3000/
```

List tasks (with filtering and pagination):

```
curl "http://localhost:3000/v1/tasks?limit=10&offset=0&done=false&q=buy&sort=title&order=asc"
```

Fetch a task by id:

```
curl http://localhost:3000/v1/tasks/1
```

Create a task:

```
curl -X POST http://localhost:3000/v1/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Buy milk","done":false}'
```

Update a task:

```
curl -X PUT http://localhost:3000/v1/tasks/1 \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Buy bread","done":true}'
```

Delete a task:

```
curl -X DELETE http://localhost:3000/v1/tasks/1
```

## Configuration

Environment variables:

- `PORT` (default `3000`)
- `DATABASE_URL` (optional; if set, uses Postgres repository; otherwise uses in-memory)
- `PG_POOL_MAX` (default `10`)
- `PG_IDLE_TIMEOUT` (default `30000` ms)
- `PG_CONNECTION_TIMEOUT` (default `2000` ms)
- `PG_STATEMENT_TIMEOUT` (default `5000` ms)

Example `.env` (optional):

```
PORT=3000
# DATABASE_URL=postgres://postgres:password@localhost:5432/tasks_dev
```

Note: Prefer storing credentials in `.env` and avoid committing passwords in docs or code.

Postgres schema:

```
CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE
);
```

Local database setup (example):

```
# The database user must have permission to create databases.
psql -U postgres -h localhost -c "CREATE DATABASE tasks_dev;"
psql -U postgres -h localhost -d tasks_dev -c "CREATE TABLE tasks (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT FALSE);"
```

Create a separate test database (kept isolated from dev/prod data):

```
psql -U postgres -h localhost -c "CREATE DATABASE tasks_test;"
psql -U postgres -h localhost -d tasks_test -c "CREATE TABLE tasks (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT FALSE);"
```

Connection test (run before starting the app):

```
psql -U postgres -h localhost -d tasks_dev -c "SELECT 1;"
```

Test database connection check:

```
psql -U postgres -h localhost -d tasks_test -c "SELECT 1;"
```

Troubleshooting `psql` auth:

- If you see `password authentication failed`, verify the username/password and check `pg_hba.conf`.
- If you see `role \"postgres\" does not exist`, use a valid local role or create one.

## Run the Project

Install dependencies:

```
npm install
```

Run in development mode (uses in-memory repository by default):

```
npm run dev
```

Run in production mode (requires `DATABASE_URL` for Postgres):

```
DATABASE_URL="postgres://user:pass@localhost:5432/dbname" npm start
```

## Tests

The test suite runs contract tests against the in-memory repository, and also against Postgres if `DATABASE_URL` is set.

```
npm test
```

The test script uses `.env.test` for environment variables. If `DATABASE_URL` is configured there, it will test both repositories; otherwise, only the in-memory repository is tested.

Keep `.env.example` checked in and ignore real `.env*` files. Use `.env.test.example` as a template for your test environment.

## Notes

- The project intentionally uses a single-file implementation for teaching and portability.
- If you want a multi-file layout, the sections in `server.js` map cleanly to modules.
