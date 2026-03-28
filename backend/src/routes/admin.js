const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');

// All admin routes require authentication + admin role
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// PATCH /api/admin/products/:id/feature — toggle featured status
router.patch('/products/:id/feature', auth, adminOnly, (req, res) => {
  const product = db.prepare('SELECT id, is_featured FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Accept explicit value from body, or toggle current value
  const newValue = req.body.featured !== undefined
    ? (req.body.featured ? 1 : 0)
    : (product.is_featured ? 0 : 1);

  db.prepare('UPDATE products SET is_featured = ? WHERE id = ?').run(newValue, product.id);

  res.json({ id: product.id, is_featured: newValue === 1 });
});

// GET /api/admin/products — list all products with featured status (for admin dashboard)
router.get('/products', auth, adminOnly, (req, res) => {
  const products = db.prepare(`
    SELECT p.*, u.name as farmer_name
    FROM products p
    JOIN users u ON p.farmer_id = u.id
    ORDER BY p.is_featured DESC, p.created_at DESC
  `).all();
  res.json(products);
});

module.exports = router;
