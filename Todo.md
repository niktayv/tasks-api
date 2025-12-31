# Remaining Concerns / TODO

Already covered: structured logging, DB-aware health check, basic HTTP tests (JSend/validation/pagination).

## Must Fix for Production

- Add request logging middleware (e.g., `pino-http`) for per-request logs.
- Validate task title length (define max length; enforce in `validateTaskPayload`).
- Add rate limiting.

## Should Fix for Production

- Add CORS configuration (if needed by clients).
- Validate `Content-Type: application/json` for JSON endpoints.
- Add request ID/correlation tracking.
- Validate database connectivity on startup (not just in health check).
- Limit search query length (`q`) to prevent abusive scans.
- Add `pg.Pool` error handlers (`pool.on("error", ...)`).
- Add process-level error handlers (`unhandledRejection`, `uncaughtException`).
- Clarify/restore repository selection behavior (`DATABASE_URL` now overrides any desire to force in-memory).

## Nice to Have

- API documentation (OpenAPI/Swagger).
- Metrics/monitoring.
- Response compression.
- Cache headers (for read endpoints, if appropriate).
- Database migrations.
- More tests (basic HTTP JSend/validation coverage exists; add error paths and edge cases).
- Consider allowing `0` for `PG_STATEMENT_TIMEOUT` (disable) and document expected ranges for `parseEnvInt`.
