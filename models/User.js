const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['customer', 'engineer', 'admin', 'rider'], required: true },
  status: { type: String, enum: ['active', 'pending', 'suspended'], default: 'active' },
  createdAt: { type: String, default: () => new Date().toISOString() },
  appliedAt: { type: String }
});

module.exports = mongoose.model('User', userSchema);