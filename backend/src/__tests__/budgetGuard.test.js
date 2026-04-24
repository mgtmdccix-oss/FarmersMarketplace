/**
 * budgetGuard.test.js
 *
 * Tests for the atomic monthly budget guard.
 *
 * Key scenarios:
 *  - Only paid orders → budget check still works
 *  - Pending + paid orders → both counted
 *  - Zero budget → all orders rejected
 *  - Exact budget match → order at the limit is accepted
 *  - Race condition: two concurrent orders that individually fit but together exceed budget
 *    → exactly one succeeds, one is rejected
 */

const express = require('express');
const request = require('supertest');

// ---------------------------------------------------------------------------
// Minimal in-memory DB mock
// ---------------------------------------------------------------------------

let users = [];
let orders = [];
let nextOrderId = 1;

/**
 * Reset state between tests.
 */
function resetDb() {
  users = [];
  orders = [];
  nextOrderId = 1;
}

/**
 * Tiny synchronous lock to simulate advisory-lock serialisation in tests.
 * Real Postgres advisory locks are per-connection; here we use a JS mutex.
 */
const locks = new Map();
async function acquireLock(userId) {
  while (locks.get(userId)) {
    await new Promise((r) => setTimeout(r, 1));
  }
  locks.set(userId, true);
}
function releaseLock(userId) {
  locks.delete(userId);
}

// ---------------------------------------------------------------------------
// Mock db module
// ---------------------------------------------------------------------------

jest.mock('../db/schema', () => {
  const mod = {
    isPostgres: false, // use SQLite path in the guard
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      // SELECT monthly_budget FROM users WHERE id = $1
      if (s.includes('select') && s.includes('monthly_budget')) {
        const user = users.find((u) => u.id === params[0]);
        return { rows: user ? [{ monthly_budget: user.monthly_budget }] : [], rowCount: 1 };
      }

      // SELECT COALESCE(SUM(total_price)...) FROM orders WHERE buyer_id = $1 AND status IN (...)
      if (s.includes('coalesce') && s.includes('orders')) {
        const buyerId = params[0];
        const start = params[1];
        const end = params[2];
        const relevant = orders.filter(
          (o) =>
            o.buyer_id === buyerId &&
            ['pending', 'paid'].includes(o.status) &&
            o.created_at >= start &&
            o.created_at < end,
        );
        const spent = relevant.reduce((sum, o) => sum + o.total_price, 0);
        return { rows: [{ spent }], rowCount: 1 };
      }

      // INSERT INTO orders ... RETURNING id
      if (s.includes('insert into orders')) {
        const id = nextOrderId++;
        const order = {
          id,
          buyer_id: params[0],
          product_id: params[1] ?? 1,
          quantity: params[2] ?? 1,
          total_price: params[3],
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        orders.push(order);
        return { rows: [{ id }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  };
  return mod;
});

// ---------------------------------------------------------------------------
// Build a minimal Express app that wires the budget guard + a stub order route
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());

  // Inject req.user from test header
  app.use((req, _res, next) => {
    const userId = parseInt(req.headers['x-test-user-id'], 10);
    req.user = { id: userId, role: 'buyer' };
    next();
  });

  const budgetGuard = require('../routes/orderBudgetGuard');
  app.use('/api/orders', budgetGuard);

  // Stub order creation: inserts a pending order and returns 200
  app.post('/api/orders', async (req, res) => {
    const db = require('../db/schema');
    const { rows } = await db.query(
      'INSERT INTO orders (buyer_id, product_id, quantity, total_price) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.user.id, 1, 1, req.body.total_price],
    );
    res.json({ success: true, orderId: rows[0].id });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addUser(id, monthlyBudget) {
  users.push({ id, monthly_budget: monthlyBudget });
}

function addOrder(buyerId, totalPrice, status = 'paid') {
  orders.push({
    id: nextOrderId++,
    buyer_id: buyerId,
    total_price: totalPrice,
    status,
    created_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Monthly Budget Guard', () => {
  let app;

  beforeEach(() => {
    resetDb();
    jest.resetModules();
    // Re-require after resetModules so the mock is fresh
    jest.mock('../db/schema', () => {
      const mod = {
        isPostgres: false,
        async query(sql, params = []) {
          const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
          if (s.includes('select') && s.includes('monthly_budget')) {
            const user = users.find((u) => u.id === params[0]);
            return { rows: user ? [{ monthly_budget: user.monthly_budget }] : [], rowCount: 1 };
          }
          if (s.includes('coalesce') && s.includes('orders')) {
            const buyerId = params[0];
            const start = params[1];
            const end = params[2];
            const relevant = orders.filter(
              (o) =>
                o.buyer_id === buyerId &&
                ['pending', 'paid'].includes(o.status) &&
                o.created_at >= start &&
                o.created_at < end,
            );
            const spent = relevant.reduce((sum, o) => sum + o.total_price, 0);
            return { rows: [{ spent }], rowCount: 1 };
          }
          if (s.includes('insert into orders')) {
            const id = nextOrderId++;
            orders.push({
              id,
              buyer_id: params[0],
              product_id: params[1] ?? 1,
              quantity: params[2] ?? 1,
              total_price: params[3],
              status: 'pending',
              created_at: new Date().toISOString(),
            });
            return { rows: [{ id }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return mod;
    });
    app = buildApp();
  });

  // -------------------------------------------------------------------------
  // Basic cases
  // -------------------------------------------------------------------------

  test('no budget set → order always allowed', async () => {
    addUser(1, null);
    const res = await request(app)
      .post('/api/orders')
      .set('x-test-user-id', '1')
      .send({ total_price: 999 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('only paid orders → counted against budget', async () => {
    addUser(2, 100);
    addOrder(2, 80, 'paid'); // 80 already spent
    const res = await request(app)
      .post('/api/orders')
      .set('x-test-user-id', '2')
      .send({ total_price: 30 }); // 80 + 30 = 110 > 100
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('budget_exceeded');
  });

  test('pending + paid orders → both counted', async () => {
    addUser(3, 100);
    addOrder(3, 50, 'paid');
    addOrder(3, 40, 'pending'); // 50 + 40 = 90 already committed
    const res = await request(app)
      .post('/api/orders')
      .set('x-test-user-id', '3')
      .send({ total_price: 20 }); // 90 + 20 = 110 > 100
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('budget_exceeded');
  });

  test('failed orders → NOT counted against budget', async () => {
    addUser(4, 100);
    addOrder(4, 80, 'failed'); // failed orders don't count
    const res = await request(app)
      .post('/api/orders')
      .set('x-test-user-id', '4')
      .send({ total_price: 90 }); // only 0 spent → 90 < 100
    expect(res.status).toBe(200);
  });

  test('zero budget → all orders rejected', async () => {
    addUser(5, 0);
    const res = await request(app)
      .post('/api/orders')
      .set('x-test-user-id', '5')
      .send({ total_price: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('budget_exceeded');
  });

  test('exact budget match → order accepted', async () => {
    addUser(6, 100);
    addOrder(6, 60, 'paid');
    const res = await request(app)
      .post('/api/orders')
      .set('x-test-user-id', '6')
      .send({ total_price: 40 }); // 60 + 40 = 100 === budget → allowed
    expect(res.status).toBe(200);
  });

  test('override flag bypasses budget check', async () => {
    addUser(7, 50);
    addOrder(7, 50, 'paid'); // already at limit
    const res = await request(app)
      .post('/api/orders')
      .set('x-test-user-id', '7')
      .send({ total_price: 10, budget_override_confirmed: true });
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Race condition test
  //
  // Two concurrent requests for the same buyer, each individually valid but
  // together exceeding the budget.  The guard serialises via the advisory lock
  // (Postgres) or JS single-thread (SQLite mock).  Because the mock is
  // synchronous and the guard reads + the stub route writes atomically within
  // the same event-loop turn, we simulate the race by patching the mock to
  // delay the spend-sum query so both requests read the same initial value.
  //
  // Expected: exactly 1 success, 1 rejection.
  // -------------------------------------------------------------------------

  test('race condition: two concurrent orders individually valid but combined exceed budget', async () => {
    const BUDGET = 100;
    const ORDER_PRICE = 60; // each order is 60; together 120 > 100

    addUser(10, BUDGET);

    // Patch the db mock to introduce a tiny async gap between the spend-read
    // and the order-insert so both requests can interleave.
    const db = require('../db/schema');
    const originalQuery = db.query.bind(db);

    let spendReadCount = 0;
    db.query = async function (sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (s.includes('coalesce') && s.includes('orders')) {
        spendReadCount++;
        // Yield to allow the second request to also read spend before either inserts
        await new Promise((r) => setTimeout(r, 5));
      }
      return originalQuery(sql, params);
    };

    // Fire both requests simultaneously
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/orders')
        .set('x-test-user-id', '10')
        .send({ total_price: ORDER_PRICE }),
      request(app)
        .post('/api/orders')
        .set('x-test-user-id', '10')
        .send({ total_price: ORDER_PRICE }),
    ]);

    // Restore original query
    db.query = originalQuery;

    const statuses = [r1.status, r2.status].sort();

    // Exactly one should succeed (200) and one should be rejected (400)
    expect(statuses).toEqual([200, 400]);

    // The successful order must be in the DB
    const successfulOrders = orders.filter(
      (o) => o.buyer_id === 10 && o.status === 'pending',
    );
    expect(successfulOrders).toHaveLength(1);
    expect(successfulOrders[0].total_price).toBe(ORDER_PRICE);

    // Final DB spend must not exceed budget
    const totalSpent = orders
      .filter((o) => o.buyer_id === 10 && ['pending', 'paid'].includes(o.status))
      .reduce((sum, o) => sum + o.total_price, 0);
    expect(totalSpent).toBeLessThanOrEqual(BUDGET);
  });
});
