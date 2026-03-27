/**
 * Validation utilities for form inputs
 */

export function validateProduct(form) {
  const errors = {};

  // Name validation
  if (!form.name || !form.name.trim()) {
    errors.name = 'Product name is required';
  }

  // Price validation
  const price = parseFloat(form.price);
  if (!form.price || isNaN(price) || price <= 0) {
    errors.price = 'Price must be a positive number';
  }

  // Quantity validation
  const quantity = parseInt(form.quantity, 10);
  if (!form.quantity || isNaN(quantity) || quantity <= 0) {
    errors.quantity = 'Quantity must be a positive integer';
  }

  // Description validation (optional but if provided, must not be empty)
  if (form.description && form.description.trim().length > 500) {
    errors.description = 'Description cannot exceed 500 characters';
  }

  // Category validation
  const validCategories = ['vegetables', 'fruits', 'grains', 'dairy', 'herbs', 'other'];
  if (!form.category || !validCategories.includes(form.category)) {
    errors.category = 'Please select a valid category';
  }

  // Unit validation
  if (!form.unit || !form.unit.trim()) {
    errors.unit = 'Unit is required';
  }

  return errors;
}
