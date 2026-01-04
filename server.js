"use strict";

const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg"); // npm i pg
const pino = require("pino");
const pinoHttp = require("pino-http");
const { randomUUID } = require("node:crypto");

const app = express();

// Initialize structured logger
const loggerConfig = {
  level: process.env.LOG_LEVEL || 'info',
};
const logger = pino(loggerConfig);

// -----------------------------------------------------------------------------
// Environment validation (minimal)
// -----------------------------------------------------------------------------

const allowedNodeEnvs = new Set(["development", "test", "production"]);
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "development";
  logger.warn('NODE_ENV not set, defaulting to "development"');
} else if (!allowedNodeEnvs.has(process.env.NODE_ENV)) {
  throw new Error(`Invalid NODE_ENV: "${process.env.NODE_ENV}"`);
}

function parsePort(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT: "${value}", expected integer 1-65535`);
  }
  return parsed;
}

if (process.env.DATABASE_URL) {
  const isPostgresUrl =
    process.env.DATABASE_URL.startsWith("postgres://") ||
    process.env.DATABASE_URL.startsWith("postgresql://");
  if (!isPostgresUrl) {
    throw new Error('DATABASE_URL must start with "postgres://" or "postgresql://"');
  }
}

const port = parsePort(process.env.PORT, 3000);

// -----------------------------------------------------------------------------
// Basic security & hardening
// -----------------------------------------------------------------------------

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.headers["x-request-id"] || randomUUID(),
  })
);
app.use((req, res, next) => {
  res.setHeader("X-Request-ID", req.id);
  next();
});

// -----------------------------------------------------------------------------
// Logging helpers
// -----------------------------------------------------------------------------

function redactHeadersForLog(headers) {
  // Normalize header keys to lowercase for case-insensitive matching
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  // Remove sensitive headers
  delete normalized.authorization;
  delete normalized['x-api-key'];
  delete normalized.cookie;
  return normalized;
}

function parseEnvInt(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: "${value}", expected positive integer`);
  }
  return parsed;
}

// -----------------------------------------------------------------------------
// JSend helpers
// -----------------------------------------------------------------------------

function sendSuccess(res, data, statusCode = 200) {
  res.status(statusCode).json({ status: "success", data });
}

function sendFail(res, statusCode, message, details) {
  const payload = { status: "fail", code: statusCode, message };
  if (details !== undefined) payload.details = details;
  res.status(statusCode).json(payload);
}

function sendError(res, statusCode, message) {
  res.status(statusCode).json({ status: "error", message });
}

// -----------------------------------------------------------------------------
// Query parsing helpers
// -----------------------------------------------------------------------------

function parseNonNegativeInt(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseBooleanQuery(value) {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseSortField(value) {
  if (value === undefined) return "id";
  const v = String(value);
  return v === "id" || v === "title" || v === "done" ? v : null;
}

function parseSortOrder(value) {
  if (value === undefined) return "asc";
  const v = String(value).toLowerCase();
  return v === "asc" || v === "desc" ? v : null;
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

function parseTaskId(req) {
  const id = Number.parseInt(req.params.id, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function validateTaskPayload(body) {
  if (body == null || typeof body !== "object") {
    return { message: "Request body must be a JSON object." };
  }

  const errors = {};

  if (typeof body.title !== "string" || body.title.trim() === "") {
    errors.title = 'Field "title" must be a non-empty string.';
  }

  if (typeof body.done !== "boolean") {
    errors.done = 'Field "done" must be a boolean.';
  }

  if (Object.keys(errors).length > 0) {
    return { message: "Invalid task payload.", errors };
  }

  return null;
}

// -----------------------------------------------------------------------------
// Repository pattern (single-file friendly)
// -----------------------------------------------------------------------------
//
// By convention, a "TaskRepository" exposes these async methods:
//
// - list({ limit, offset, done, q, sort, order }) -> { items, total }
// - getById(id) -> task | null
// - create({ title, done }) -> task
// - update(id, { title, done }) -> task | null
// - delete(id) -> boolean
//
// NOTE: Keeping the routes dependent on this shape makes storage swappable.

// ----- In-memory repository (good for tests & demos) -----

function InMemoryTaskRepository(seedTasks = []) {
  let tasks = seedTasks.slice();
  let nextId = tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;

  function compareValues(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  return {
    async list({ limit, offset, done, q, sort, order }) {
      let filtered = tasks;

      if (done !== undefined) filtered = filtered.filter((t) => t.done === done);
      if (q) {
        const qLower = q.toLowerCase();
        filtered = filtered.filter((t) => t.title.toLowerCase().includes(qLower));
      }

      const direction = order === "asc" ? 1 : -1;

      const sorted = filtered.slice().sort((a, b) => {
        const primary = compareValues(a[sort], b[sort]);
        if (primary !== 0) return primary * direction;
        // deterministic tie-breaker
        return compareValues(a.id, b.id);
      });

      const total = sorted.length;
      const items = sorted.slice(offset, offset + limit);

      return { items, total };
    },

    async getById(id) {
      return tasks.find((t) => t.id === id) || null;
    },

    async create({ title, done }) {
      const task = { id: nextId++, title, done };
      tasks.push(task);
      return task;
    },

    async update(id, { title, done }) {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;

      task.title = title;
      task.done = done;
      return task;
    },

    async delete(id) {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== id);
      return tasks.length !== before;
    },
  };
}

// ----- Postgres repository (development/production) -----
// Requires a table like:
//
// CREATE TABLE tasks (
//   id SERIAL PRIMARY KEY,
//   title TEXT NOT NULL,
//   done BOOLEAN NOT NULL DEFAULT FALSE
// );

function PostgresTaskRepository(pool) {
  // Map API sort fields to SQL columns (avoid SQL injection).
  const SORT_COLUMN = {
    id: "id",
    title: "title",
    done: "done",
  };

  // Escape SQL LIKE wildcards: \, %, _
  function escapeLike(str) {
    return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  return {
    async list({ limit, offset, done, q, sort, order }) {
      const conditions = [];
      const params = [];
      let i = 1;

      if (done !== undefined) {
        conditions.push(`done = $${i++}`);
        params.push(done);
      }

      if (q) {
        conditions.push(`title ILIKE $${i++} ESCAPE '\\'`);
        params.push(`%${escapeLike(q)}%`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      // Deterministic order + tie-breaker
      const sortCol = SORT_COLUMN[sort] || "id";
      const sortDir = order === "desc" ? "DESC" : "ASC";

      // For stable pagination, tie-break on id. (Always ASC tie-break.)
      const orderBy =
        sortCol === "id"
          ? `ORDER BY id ${sortDir}`
          : `ORDER BY ${sortCol} ${sortDir}, id ASC`;

      // Single query with window function for total (count before LIMIT/OFFSET).
      const sql = `
        SELECT id, title, done, (COUNT(*) OVER())::int AS total
        FROM tasks
        ${where}
        ${orderBy}
        LIMIT $${i++} OFFSET $${i++};
      `;
      const queryParams = params.concat([limit, offset]);
      const result = await pool.query(sql, queryParams);
      const rows = result.rows;

      const total = rows.length > 0 ? rows[0].total : 0;
      const items = rows.map(row => {
        const { total, ...item } = row;
        return item;
      });

      return { items, total };
    },

    async getById(id) {
      const res = await pool.query(
        "SELECT id, title, done FROM tasks WHERE id = $1;",
        [id]
      );
      return res.rows[0] || null;
    },

    async create({ title, done }) {
      const res = await pool.query(
        "INSERT INTO tasks (title, done) VALUES ($1, $2) RETURNING id, title, done;",
        [title, done]
      );
      return res.rows[0];
    },

    async update(id, { title, done }) {
      const res = await pool.query(
        "UPDATE tasks SET title = $1, done = $2 WHERE id = $3 RETURNING id, title, done;",
        [title, done, id]
      );
      return res.rows[0] || null;
    },

    async delete(id) {
      const res = await pool.query("DELETE FROM tasks WHERE id = $1;", [id]);
      return res.rowCount > 0;
    },
  };
}

// -----------------------------------------------------------------------------
// Choose repository implementation
// -----------------------------------------------------------------------------

let taskRepo;
let pgPool = null;

if (process.env.DATABASE_URL) {
  try {
    // DATABASE_URL example: postgres://user:pass@localhost:5432/dbname
    const poolConfig = {
      connectionString: process.env.DATABASE_URL,
      max: parseEnvInt('PG_POOL_MAX', 10), // max connections
      idleTimeoutMillis: parseEnvInt('PG_IDLE_TIMEOUT', 30000), // 30s
      connectionTimeoutMillis: parseEnvInt('PG_CONNECTION_TIMEOUT', 2000), // 2s
      statement_timeout: parseEnvInt('PG_STATEMENT_TIMEOUT', 5000), // 5s query timeout
    };
    pgPool = new Pool(poolConfig);
    taskRepo = PostgresTaskRepository(pgPool);
    logger.info("Using PostgresTaskRepository");
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Postgres repository');
    throw err;
  }
} else {
  taskRepo = InMemoryTaskRepository([
    { id: 1, title: "Buy milk", done: false },
    { id: 2, title: "Walk dog", done: true },
  ]);
  logger.info("Using InMemoryTaskRepository");
}
app.locals.pgPool = pgPool;

// -----------------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------------

let server;

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  const timeout = setTimeout(() => {
    logger.error('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 30000);

  async function performShutdown(closeErr) {
    try {
      if (pgPool) {
        await pgPool.end();
      }
      logger.info('Graceful shutdown complete.');
    } catch (poolErr) {
      logger.error({ err: poolErr }, 'Error closing database pool');
    } finally {
      clearTimeout(timeout);
      process.exit(closeErr ? 1 : 0);
    }
  }

  if (!server) {
    logger.warn('Server not defined, skipping close');
    logger.info('Graceful shutdown complete (server was not running).');
    // Still attempt to close pool and exit
    await performShutdown(false);
    return;
  }

  // Stop accepting new connections
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error closing server');
    } else {
      logger.info('Server closed, closing database pool...');
    }

    performShutdown(err).catch((shutdownErr) => {
      logger.error({ err: shutdownErr }, 'Error during async shutdown');
      process.exit(1);
    });
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

app.get("/health", async (req, res) => {
  const pool = req.app.locals.pgPool;
  const dbMode = pool ? "postgres" : "memory";

  if (pool) {
    try {
      await pool.query("SELECT 1;");
    } catch (err) {
      logger.error({ err }, "Health check failed: database unavailable");
      return sendError(res, 503, "Service unavailable");
    }
  }

  sendSuccess(res, {
    service: "tasks-api",
    status: "ok",
    timestamp: new Date().toISOString(),
    db: { status: "ok", mode: dbMode },
  });
});

app.get("/", (req, res) => {
  sendSuccess(res, {
    service: "tasks-api",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// -----------------------------------------------------------------------------
// /v1/tasks routes (JSend + repository-backed)
// -----------------------------------------------------------------------------

const v1 = express.Router();

v1.get("/tasks", async (req, res, next) => {
  try {
    const limitRaw = parseNonNegativeInt(req.query.limit, 20);
    const offset = parseNonNegativeInt(req.query.offset, 0);
    const done = parseBooleanQuery(req.query.done);
    const sort = parseSortField(req.query.sort);
    const order = parseSortOrder(req.query.order);

    if (limitRaw === null) return sendFail(res, 400, 'Query parameter "limit" must be a non-negative integer.');
    if (offset === null) return sendFail(res, 400, 'Query parameter "offset" must be a non-negative integer.');
    if (done === null) return sendFail(res, 400, 'Query parameter "done" must be "true" or "false".');
    if (sort === null) return sendFail(res, 400, 'Query parameter "sort" must be one of: id, title, done.');
    if (order === null) return sendFail(res, 400, 'Query parameter "order" must be "asc" or "desc".');

    const limit = Math.min(limitRaw, 100);

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const qFilter = q.length > 0 ? q : undefined;

    const { items, total } = await taskRepo.list({
      limit,
      offset,
      done,
      q: qFilter,
      sort,
      order,
    });

    sendSuccess(res, {
      items,
      page: {
        limit,
        offset,
        total,
        returned: items.length,
        hasMore: offset + items.length < total,
      },
      filters: {
        done,
        q: qFilter,
      },
      sort: { field: sort, order },
    });
  } catch (err) {
    next(err);
  }
});

v1.get("/tasks/:id", async (req, res, next) => {
  try {
    const id = parseTaskId(req);
    if (id === null) return sendFail(res, 400, "Invalid task id.");

    const task = await taskRepo.getById(id);
    if (!task) return sendFail(res, 404, "Task not found.");

    sendSuccess(res, task);
  } catch (err) {
    next(err);
  }
});

v1.post("/tasks", async (req, res, next) => {
  try {
    const validation = validateTaskPayload(req.body);
    if (validation) return sendFail(res, 400, validation.message, validation.errors);

    const created = await taskRepo.create({
      title: req.body.title.trim(),
      done: req.body.done,
    });

    sendSuccess(res, created, 201);
  } catch (err) {
    next(err);
  }
});

v1.put("/tasks/:id", async (req, res, next) => {
  try {
    const id = parseTaskId(req);
    if (id === null) return sendFail(res, 400, "Invalid task id.");

    const validation = validateTaskPayload(req.body);
    if (validation) return sendFail(res, 400, validation.message, validation.errors);

    const updated = await taskRepo.update(id, {
      title: req.body.title.trim(),
      done: req.body.done,
    });

    if (!updated) return sendFail(res, 404, "Task not found.");
    sendSuccess(res, updated);
  } catch (err) {
    next(err);
  }
});

v1.delete("/tasks/:id", async (req, res, next) => {
  try {
    const id = parseTaskId(req);
    if (id === null) return sendFail(res, 400, "Invalid task id.");

    const ok = await taskRepo.delete(id);
    if (!ok) return sendFail(res, 404, "Task not found.");

    sendSuccess(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

app.use("/v1", v1);

// -----------------------------------------------------------------------------
// Not found handlers (JSend everywhere)
// -----------------------------------------------------------------------------

app.use("/v1", (req, res) => {
  sendFail(res, 404, "Not found");
});

app.use((req, res) => {
  sendFail(res, 404, "Not found");
});

// -----------------------------------------------------------------------------
// Error handlers (JSend everywhere; must have 4 args
// -----------------------------------------------------------------------------

app.use("/v1", (err, req, res, next) => {
  logger.error({
    err,
    req: {
      method: req.method,
      url: req.originalUrl,
      headers: redactHeadersForLog(req.headers),
    },
  }, "Unhandled error in /v1 middleware");
  sendError(res, 500, "Internal server error");
});

app.use((err, req, res, next) => {
  logger.error({
    err,
    req: {
      method: req.method,
      url: req.originalUrl,
      headers: redactHeadersForLog(req.headers),
    },
  }, "Unhandled error");
  sendError(res, 500, "Internal server error");
});

// -----------------------------------------------------------------------------
// Server bootstrap
// -----------------------------------------------------------------------------

if (require.main === module) {
  server = app.listen(port, () => {
    logger.info({ port }, `API listening on http://localhost:${port}`);
  });
}

// -----------------------------------------------------------------------------
// Module exports (for testing)
// -----------------------------------------------------------------------------

module.exports = {
  app,
  InMemoryTaskRepository,
  PostgresTaskRepository,
  logger,
};
