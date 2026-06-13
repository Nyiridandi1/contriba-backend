require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── ROUTES ──
app.use('/api/auth', require('./routes/auth'));
app.use('/api/events', require('./routes/events'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/dashboard', require('./routes/dashboard'));

// ── TEST ROUTE ──
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Contriba API is running!',
    version: '1.0.0',
    routes: [
      'POST /api/auth/send-otp',
      'POST /api/auth/verify-otp',
      'GET  /api/events',
      'POST /api/events',
      'GET  /api/events/:id',
      'POST /api/contributions/initiate',
      'GET  /api/wallet',
      'POST /api/wallet/withdraw',
      'GET  /api/notifications',
      'GET  /api/dashboard',
    ]
  });
});

// ── 404 HANDLER ──
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// ── ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
  });
});

// ── START SERVER ──
app.listen(PORT, () => {
  console.log('Contriba API running on port ' + PORT);
  console.log('All routes ready!');
});