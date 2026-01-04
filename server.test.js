"use strict";

/**
 * Contract tests: the SAME suite runs against both repository implementations.
 *
 * Run:
 *   npm test
 *
 * Postgres runs when DATABASE_URL is set in the env file.
 *
 * Postgres schema assumed:
 *   CREATE TABLE tasks (
 *     id SERIAL PRIMARY KEY,
 *     title TEXT NOT NULL,
 *     done BOOLEAN NOT NULL DEFAULT FALSE
 *   );
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { app, InMemoryTaskRepository, PostgresTaskRepository, logger } = require("./server");

// -----------------------------------------------------------------------------
// Shared contract suite
// -----------------------------------------------------------------------------

/**
 * Defines the repository contract tests.
 * @param {string} name - suite label
 */
function defineRepoContractSuite(name) {
  test.describe(`TaskRepository contract: ${name}`, () => {
    let repo;
    let contractPool; // for postgres
    let cleanupContractPool;
    let contractClient;
    let nonExistentId;

    test.before(async () => {
      if (name === 'postgres') {
        if (!process.env.DATABASE_URL) {
          throw new Error('DATABASE_URL environment variable is required for Postgres tests');
        }
        try {
          const { Pool } = await import('pg');
          contractPool = new Pool({ connectionString: process.env.DATABASE_URL });
          // Test the connection
          const client = await contractPool.connect();
          client.release();
          await contractPool.query("TRUNCATE TABLE tasks RESTART IDENTITY;");
          cleanupContractPool = async () => { await contractPool.end(); };
        } catch (err) {
          console.error('Failed to setup Postgres pool:', err.message);
          if (contractPool) {
            try { await contractPool.end(); } catch (e) { /* ignore */ }
          }
          throw err;
        }
      } else {
        cleanupContractPool = async () => {};
      }
    });

    test.after(async () => {
      await cleanupContractPool();
    });

    test.beforeEach(async () => {
      if (name === 'postgres') {
        try {
          contractClient = await contractPool.connect();
          await contractClient.query("BEGIN");
          repo = PostgresTaskRepository(contractClient);
        } catch (err) {
          if (contractClient) {
            contractClient.release();
            contractClient = null;
          }
          console.error('Test setup failed: unable to start transaction', err);
          throw err;
        }
      } else {
        repo = InMemoryTaskRepository([]);
      }
      nonExistentId = -1; // guaranteed invalid since IDs are positive
    });

    test.afterEach(async () => {
      if (name === 'postgres' && contractClient) {
        try {
          await contractClient.query("ROLLBACK");
        } finally {
          contractClient.release();
          contractClient = null;
        }
      }
    });

    test("list() returns deterministic ordering and correct totals", async () => {
      // seed data
      await repo.create({ title: "Buy milk", done: false });
      await repo.create({ title: "Walk dog", done: true });
      await repo.create({ title: "Buy bread", done: false });
      // Add duplicate titles to test tie-breaker
      await repo.create({ title: "Same title", done: false });
      await repo.create({ title: "Same title", done: true });

      // sort by title asc; tie-breaker should be by id asc
      const r1 = await repo.list({
        limit: 50,
        offset: 0,
        done: undefined,
        q: undefined,
        sort: "title",
        order: "asc",
      });

      assert.equal(r1.total, 5);
      assert.equal(r1.items.length, 5);

      assert.deepEqual(
        r1.items.map((t) => t.title),
        ["Buy bread", "Buy milk", "Same title", "Same title", "Walk dog"]
      );

      // Verify tie-breaker: same titles should be ordered by id asc
      const sameTitleItems = r1.items.filter((t) => t.title === "Same title");
      assert.equal(sameTitleItems.length, 2);
      assert.ok(sameTitleItems[0].id < sameTitleItems[1].id);

      // pagination should be stable across pages
      const page1 = await repo.list({
        limit: 2,
        offset: 0,
        done: undefined,
        q: undefined,
        sort: "title",
        order: "asc",
      });

      const page2 = await repo.list({
        limit: 2,
        offset: 2,
        done: undefined,
        q: undefined,
        sort: "title",
        order: "asc",
      });

      assert.equal(page1.items.length, 2);
      assert.equal(page2.items.length, 2);
      assert.equal(page1.total, 5);
      assert.equal(page2.total, 5);

      assert.deepEqual(
        [...page1.items, ...page2.items].map((t) => t.title),
        ["Buy bread", "Buy milk", "Same title", "Same title"]
      );
    });

    test("filters: done and q behave consistently", async () => {
      // seed data
      await repo.create({ title: "Buy milk", done: false });
      await repo.create({ title: "Walk dog", done: true });
      await repo.create({ title: "Buy bread", done: false });

      const doneFalse = await repo.list({
        limit: 50,
        offset: 0,
        done: false,
        q: undefined,
        sort: "id",
        order: "asc",
      });

      assert.equal(doneFalse.items.length, 2);
      assert.ok(doneFalse.items.every((t) => t.done === false));

      const qBuy = await repo.list({
        limit: 50,
        offset: 0,
        done: undefined,
        q: "buy",
        sort: "id",
        order: "asc",
      });

      assert.equal(qBuy.items.length, 2);
      assert.ok(qBuy.items.every((t) => t.title.toLowerCase().includes("buy")));
    });

    test("getById returns created task and null for missing id", async () => {
      const created = await repo.create({ title: "New task", done: false });

      const got = await repo.getById(created.id);
      assert.ok(got);
      assert.equal(got.id, created.id);
      assert.equal(got.title, "New task");
      assert.equal(got.done, false);

      const missing = await repo.getById(nonExistentId);
      assert.equal(missing, null);
    });

    test("update returns updated task and null when missing", async () => {
      const created = await repo.create({ title: "Old", done: false });

      const updated = await repo.update(created.id, { title: "New", done: true });
      assert.ok(updated);
      assert.equal(updated.id, created.id);
      assert.equal(updated.title, "New");
      assert.equal(updated.done, true);

      const missing = await repo.update(nonExistentId, { title: "X", done: false });
      assert.equal(missing, null);
    });

    test("delete returns true when deleted and false when missing", async () => {
      const created = await repo.create({ title: "Temp", done: false });

      const ok = await repo.delete(created.id);
      assert.equal(ok, true);

      const gone = await repo.getById(created.id);
      assert.equal(gone, null);

      const missing = await repo.delete(nonExistentId);
      assert.equal(missing, false);
    });
  });
}

// -----------------------------------------------------------------------------
// Run against in-memory and (optionally) Postgres
// -----------------------------------------------------------------------------

test.describe("TaskRepository contract", () => {
  defineRepoContractSuite("in-memory");

  const DATABASE_URL = process.env.DATABASE_URL;

  if (DATABASE_URL) {
    defineRepoContractSuite("postgres");
  } else {
    test("postgres suite skipped (DATABASE_URL not set)", () => {
      assert.ok(true);
    });
  }
});

test.describe("HTTP API", () => {
  // NOTE: These tests mutate shared app state (app.locals.pgPool).
  // Run test files with concurrency disabled, or keep this block non-concurrent.
  test.after(async () => {
    if (app.locals.pgPool) {
      await app.locals.pgPool.end();
      app.locals.pgPool = null;
    }
  });

  async function withServer(handler) {
    return withServerForApp(app, handler);
  }

  async function withServerForApp(appInstance, handler) {
    const server = appInstance.listen(0);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await handler(baseUrl);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function withEnv(env, fn) {
    const previous = {};
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  function loadServerFresh(env) {
    let loaded;
    withEnv(env, () => {
      delete require.cache[require.resolve("./server")];
      loaded = require("./server");
    });
    return {
      ...loaded,
      cleanup() {
        delete require.cache[require.resolve("./server")];
      },
    };
  }

  test("non-/v1 404 returns JSend response", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      assert.equal(res.status, 404);

      const body = await res.json();
      assert.equal(body.status, "fail");
      assert.equal(body.message, "Not found");
    });
  });

  test("health check returns 503 when database is unavailable", async () => {
    const originalLoggerError = logger.error;
    logger.error = () => {};

    const originalPool = app.locals.pgPool;
    app.locals.pgPool = {
      async query() {
        throw new Error("db down");
      },
    };

    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/health`);
        assert.equal(res.status, 503);

        const body = await res.json();
        assert.equal(body.status, "error");
        assert.equal(body.message, "Service unavailable");
      });
    } finally {
      app.locals.pgPool = originalPool;
      logger.error = originalLoggerError;
    }
  });

  test("root returns minimal JSend success payload", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.status, "success");
      assert.equal(body.data.service, "tasks-api");
      assert.equal(body.data.status, "ok");
      assert.ok(body.data.timestamp);
      assert.equal(body.data.db, undefined);
    });
  });

  test("responses include X-Request-ID header", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);
      const requestId = res.headers.get("x-request-id");
      assert.ok(requestId);
    });
  });

  test("cors denies when allowlist is empty", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`, {
        headers: { Origin: "https://example.com" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });
  });

  test("cors allows listed origins and blocks others", async () => {
    const { app: corsApp, cleanup } = loadServerFresh({
      ALLOWED_ORIGINS: "https://example.com, https://api.example.com",
      ALLOW_CREDENTIALS: "false",
      DATABASE_URL: "",
    });

    try {
      await withServerForApp(corsApp, async (baseUrl) => {
        const allowed = await fetch(`${baseUrl}/`, {
          headers: { Origin: "https://example.com" },
        });
        assert.equal(allowed.status, 200);
        assert.equal(
          allowed.headers.get("access-control-allow-origin"),
          "https://example.com"
        );

        const blocked = await fetch(`${baseUrl}/`, {
          headers: { Origin: "https://blocked.example.com" },
        });
        assert.equal(blocked.status, 200);
        assert.equal(blocked.headers.get("access-control-allow-origin"), null);
      });
    } finally {
      cleanup();
    }
  });

  async function resetPostgresIfEnabled() {
    if (!app.locals.pgPool) return;
    try {
      await app.locals.pgPool.query("TRUNCATE TABLE tasks RESTART IDENTITY;");
    } catch (err) {
      throw new Error(`Failed to truncate tasks table: ${err.message}`);
    }
  }

  test("v1: POST validates payload and returns JSend fail", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "", done: "nope" }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.status, "fail");
      assert.equal(body.message, "Invalid task payload.");
      assert.ok(body.details);
    });
  });

  test("v1: list pagination returns JSend envelope", async () => {
    await resetPostgresIfEnabled();

    await withServer(async (baseUrl) => {
      const create = (title) => fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, done: false }),
      });

      await create("Task A");
      await create("Task B");

      const res = await fetch(`${baseUrl}/v1/tasks?limit=1&offset=0&sort=id&order=asc`);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.status, "success");
      assert.ok(Array.isArray(body.data.items));
      assert.equal(body.data.page.limit, 1);
      assert.equal(body.data.page.offset, 0);
      assert.equal(body.data.page.returned, body.data.items.length);
      assert.ok(body.data.page.total >= 2);
      assert.equal(body.data.sort.field, "id");
      assert.equal(body.data.sort.order, "asc");
    });
  });
});
