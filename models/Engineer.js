const mongoose = require('mongoose');

const engineerSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  location: { type: String, trim: true },
  speciality: { type: mongoose.Schema.Types.Mixed },
  experience: { type: String, trim: true },
  motivation: { type: String, trim: true },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  jobsCompleted: { type: Number, default: 0 },
  earnings: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'pending', 'suspended'], default: 'pending' },
  appliedAt: { type: String, default: () => new Date().toISOString() },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('Engineer', engineerSchema);