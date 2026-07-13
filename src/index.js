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
app.use('/api/payments', require('./routes/payments'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/share', require('./routes/share'));
app.use('/share', require('./routes/publicShare'));

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
      'POST /api/payments/cashin',
      'GET  /api/payments/status/:ref',
      'POST /api/payments/cashout',
      'GET  /api/comments/:event_id',
      'POST /api/comments/:event_id',
      'POST /api/upload/avatar',

      'GET  /api/settings',
      'PUT  /api/settings/profile',
      'PUT  /api/settings/preferences',
      'PUT  /api/settings/notifications',
      'PUT  /api/settings/security',
      'PUT  /api/settings/payment',
      'PUT  /api/settings/appearance',
      'PUT  /api/settings/ai',
      'POST /api/settings/change-pin',
      'POST /api/settings/logout-all',
      'DELETE /api/settings/account',

      'GET  /api/share/overview/:eventId',
      'POST /api/share/track',
      'POST /api/share/visit',
      'POST /api/share/qr-scan',
      'GET  /api/share/analytics/:eventId',
      'GET  /api/share/promoters/:eventId',
      'GET  /api/share/insights/:eventId',
    ],
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