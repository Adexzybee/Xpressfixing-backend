// Allow Railway to find our port
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'xpressfixing';
const JWT_SECRET = process.env.JWT_SECRET || 'xpressfixing_temp_secret_change_in_production';

// ========== MIDDLEWARE ==========

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'https://xpressfixing-frontend.vercel.app'];

app.use(cors({
  origin: function(origin, callback) {
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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' }
});
app.use(limiter);

// ========== JWT AUTHENTICATION MIDDLEWARE ==========
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Optional: Admin-only middleware
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ 
      error: 'Forbidden: Admin access required',
      currentRole: req.user?.role || 'none'
    });
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

// ========== DATABASE CONNECTIONS ==========
let db;
let customersCollection;
let engineersCollection;
let bookingsCollection;
let paymentsCollection;
let usersCollection;
let chatsCollection;
let notificationsCollection;
let dispatchRidersCollection;

async function createNotification(userId, type, title, message, data = {}) {
  if (!notificationsCollection) return;
  const notification = {
    id: Date.now(),
    userId: userId,
    type: type,
    title: title,
    message: message,
    data: data,
    read: false,
    createdAt: new Date().toISOString(),
    deleted: false
  };
  await notificationsCollection.insertOne(notification);
  return notification;
}

// ========== START SERVER ==========
async function startServer() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ Connected to MongoDB!');
    
    db = client.db(DB_NAME);
    
    customersCollection = db.collection('customers');
    engineersCollection = db.collection('engineers');
    bookingsCollection = db.collection('bookings');
    paymentsCollection = db.collection('payments');
    usersCollection = db.collection('users');
    chatsCollection = db.collection('chats');
    notificationsCollection = db.collection('notifications');
    dispatchRidersCollection = db.collection('dispatch_riders');
    
    const userCount = await usersCollection.countDocuments();
    if (userCount === 0) {
      console.log('📝 Adding demo data...');
      
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash('demo123', saltRounds);
      
      await usersCollection.insertMany([
        { id: 1, name: "Admin User", email: "admin@xpressfixing.com", password: hashedPassword, role: "admin", status: "active", createdAt: new Date().toISOString() },
        { id: 2, name: "Demo Customer", email: "customer@xpressfixing.com", password: hashedPassword, role: "customer", status: "active", createdAt: new Date().toISOString() },
        { id: 3, name: "Demo Engineer", email: "engineer@xpressfixing.com", password: hashedPassword, role: "engineer", status: "active", createdAt: new Date().toISOString() }
      ]);
      
      await customersCollection.insertMany([
        { id: 2, name: "Demo Customer", email: "customer@xpressfixing.com", phone: "08123456789", location: "Lagos", status: "active", totalSpent: 0, bookingsCount: 0, createdAt: new Date().toISOString() }
      ]);
      
      await engineersCollection.insertMany([
        { id: 3, name: "Demo Engineer", email: "engineer@xpressfixing.com", phone: "08034567890", speciality: "iPhone/iOS", location: "Lagos", rating: 4.9, jobsCompleted: 0, earnings: 0, status: "active", createdAt: new Date().toISOString() }
      ]);
      
      await dispatchRidersCollection.insertMany([
        { id: 1, name: 'Musa Danladi', phone: '0812 000 1111', vehicle: 'Bajaj Boxer', status: 'available', activeJobs: 0, totalDeliveries: 0, rating: 4.8, joinedAt: new Date().toISOString() },
        { id: 2, name: 'Chuka Obi', phone: '0905 222 3333', vehicle: 'Honda Bike', status: 'available', activeJobs: 0, totalDeliveries: 0, rating: 4.9, joinedAt: new Date().toISOString() }
      ]);
      
      console.log('✅ Demo data added');
    }
    
    console.log('✅ Database collections ready');
    
    // ========== PUBLIC ROUTES (No authentication required) ==========
    
    app.post('/api/auth/login', async (req, res) => {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }
      
      const user = await usersCollection.findOne({ email: email });
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      
      // Create JWT token
      const token = jwt.sign(
        { 
          id: user.id, 
          email: user.email, 
          role: user.role,
          status: user.status 
        }, 
        JWT_SECRET, 
        { expiresIn: '7d' }
      );
      
      res.json({
        success: true,
        token: token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status
        }
      });
    });
    
    app.post('/api/auth/register', async (req, res) => {
      const { name, email, phone, location, password } = req.body;
      
      if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email, and password required' });
      }
      
      const existingUser = await usersCollection.findOne({ email: email });
      if (existingUser) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      
      const newId = Date.now();
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      
      await usersCollection.insertOne({
        id: newId,
        name,
        email,
        password: hashedPassword,
        role: 'customer',
        status: 'active',
        createdAt: new Date().toISOString()
      });
      
      await customersCollection.insertOne({
        id: newId,
        name,
        email,
        phone,
        location,
        status: 'active',
        totalSpent: 0,
        bookingsCount: 0,
        createdAt: new Date().toISOString()
      });
      
      res.json({
        success: true,
        user: {
          id: newId,
          name,
          email,
          role: 'customer',
          status: 'active'
        }
      });
    });
    
    app.post('/api/auth/apply-engineer', async (req, res) => {
      const { name, email, phone, location, specialities, experience, motivation, password } = req.body;
      
      if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email, and password required' });
      }
      
      const existingUser = await usersCollection.findOne({ email: email });
      if (existingUser) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      
      const newId = Date.now();
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      
      await usersCollection.insertOne({
        id: newId,
        name,
        email,
        password: hashedPassword,
        role: 'engineer',
        status: 'pending',
        appliedAt: new Date().toISOString()
      });
      
      await engineersCollection.insertOne({
        id: newId,
        name,
        email,
        phone,
        location,
        speciality: specialities,
        experience,
        motivation,
        rating: 0,
        jobsCompleted: 0,
        earnings: 0,
        status: 'pending',
        appliedAt: new Date().toISOString()
      });
      
      res.json({
        success: true,
        message: 'Application submitted! Pending admin approval.'
      });
    });
    
    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'OK', message: 'Xpressfixing API is running', port: PORT });
    });
    
    // ========== PROTECTED ROUTES (Authentication required) ==========
    // All routes below this line require a valid JWT token
    
    // Apply authentication middleware to all protected routes
    app.use(authenticateToken);
    
    // ========== CUSTOMER ROUTES ==========
    app.get('/api/customers', requireAdmin, async (req, res) => {
      const customers = await customersCollection.find({}).toArray();
      res.json(customers);
    });
    
    app.get('/api/customers/:id', async (req, res) => {
      const id = parseInt(req.params.id);
      // Users can only view their own profile unless admin
      if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const customer = await customersCollection.findOne({ id: id });
      if (customer) {
        res.json(customer);
      } else {
        res.status(404).json({ error: 'Customer not found' });
      }
    });
    
    app.put('/api/customers/:id', async (req, res) => {
      const id = parseInt(req.params.id);
      if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      await customersCollection.updateOne({ id: id }, { $set: req.body });
      const updated = await customersCollection.findOne({ id: id });
      res.json({ success: true, customer: updated });
    });
    
    // ========== ENGINEER ROUTES ==========
    app.get('/api/engineers', requireAdmin, async (req, res) => {
      const engineers = await engineersCollection.find({}).toArray();
      res.json(engineers);
    });
    
    app.get('/api/engineers/:id', async (req, res) => {
      const id = parseInt(req.params.id);
      if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const engineer = await engineersCollection.findOne({ id: id });
      if (engineer) {
        res.json(engineer);
      } else {
        res.status(404).json({ error: 'Engineer not found' });
      }
    });
    
    app.put('/api/engineers/:id', requireAdmin, async (req, res) => {
      const id = parseInt(req.params.id);
      await engineersCollection.updateOne({ id: id }, { $set: req.body });
      const engineer = await engineersCollection.findOne({ id: id });
      await usersCollection.updateOne({ email: engineer.email }, { $set: { status: engineer.status } });
      res.json({ success: true, engineer: engineer });
    });
    
    app.delete('/api/engineers/:id', requireAdmin, async (req, res) => {
      const id = parseInt(req.params.id);
      const engineer = await engineersCollection.findOne({ id: id });
      if (engineer) {
        await engineersCollection.deleteOne({ id: id });
        await usersCollection.deleteOne({ email: engineer.email });
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Engineer not found' });
      }
    });
    
    // ========== BOOKING ROUTES ==========
    app.get('/api/bookings', requireAdmin, async (req, res) => {
      const bookings = await bookingsCollection.find({}).toArray();
      res.json(bookings);
    });
    
    app.get('/api/bookings/customer/:customerId', async (req, res) => {
      const customerId = parseInt(req.params.customerId);
      if (req.user.role !== 'admin' && req.user.id !== customerId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const bookings = await bookingsCollection.find({ customerId: customerId }).toArray();
      res.json(bookings);
    });
    
    app.get('/api/bookings/engineer/:engineerId', async (req, res) => {
      const engineerId = parseInt(req.params.engineerId);
      if (req.user.role !== 'admin' && req.user.id !== engineerId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const bookings = await bookingsCollection.find({ engineerId: engineerId }).toArray();
      res.json(bookings);
    });
    
    app.post('/api/bookings', async (req, res) => {
      if (!req.body.customerId || !req.body.device || !req.body.address) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // Ensure customer can only create bookings for themselves
      if (req.user.role !== 'admin' && req.body.customerId !== req.user.id) {
        return res.status(403).json({ error: 'Cannot create booking for another user' });
      }
      
      const sanitize = (str) => {
        if (typeof str !== 'string') return str;
        return str.replace(/[<>]/g, '');
      };
      
      const newBooking = {
        ...req.body,
        id: `XF-${Date.now()}`,
        createdAt: new Date().toISOString(),
        status: 'pending_engineer'
      };
      
      if (newBooking.device) newBooking.device = sanitize(newBooking.device);
      if (newBooking.address) newBooking.address = sanitize(newBooking.address);
      if (newBooking.issue) newBooking.issue = sanitize(newBooking.issue);
      if (newBooking.customerName) newBooking.customerName = sanitize(newBooking.customerName);
      
      await bookingsCollection.insertOne(newBooking);
      
      await customersCollection.updateOne(
        { id: newBooking.customerId },
        { $inc: { bookingsCount: 1 } }
      );
      
      if (newBooking.engineerId) {
        await createNotification(
          newBooking.engineerId,
          'booking',
          '🔧 New Repair Request!',
          `${newBooking.customerName} needs their ${newBooking.device} repaired.`,
          { bookingId: newBooking.id }
        );
      }
      
      res.json({ success: true, booking: newBooking });
    });
    
    app.put('/api/bookings/:id', async (req, res) => {
      const id = req.params.id;
      const booking = await bookingsCollection.findOne({ id: id });
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      // Check authorization
      if (req.user.role !== 'admin' && 
          req.user.role !== 'engineer' && 
          booking.customerId !== req.user.id) {
        return res.status(403).json({ 
          error: 'Not authorized to update this booking',
          yourRole: req.user.role,
          yourId: req.user.id,
          bookingCustomerId: booking.customerId
        });
      }
      
      const newStatus = req.body.status;
      const oldStatus = booking.status;
      
      if (newStatus && newStatus !== oldStatus) {
        if (!canTransition(oldStatus, newStatus)) {
          return res.status(400).json({ 
            error: `Invalid status transition: ${oldStatus} → ${newStatus}`,
            allowed: allowedTransitions[oldStatus]
          });
        }
      }
      
      let updateFields = { ...req.body };
      if (req.body.amount && req.body.amount !== booking.amount) {
        updateFields.counterAmount = null;
      }
      
      await bookingsCollection.updateOne({ id: id }, { $set: updateFields });
      
      if (newStatus === 'completed' && oldStatus !== 'completed') {
        const allCompleted = await bookingsCollection.find({
          engineerId: booking.engineerId,
          status: 'completed'
        }).toArray();
        
        const totalEarnings = allCompleted.reduce((sum, b) => sum + (b.amount * 0.8), 0);
        const ratedBookings = allCompleted.filter(b => b.customerRating);
        const totalRating = ratedBookings.reduce((sum, b) => sum + b.customerRating, 0);
        const avgRating = ratedBookings.length > 0 ? totalRating / ratedBookings.length : 0;
        
        await engineersCollection.updateOne(
          { id: booking.engineerId },
          { 
            $set: { 
              earnings: totalEarnings,
              jobsCompleted: allCompleted.length,
              rating: parseFloat(avgRating.toFixed(1))
            }
          }
        );
      }
      
      const updated = await bookingsCollection.findOne({ id: id });
      
      if (newStatus && newStatus !== oldStatus) {
        await createNotification(
          booking.customerId,
          'status_update',
          '📱 Repair Status Update',
          `Your repair (${id}) status changed to ${newStatus}`,
          { bookingId: id, oldStatus, newStatus }
        );
      }
      
      res.json({ success: true, booking: updated });
    });
    
    app.put('/api/bookings/:id/accept-price', async (req, res) => {
      const id = req.params.id;
      const booking = await bookingsCollection.findOne({ id: id });
      
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      if (booking.customerId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      
      if (booking.status !== 'negotiating') {
        return res.status(400).json({ error: `Cannot accept price. Current status: ${booking.status}` });
      }
      
      await bookingsCollection.updateOne(
        { id: id },
        { $set: { status: 'payment_pending', priceAcceptedAt: new Date().toISOString() } }
      );
      
      res.json({ success: true, booking: await bookingsCollection.findOne({ id: id }) });
    });
    
    app.put('/api/bookings/:id/counter-offer', async (req, res) => {
      const id = req.params.id;
      const { counterAmount } = req.body;
      const booking = await bookingsCollection.findOne({ id: id });
      
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      if (booking.customerId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      
      if (booking.status !== 'negotiating') {
        return res.status(400).json({ error: `Cannot counter offer. Current status: ${booking.status}` });
      }
      
      if (!counterAmount || counterAmount < 1000) {
        return res.status(400).json({ error: 'Counter offer must be at least ₦1,000' });
      }
      
      await bookingsCollection.updateOne(
        { id: id },
        { $set: { counterAmount: counterAmount, status: 'negotiating' } }
      );
      
      await createNotification(
        booking.engineerId,
        'counter_offer',
        '💬 Counter Offer Received',
        `${booking.customerName} offered ₦${counterAmount.toLocaleString()} for the repair`,
        { bookingId: booking.id, counterAmount }
      );
      
      res.json({ success: true, booking: await bookingsCollection.findOne({ id: id }) });
    });
    
    // ========== PAYMENT ROUTES ==========
    app.get('/api/payments', requireAdmin, async (req, res) => {
      const payments = await paymentsCollection.find({}).toArray();
      res.json(payments);
    });
    
    // ========== STATS ROUTES ==========
    app.get('/api/stats', requireAdmin, async (req, res) => {
      const customersCount = await customersCollection.countDocuments();
      const engineersCount = await engineersCollection.countDocuments();
      const bookingsCount = await bookingsCollection.countDocuments();
      const activeEngineers = await engineersCollection.countDocuments({ status: 'active' });
      const pendingEngineers = await engineersCollection.countDocuments({ status: 'pending' });
      
      res.json({
        totalCustomers: customersCount,
        activeCustomers: customersCount,
        totalEngineers: engineersCount,
        activeEngineers: activeEngineers,
        pendingEngineers: pendingEngineers,
        totalBookings: bookingsCount,
        monthlyBookings: bookingsCount,
        totalRevenue: 0,
        monthlyRevenue: 0
      });
    });
    
    // ========== CHAT ROUTES ==========
    app.get('/api/chats/:bookingId', async (req, res) => {
      const bookingId = req.params.bookingId;
      const booking = await bookingsCollection.findOne({ id: bookingId });
      
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      // Check if user is involved in this chat
      if (req.user.role !== 'admin' && 
          booking.customerId !== req.user.id && 
          booking.engineerId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized to view this chat' });
      }
      
      const chats = await chatsCollection.find({ bookingId: bookingId }).toArray();
      
      // Mark messages as read
      await chatsCollection.updateMany(
        { 
          bookingId: bookingId, 
          sender: { $ne: req.user.role },
          read: false 
        },
        { $set: { read: true, readAt: new Date().toISOString() } }
      );
      
      res.json(chats);
    });
    
    app.post('/api/chats', async (req, res) => {
      if (!req.body.bookingId || !req.body.message) {
        return res.status(400).json({ error: 'Booking ID and message required' });
      }
      
      const booking = await bookingsCollection.findOne({ id: req.body.bookingId });
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      // Verify user is part of this conversation
      if (req.user.role !== 'admin' && 
          booking.customerId !== req.user.id && 
          booking.engineerId !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized to send message' });
      }
      
      const newMessage = {
        id: Date.now(),
        bookingId: req.body.bookingId,
        sender: req.user.role,
        senderName: req.body.senderName || req.user.name,
        message: req.body.message,
        timestamp: req.body.timestamp || Date.now(),
        read: false
      };
      await chatsCollection.insertOne(newMessage);
      
      res.json({ success: true, message: newMessage });
    });
    
    app.get('/api/chats/unread/:userId/:role', async (req, res) => {
      const userId = parseInt(req.params.userId);
      const role = req.params.role;
      
      if (req.user.id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      let bookings;
      if (role === 'customer') {
        bookings = await bookingsCollection.find({ customerId: userId }).toArray();
      } else {
        bookings = await bookingsCollection.find({ engineerId: userId }).toArray();
      }
      
      const bookingIds = bookings.map(b => b.id);
      
      const unreadCounts = {};
      for (const bookingId of bookingIds) {
        const count = await chatsCollection.countDocuments({
          bookingId: bookingId,
          sender: { $ne: role },
          read: false
        });
        if (count > 0) {
          unreadCounts[bookingId] = count;
        }
      }
      
      res.json({ unreadCounts });
    });
    
    // ========== NOTIFICATION ROUTES ==========
    app.get('/api/notifications/:userId', async (req, res) => {
      const userId = parseInt(req.params.userId);
      if (req.user.id !== userId && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
      const notifications = await notificationsCollection.find({ userId: userId, deleted: false }).toArray();
      res.json(notifications);
    });
    
    app.get('/api/notifications/:userId/unread', async (req, res) => {
      const userId = parseInt(req.params.userId);
      if (req.user.id !== userId && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
      const count = await notificationsCollection.countDocuments({ userId: userId, read: false, deleted: false });
      res.json({ count: count });
    });
    
    app.put('/api/notifications/:id/read', async (req, res) => {
      const id = parseInt(req.params.id);
      await notificationsCollection.updateOne({ id: id }, { $set: { read: true } });
      res.json({ success: true });
    });
    
    // ========== DISPATCH ROUTES ==========
    app.get('/api/dispatch/jobs', requireAdmin, async (req, res) => {
      const dispatchJobs = await bookingsCollection.find({
        status: { $in: ['negotiating', 'dispatch_assigned', 'with_engineer', 'inrepair', 'dispatch_return'] }
      }).toArray();
      res.json(dispatchJobs);
    });
    
    app.get('/api/dispatch/riders', requireAdmin, async (req, res) => {
      const riders = await dispatchRidersCollection.find({}).toArray();
      res.json(riders);
    });
    
    app.post('/api/dispatch/riders', requireAdmin, async (req, res) => {
      const newRider = {
        id: Date.now(),
        ...req.body,
        status: 'available',
        createdAt: new Date().toISOString()
      };
      await dispatchRidersCollection.insertOne(newRider);
      res.json({ success: true, rider: newRider });
    });
    
    // ========== ERROR HANDLER ==========
    app.use((err, req, res, next) => {
      console.error('❌ Error:', err.message);
      res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
      });
    });
    
    // ========== START SERVER ==========
    app.listen(PORT, () => {
      console.log(`\n╔═══════════════════════════════════════════════════╗`);
      console.log(`║     🚀 XPRESSFIXING BACKEND SERVER RUNNING       ║`);
      console.log(`╚═══════════════════════════════════════════════════╝`);
      console.log(`\n📍 Port: ${PORT}`);
      console.log(`🗄️  Database: ${MONGODB_URI.includes('localhost') ? 'Local MongoDB' : 'MongoDB Atlas'}`);
      console.log(`🔐 JWT Authentication: ENABLED`);
      console.log(`\n🔑 Demo Accounts:`);
      console.log(`   👑 Admin:    admin@xpressfixing.com / demo123`);
      console.log(`   👤 Customer: customer@xpressfixing.com / demo123`);
      console.log(`   🔧 Engineer: engineer@xpressfixing.com / demo123`);
      console.log(`\n✅ Server ready for Railway!`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();