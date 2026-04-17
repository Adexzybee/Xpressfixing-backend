const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  bookingId: { type: String, required: true },
  customerId: { type: Number, required: true },
  engineerId: { type: Number },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },
  method: { type: String, trim: true },
  reference: { type: String, trim: true },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('Payment', paymentSchema);