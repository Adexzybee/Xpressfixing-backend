const mongoose = require('mongoose');

const dispatchRiderSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  vehicle: { type: String, trim: true },
  status: { type: String, enum: ['available', 'busy', 'offline'], default: 'available' },
  activeJobs: { type: Number, default: 0 },
  totalDeliveries: { type: Number, default: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  joinedAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('DispatchRider', dispatchRiderSchema);