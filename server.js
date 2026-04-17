require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// ========== MODELS ==========
const User = require('./models/User');
const Customer = require('./models/Customer');
const Engineer = require('./models/Engineer');
const Booking = require('./models/Booking');
const Payment = require('./models/Payment');
const Chat = require('./models/Chat');
const Notification = require('./models/Notification');
const DispatchRider = require('./models/DispatchRider');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/xpressfixing';
app.set('trust proxy', 1);
// ========== FIX 1: JWT SECRET — No fallback in production ==========
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET environment variable is not set. Server will not start.');
  process.exit(1);
}

// ========== MIDDLEWARE ==========
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'https://xpressfixing-frontend.vercel.app', 'http://localhost:5173'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' }
});
app.use(limiter);

// ========== SANITIZATION ==========
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>]/g, '').trim();
}

// ========== JWT MIDDLEWARE ==========
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
}

// ========== BOOKING STATUS TRANSITIONS ==========
const allowedTransitions = {
  'pending_engineer': ['negotiating', 'cancelled'],
  'negotiating': ['price_accepted', 'cancelled'],
  'price_accepted': ['payment_pending', 'payment_completed', 'payment_failed', 'cancelled'],
  'payment_pending': ['payment_completed', 'payment_failed', 'cancelled'],
  'payment_failed': ['payment_pending', 'payment_completed', 'cancelled'],
  'payment_completed': ['inrepair', 'dispatch_assigned'],
  'dispatch_assigned': ['with_engineer'],
  'with_engineer': ['inrepair'],
  'inrepair': ['dispatch_return'],
  'dispatch_return': ['completed'],
  'completed': [],
  'cancelled': []
};

function canTransition(oldStatus, newStatus) {
  const allowed = allowedTransitions[oldStatus];
  return allowed && allowed.includes(newStatus);
}

// ========== NOTIFICATION HELPER ==========
async function createNotification(userId, type, title, message, data = {}) {
  try {
    const notification = new Notification({
      id: Date.now(),
      userId, type, title, message, data,
      read: false,
      deleted: false,
      createdAt: new Date().toISOString()
    });
    await notification.save();
    return notification;
  } catch (error) {
    console.error('Notification error:', error.message);
  }
}

// ========== START SERVER ==========
async function startServer() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB!');

    // ========== SEED DEMO DATA ==========
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      console.log('📝 Adding demo data...');
      const hashedPassword = await bcrypt.hash('demo123', 10);

      await User.insertMany([
        { id: 1, name: 'Admin User', email: 'admin@xpressfixing.com', password: hashedPassword, role: 'admin', status: 'active', createdAt: new Date().toISOString() },
        { id: 2, name: 'Demo Customer', email: 'customer@xpressfixing.com', password: hashedPassword, role: 'customer', status: 'active', createdAt: new Date().toISOString() },
        { id: 3, name: 'Demo Engineer', email: 'engineer@xpressfixing.com', password: hashedPassword, role: 'engineer', status: 'active', createdAt: new Date().toISOString() }
      ]);

      await Customer.insertMany([
        { id: 2, name: 'Demo Customer', email: 'customer@xpressfixing.com', phone: '08123456789', location: 'Abuja', status: 'active', totalSpent: 0, bookingsCount: 0, createdAt: new Date().toISOString() }
      ]);

      await Engineer.insertMany([
        { id: 3, name: 'Demo Engineer', email: 'engineer@xpressfixing.com', phone: '08034567890', speciality: 'iPhone/iOS', location: 'Abuja', rating: 4.9, jobsCompleted: 0, earnings: 0, status: 'active', createdAt: new Date().toISOString() }
      ]);

      await DispatchRider.insertMany([
        { id: 1, name: 'Musa Danladi', phone: '0812 000 1111', vehicle: 'Bajaj Boxer', status: 'available', activeJobs: 0, totalDeliveries: 0, rating: 4.8, joinedAt: new Date().toISOString() },
        { id: 2, name: 'Chuka Obi', phone: '0905 222 3333', vehicle: 'Honda Bike', status: 'available', activeJobs: 0, totalDeliveries: 0, rating: 4.9, joinedAt: new Date().toISOString() }
      ]);

      console.log('✅ Demo data added');
    }

    // ========== PUBLIC ROUTES ==========

    app.post('/api/auth/login', async (req, res) => {
      try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ error: 'Invalid email or password' });

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return res.status(401).json({ error: 'Invalid email or password' });

        const token = jwt.sign(
          { id: user.id, email: user.email, role: user.role, status: user.status },
          JWT_SECRET,
          { expiresIn: '7d' }
        );

        res.json({
          success: true, token,
          user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status }
        });
      } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.post('/api/auth/register', async (req, res) => {
      try {
        const { name, email, phone, location, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: 'Email already registered' });

        const newId = Date.now();
        const hashedPassword = await bcrypt.hash(password, 10);

        await User.create({ id: newId, name: sanitize(name), email: sanitize(email), password: hashedPassword, role: 'customer', status: 'active', createdAt: new Date().toISOString() });
        await Customer.create({ id: newId, name: sanitize(name), email: sanitize(email), phone: sanitize(phone), location: sanitize(location), status: 'active', totalSpent: 0, bookingsCount: 0, createdAt: new Date().toISOString() });

        res.json({ success: true, user: { id: newId, name, email, role: 'customer', status: 'active' } });
      } catch (error) {
        console.error('Register error:', error.message);
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.post('/api/auth/apply-engineer', async (req, res) => {
      try {
        const { name, email, phone, location, specialities, experience, motivation, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: 'Email already registered' });

        const newId = Date.now();
        const hashedPassword = await bcrypt.hash(password, 10);

        await User.create({ id: newId, name: sanitize(name), email: sanitize(email), password: hashedPassword, role: 'engineer', status: 'pending', appliedAt: new Date().toISOString() });
        await Engineer.create({ id: newId, name: sanitize(name), email: sanitize(email), phone: sanitize(phone), location: sanitize(location), speciality: specialities, experience: sanitize(experience), motivation: sanitize(motivation), rating: 0, jobsCompleted: 0, earnings: 0, status: 'pending', appliedAt: new Date().toISOString() });

        res.json({ success: true, message: 'Application submitted! Pending admin approval.' });
      } catch (error) {
        console.error('Apply engineer error:', error.message);
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.get('/health', (req, res) => {
      res.json({ status: 'OK', message: 'Xpressfixing API is running', port: PORT });
    });

    app.get('/api/public/engineer/:engineerId/reviews', async (req, res) => {
      try {
        const engineerId = parseInt(req.params.engineerId);
        const bookings = await Booking.find({ engineerId, status: 'completed', customerRating: { $exists: true, $ne: null } });
        const reviews = bookings.map(b => ({
          customerName: b.customerName,
          rating: b.customerRating,
          review: b.customerReview || 'No written review',
          date: b.createdAt
        }));
        res.json(reviews);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== PROTECTED ROUTES ==========
    app.use(authenticateToken);

    // ========== CUSTOMER ROUTES ==========
    app.get('/api/customers', requireAdmin, async (req, res) => {
      try {
        const customers = await Customer.find({});
        res.json(customers);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.get('/api/customers/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (req.user.role !== 'admin' && req.user.id !== id) return res.status(403).json({ error: 'Access denied' });
        const customer = await Customer.findOne({ id });
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        res.json(customer);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.put('/api/customers/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (req.user.role !== 'admin' && req.user.id !== id) return res.status(403).json({ error: 'Access denied' });
        const updated = await Customer.findOneAndUpdate({ id }, { $set: req.body }, { new: true, runValidators: true });
        res.json({ success: true, customer: updated });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== ENGINEER ROUTES ==========
    app.get('/api/engineers', async (req, res) => {
      try {
        const filter = req.user.role === 'admin' ? {} : { status: 'active' };
        const engineers = await Engineer.find(filter);
        res.json(engineers);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.get('/api/engineers/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (req.user.role !== 'admin' && req.user.role !== 'customer' && req.user.id !== id) return res.status(403).json({ error: 'Access denied' });
        const engineer = await Engineer.findOne({ id });
        if (!engineer) return res.status(404).json({ error: 'Engineer not found' });
        res.json(engineer);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.put('/api/engineers/:id', requireAdmin, async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        const engineer = await Engineer.findOneAndUpdate({ id }, { $set: req.body }, { new: true, runValidators: true });
        await User.findOneAndUpdate({ email: engineer.email }, { $set: { status: engineer.status } });
        res.json({ success: true, engineer });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.delete('/api/engineers/:id', requireAdmin, async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        const engineer = await Engineer.findOne({ id });
        if (!engineer) return res.status(404).json({ error: 'Engineer not found' });
        await Engineer.deleteOne({ id });
        await User.deleteOne({ email: engineer.email });
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== BOOKING ROUTES ==========
    app.get('/api/bookings', requireAdmin, async (req, res) => {
      try {
        const bookings = await Booking.find({});
        res.json(bookings);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.get('/api/bookings/customer/:customerId', async (req, res) => {
      try {
        const customerId = parseInt(req.params.customerId);
        if (req.user.role !== 'admin' && req.user.id !== customerId) return res.status(403).json({ error: 'Access denied' });
        const bookings = await Booking.find({ customerId });
        res.json(bookings);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.get('/api/bookings/engineer/:engineerId', async (req, res) => {
      try {
        const engineerId = parseInt(req.params.engineerId);
        if (req.user.role !== 'admin' && req.user.id !== engineerId) return res.status(403).json({ error: 'Access denied' });
        const bookings = await Booking.find({ engineerId });
        res.json(bookings);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.post('/api/bookings', async (req, res) => {
      try {
        if (!req.body.customerId || !req.body.device || !req.body.address) return res.status(400).json({ error: 'Missing required fields' });
        if (req.user.role !== 'admin' && req.body.customerId !== req.user.id) return res.status(403).json({ error: 'Cannot create booking for another user' });

        const newBooking = new Booking({
          ...req.body,
          id: `XF-${Date.now()}`,
          createdAt: new Date().toISOString(),
          status: 'pending_engineer',
          device: sanitize(req.body.device),
          address: sanitize(req.body.address),
          issue: sanitize(req.body.issue),
          customerName: sanitize(req.body.customerName)
        });

        await newBooking.save();
        await Customer.findOneAndUpdate({ id: newBooking.customerId }, { $inc: { bookingsCount: 1 } });

        if (newBooking.engineerId) {
          await createNotification(newBooking.engineerId, 'booking', '🔧 New Repair Request!', `${newBooking.customerName} needs their ${newBooking.device} repaired.`, { bookingId: newBooking.id });
        }

        res.json({ success: true, booking: newBooking });
      } catch (error) {
        console.error('Booking error:', error.message);
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.put('/api/bookings/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const booking = await Booking.findOne({ id });
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        if (req.user.role !== 'admin' && req.user.role !== 'engineer' && booking.customerId !== req.user.id) {
          return res.status(403).json({ error: 'Not authorized to update this booking' });
        }

        const newStatus = req.body.status;
        const oldStatus = booking.status;

        if (newStatus && newStatus !== oldStatus) {
          if (!canTransition(oldStatus, newStatus)) {
            return res.status(400).json({ error: `Invalid status transition: ${oldStatus} → ${newStatus}`, allowed: allowedTransitions[oldStatus] });
          }
        }

        let updateFields = { ...req.body };
        if (req.body.amount && req.body.amount !== booking.amount) updateFields.counterAmount = null;

        const updated = await Booking.findOneAndUpdate({ id }, { $set: updateFields }, { new: true, runValidators: true });

        if (newStatus === 'completed' && oldStatus !== 'completed') {
          const allCompleted = await Booking.find({ engineerId: booking.engineerId, status: 'completed' });
          const totalEarnings = allCompleted.reduce((sum, b) => sum + (b.amount * 0.8), 0);
          const ratedBookings = allCompleted.filter(b => b.customerRating);
          const avgRating = ratedBookings.length > 0 ? ratedBookings.reduce((sum, b) => sum + b.customerRating, 0) / ratedBookings.length : 0;
          await Engineer.findOneAndUpdate({ id: booking.engineerId }, { $set: { earnings: totalEarnings, jobsCompleted: allCompleted.length, rating: parseFloat(avgRating.toFixed(1)) } });
        }

        if (newStatus && newStatus !== oldStatus) {
          await createNotification(booking.customerId, 'status_update', '📱 Repair Status Update', `Your repair (${id}) status changed to ${newStatus}`, { bookingId: id, oldStatus, newStatus });
        }

        res.json({ success: true, booking: updated });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.put('/api/bookings/:id/accept-price', async (req, res) => {
      try {
        const id = req.params.id;
        const booking = await Booking.findOne({ id });
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        if (booking.customerId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        if (booking.status !== 'negotiating') return res.status(400).json({ error: `Cannot accept price. Current status: ${booking.status}` });

        const updated = await Booking.findOneAndUpdate({ id }, { $set: { status: 'payment_pending', priceAcceptedAt: new Date().toISOString() } }, { new: true });
        res.json({ success: true, booking: updated });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.put('/api/bookings/:id/counter-offer', async (req, res) => {
      try {
        const id = req.params.id;
        const { counterAmount } = req.body;
        const booking = await Booking.findOne({ id });
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        if (booking.customerId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
        if (booking.status !== 'negotiating') return res.status(400).json({ error: `Cannot counter offer. Current status: ${booking.status}` });
        if (!counterAmount || counterAmount < 1000) return res.status(400).json({ error: 'Counter offer must be at least ₦1,000' });

        const updated = await Booking.findOneAndUpdate({ id }, { $set: { counterAmount, status: 'negotiating' } }, { new: true });
        await createNotification(booking.engineerId, 'counter_offer', '💬 Counter Offer Received', `${booking.customerName} offered ₦${counterAmount.toLocaleString()} for the repair`, { bookingId: booking.id, counterAmount });

        res.json({ success: true, booking: updated });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== PAYMENT ROUTES ==========
    app.get('/api/payments', requireAdmin, async (req, res) => {
      try {
        const payments = await Payment.find({});
        res.json(payments);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== STATS ROUTES ==========
    app.get('/api/stats', requireAdmin, async (req, res) => {
      try {
        const [totalCustomers, totalEngineers, totalBookings, activeEngineers, pendingEngineers] = await Promise.all([
          Customer.countDocuments(),
          Engineer.countDocuments(),
          Booking.countDocuments(),
          Engineer.countDocuments({ status: 'active' }),
          Engineer.countDocuments({ status: 'pending' })
        ]);

        res.json({ totalCustomers, activeCustomers: totalCustomers, totalEngineers, activeEngineers, pendingEngineers, totalBookings, monthlyBookings: totalBookings, totalRevenue: 0, monthlyRevenue: 0 });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== CHAT ROUTES ==========
    app.get('/api/chats/:bookingId', async (req, res) => {
      try {
        const bookingId = req.params.bookingId;
        const booking = await Booking.findOne({ id: bookingId });
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        if (req.user.role !== 'admin' && booking.customerId !== req.user.id && booking.engineerId !== req.user.id) {
          return res.status(403).json({ error: 'Not authorized to view this chat' });
        }

        const chats = await Chat.find({ bookingId });
        await Chat.updateMany({ bookingId, sender: { $ne: req.user.role }, read: false }, { $set: { read: true, readAt: new Date().toISOString() } });

        res.json(chats);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.post('/api/chats', async (req, res) => {
      try {
        if (!req.body.bookingId || !req.body.message) return res.status(400).json({ error: 'Booking ID and message required' });

        const booking = await Booking.findOne({ id: req.body.bookingId });
        if (!booking) return res.status(404).json({ error: 'Booking not found' });

        if (req.user.role !== 'admin' && booking.customerId !== req.user.id && booking.engineerId !== req.user.id) {
          return res.status(403).json({ error: 'Not authorized to send message' });
        }

        const newMessage = new Chat({
          id: Date.now(),
          bookingId: req.body.bookingId,
          sender: req.user.role,
          senderName: req.body.senderName || req.user.name,
          message: sanitize(req.body.message),
          timestamp: req.body.timestamp || Date.now(),
          read: false
        });

        await newMessage.save();
        res.json({ success: true, message: newMessage });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.get('/api/chats/unread/:userId/:role', async (req, res) => {
      try {
        const userId = parseInt(req.params.userId);
        const role = req.params.role;
        if (req.user.id !== userId) return res.status(403).json({ error: 'Access denied' });

        const filter = role === 'customer' ? { customerId: userId } : { engineerId: userId };
        const bookings = await Booking.find(filter);
        const bookingIds = bookings.map(b => b.id);

        const unreadCounts = {};
        for (const bookingId of bookingIds) {
          const count = await Chat.countDocuments({ bookingId, sender: { $ne: role }, read: false });
          if (count > 0) unreadCounts[bookingId] = count;
        }

        res.json({ unreadCounts });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== NOTIFICATION ROUTES ==========
    app.get('/api/notifications/:userId', async (req, res) => {
      try {
        const userId = parseInt(req.params.userId);
        if (req.user.id !== userId && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
        const notifications = await Notification.find({ userId, deleted: false });
        res.json(notifications);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.get('/api/notifications/:userId/unread', async (req, res) => {
      try {
        const userId = parseInt(req.params.userId);
        if (req.user.id !== userId && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
        const count = await Notification.countDocuments({ userId, read: false, deleted: false });
        res.json({ count });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.put('/api/notifications/:id/read', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        await Notification.findOneAndUpdate({ id }, { $set: { read: true } });
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== DISPATCH ROUTES ==========
    app.get('/api/dispatch/jobs', requireAdmin, async (req, res) => {
      try {
        const dispatchJobs = await Booking.find({
          status: { $in: ['negotiating', 'dispatch_assigned', 'with_engineer', 'inrepair', 'dispatch_return'] }
        });
        res.json(dispatchJobs);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.get('/api/dispatch/riders', requireAdmin, async (req, res) => {
      try {
        const riders = await DispatchRider.find({});
        res.json(riders);
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    app.post('/api/dispatch/riders', requireAdmin, async (req, res) => {
      try {
        const newRider = new DispatchRider({ id: Date.now(), ...req.body, status: 'available', joinedAt: new Date().toISOString() });
        await newRider.save();
        res.json({ success: true, rider: newRider });
      } catch (error) {
        res.status(500).json({ error: 'Something went wrong' });
      }
    });

    // ========== ERROR HANDLER ==========
    app.use((err, req, res, next) => {
      console.error('❌ Error:', err.message);
      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
      });
    });

    // ========== START ==========
    app.listen(PORT, () => {
      console.log(`\n╔═══════════════════════════════════════════════════╗`);
      console.log(`║     🚀 XPRESSFIXING BACKEND SERVER RUNNING       ║`);
      console.log(`╚═══════════════════════════════════════════════════╝`);
      console.log(`\n📍 Port: ${PORT}`);
      console.log(`🗄️  Database: ${MONGODB_URI.includes('localhost') ? 'Local MongoDB' : 'MongoDB Atlas'}`);
      console.log(`🔐 JWT Authentication: ENABLED`);
      console.log(`📦 Mongoose Schema: ENABLED`);
      console.log(`✅ Server ready!`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();