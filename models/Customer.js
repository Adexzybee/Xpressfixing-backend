const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  location: { type: String, trim: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  totalSpent: { type: Number, default: 0 },
  bookingsCount: { type: Number, default: 0 },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('Customer', customerSchema);