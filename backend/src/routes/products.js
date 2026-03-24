const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');

// GET /api/products - public browse
router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as count FROM products WHERE quantity > 0').get().count;
  const products = db.prepare(`
    SELECT p.*, u.name as farmer_name
    FROM products p
    JOIN users u ON p.farmer_id = u.id
    WHERE p.quantity > 0
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    data: products,
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// GET /api/products/:id
router.get('/:id', (req, res) => {
  const product = db.prepare(`
    SELECT p.*, u.name as farmer_name, u.stellar_public_key as farmer_wallet
    FROM products p
    JOIN users u ON p.farmer_id = u.id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// POST /api/products - farmer only
router.post('/', auth, validate.product, (req, res) => {
  if (req.user.role !== 'farmer')
    return res.status(403).json({ error: 'Only farmers can list products' });

  const { name, description, price, quantity, unit } = req.body;

  const result = db.prepare(
    'INSERT INTO products (farmer_id, name, description, price, quantity, unit) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, name, description || '', price, quantity, unit || 'unit');

  res.json({ id: result.lastInsertRowid, message: 'Product listed' });
});

// GET /api/products/mine/list - farmer's own products
router.get('/mine/list', auth, (req, res) => {
  if (req.user.role !== 'farmer')
    return res.status(403).json({ error: 'Farmers only' });

  const products = db.prepare('SELECT * FROM products WHERE farmer_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(products);
});

// DELETE /api/products/:id
router.delete('/:id', auth, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND farmer_id = ?').get(req.params.id, req.user.id);
  if (!product) return res.status(404).json({ error: 'Not found or not yours' });
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
