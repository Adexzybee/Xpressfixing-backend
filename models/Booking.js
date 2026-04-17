const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  customerId: { type: Number, required: true },
  customerName: { type: String, required: true, trim: true },
  engineerId: { type: Number },
  device: { type: String, required: true, trim: true },
  issue: { type: String, trim: true },
  address: { type: String, required: true, trim: true },
  amount: { type: Number },
  counterAmount: { type: Number },
  status: {
    type: String,
    enum: [
      'pending_engineer', 'negotiating', 'price_accepted',
      'payment_pending', 'payment_completed', 'payment_failed',
      'inrepair', 'dispatch_assigned', 'with_engineer',
      'dispatch_return', 'completed', 'cancelled'
    ],
    default: 'pending_engineer'
  },
  customerRating: { type: Number, min: 1, max: 5 },
  customerReview: { type: String, trim: true },
  priceAcceptedAt: { type: String },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('Booking', bookingSchema);