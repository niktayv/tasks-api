# Remaining Concerns / TODO

Already covered: structured logging, DB-aware health check, basic HTTP tests (JSend/validation/pagination).

## Must Fix for Production

- Validate task title length (define max length; enforce in `validateTaskPayload`).

## Should Fix for Production

- Validate `Content-Type: application/json` for JSON endpoints.
- Validate database connectivity on startup (not just in health check).
- Limit search query length (`search`) to prevent abusive scans.
- Add `pg.Pool` error handlers (`pool.on("error", ...)`).
- Add process-level error handlers (`unhandledRejection`, `uncaughtException`).
- Clarify/restore repository selection behavior (`DATABASE_URL` now overrides any desire to force in-memory).
- Note: tests can fail in sandboxed environments due to restricted network binding/DB access; document or adjust test harness to handle this gracefully.

## Nice to Have

- API documentation (OpenAPI/Swagger).
- Metrics/monitoring.
- Response compression.
- Cache headers (for read endpoints, if appropriate).
- Database migrations.
- More tests (basic HTTP JSend/validation coverage exists; add error paths and edge cases).
- Consider allowing `0` for `PG_STATEMENT_TIMEOUT` (disable) and document expected ranges for `parseEnvInt`.
