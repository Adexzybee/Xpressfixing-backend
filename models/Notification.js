const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  userId: { type: Number, required: true },
  type: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  read: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('Notification', notificationSchema);