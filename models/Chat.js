const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  bookingId: { type: String, required: true },
  sender: { type: String, enum: ['customer', 'engineer', 'admin'], required: true },
  senderName: { type: String, trim: true },
  message: { type: String, required: true, trim: true },
  timestamp: { type: Number, default: () => Date.now() },
  read: { type: Boolean, default: false },
  readAt: { type: String }
});

module.exports = mongoose.model('Chat', chatSchema);