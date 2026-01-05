"use strict";

const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg"); // npm i pg
const pino = require("pino");
const pinoHttp = require("pino-http");
const { randomUUID } = require("node:crypto");
const cors = require("cors");
const {
  body,
  matchedData,
  param,
  query,
  validationResult,
} = require("express-validator");
const rateLimit = require("express-rate-limit");

const app = express();

// Initialize structured logger (pino uses LOG_LEVEL to control verbosity)
const loggerConfig = {
  level: process.env.LOG_LEVEL || "info",
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

function parseEnvBoolean(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${name}: "${value}", expected "true" or "false"`);
}

function parseAllowedOrigins(value) {
  if (!value) return [];
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    if (origin === "*" || origin === "null") continue;
    let url;
    try {
      url = new URL(origin);
    } catch (err) {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: "${origin}"`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: "${origin}"`);
    }
  }
  return origins;
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
const allowCredentials = parseEnvBoolean("ALLOW_CREDENTIALS", false);
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
if (allowCredentials && allowedOrigins.includes("*")) {
  throw new Error('ALLOWED_ORIGINS cannot include "*" when ALLOW_CREDENTIALS=true');
}
const rateLimitWindowMs = parseEnvInt("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000);
const rateLimitMax = parseEnvInt("RATE_LIMIT_MAX", 100);
if (rateLimitWindowMs < 1000) {
  throw new Error('RATE_LIMIT_WINDOW_MS must be at least 1000');
}

// -----------------------------------------------------------------------------
// Basic security & hardening
// -----------------------------------------------------------------------------

app.disable("x-powered-by");
// Trust first proxy (e.g., when behind a load balancer)
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(
  cors({
    origin(origin, callback) {
      if (allowedOrigins.length === 0) return callback(null, false);
      if (!origin) return callback(null, false);
      if (allowedOrigins.includes("*")) return callback(null, true);
      return callback(null, allowedOrigins.includes(origin));
    },
    credentials: allowCredentials,
    optionsSuccessStatus: 204,
  })
);
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
// JSend helpers (consistent error shape across all handlers)
// -----------------------------------------------------------------------------
// success: { status: "success", data }
// fail: { status: "fail", code, message, details? }
// error: { status: "error", message }

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
// Validation helpers
// -----------------------------------------------------------------------------

/**
 * Wrap express-validator checks into a JSend-aware middleware.
 */
function validate(validations, message) {
  return async (req, res, next) => {
    await Promise.all(validations.map((validation) => validation.run(req)));
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();
    return sendFail(res, 400, message, { validation: errors.array() });
  };
}

// -----------------------------------------------------------------------------
// Repository pattern (single-file friendly)
// -----------------------------------------------------------------------------
//
// By convention, a "TaskRepository" exposes these async methods:
//
// - list({ limit, offset, done, search, sort, order }) -> { items, total }
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
    async list({ limit, offset, done, search, sort, order }) {
      let filtered = tasks;

      if (done !== undefined) filtered = filtered.filter((t) => t.done === done);
      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter((t) => t.title.toLowerCase().includes(searchLower));
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
    async list({ limit, offset, done, search, sort, order }) {
      const whereClauses = [];
      const queryParams = [];
      let paramIndex = 1;

      if (done !== undefined) {
        whereClauses.push(`done = $${paramIndex++}`);
        queryParams.push(done);
      }

      if (search) {
        whereClauses.push(`title ILIKE $${paramIndex++} ESCAPE '\\'`);
        queryParams.push(`%${escapeLike(search)}%`);
      }

      const whereClause = whereClauses.length
        ? `WHERE ${whereClauses.join(" AND ")}`
        : "";

      // Deterministic order + tie-breaker
      const sortColumn = SORT_COLUMN[sort] || "id";
      const sortDirection = order === "desc" ? "DESC" : "ASC";

      // For stable pagination, tie-break on id. (Always ASC tie-break.)
      const orderBy =
        sortColumn === "id"
          ? `ORDER BY id ${sortDirection}`
          : `ORDER BY ${sortColumn} ${sortDirection}, id ASC`;

      // Single query with window function for total (count before LIMIT/OFFSET).
      const sql = `
        SELECT id, title, done, (COUNT(*) OVER())::int AS total
        FROM tasks
        ${whereClause}
        ${orderBy}
        LIMIT $${paramIndex++} OFFSET $${paramIndex++};
      `;
      const boundParams = queryParams.concat([limit, offset]);
      const result = await pool.query(sql, boundParams);
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
  taskRepo = InMemoryTaskRepository([]);
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
const v1RateLimiter = rateLimit({
  windowMs: rateLimitWindowMs,
  limit: rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    sendFail(res, 429, "Too many requests, please try again later.");
  },
});

v1.use(v1RateLimiter);

v1.get(
  "/tasks",
  validate(
    [
      query("limit").optional().isInt({ min: 0, max: 100 }).toInt(),
      query("offset").optional().isInt({ min: 0 }).toInt(),
      query("done").optional().isBoolean().toBoolean(),
      query("sort").optional().isIn(["id", "title", "done"]),
      query("order").optional().isIn(["asc", "desc"]),
          query("search").optional().trim(),
    ],
    "Invalid query parameters."
  ),
  async (req, res, next) => {
    try {
      const data = matchedData(req, { locations: ["query"] });
      const limit = data.limit ?? 20;
      const offset = data.offset ?? 0;
      const done = data.done;
      const sort = data.sort ?? "id";
      const order = data.order ?? "asc";

      const search = typeof data.search === "string" ? data.search : "";
      const searchFilter = search.length > 0 ? search : undefined;

      const { items, total } = await taskRepo.list({
        limit,
        offset,
        done,
        search: searchFilter,
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
          search: searchFilter,
        },
        sort: { field: sort, order },
      });
    } catch (err) {
      next(err);
    }
  }
);

v1.get(
  "/tasks/:id",
  validate([param("id").isInt({ min: 1 }).toInt()], "Invalid task id."),
  async (req, res, next) => {
    try {
      const { id } = matchedData(req, { locations: ["params"] });
      const task = await taskRepo.getById(id);
      if (!task) return sendFail(res, 404, "Task not found.");

      sendSuccess(res, task);
    } catch (err) {
      next(err);
    }
  }
);

v1.post(
  "/tasks",
  validate(
    [
      body("title").isString().trim().notEmpty(),
      body("done").isBoolean().toBoolean(),
    ],
    "Invalid task payload."
  ),
  async (req, res, next) => {
    try {
      const data = matchedData(req, { locations: ["body"] });
      const created = await taskRepo.create({
        title: data.title,
        done: data.done,
      });

      sendSuccess(res, created, 201);
    } catch (err) {
      next(err);
    }
  }
);

v1.put(
  "/tasks/:id",
  validate(
    [
      param("id").isInt({ min: 1 }).toInt(),
      body("title").isString().trim().notEmpty(),
      body("done").isBoolean().toBoolean(),
    ],
    "Invalid task payload."
  ),
  async (req, res, next) => {
    try {
      const { id } = matchedData(req, { locations: ["params"] });
      const data = matchedData(req, { locations: ["body"] });
      const updated = await taskRepo.update(id, {
        title: data.title,
        done: data.done,
      });

      if (!updated) return sendFail(res, 404, "Task not found.");
      sendSuccess(res, updated);
    } catch (err) {
      next(err);
    }
  }
);

v1.delete(
  "/tasks/:id",
  validate([param("id").isInt({ min: 1 }).toInt()], "Invalid task id."),
  async (req, res, next) => {
    try {
      const { id } = matchedData(req, { locations: ["params"] });
      const ok = await taskRepo.delete(id);
      if (!ok) return sendFail(res, 404, "Task not found.");

      sendSuccess(res, { deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

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
