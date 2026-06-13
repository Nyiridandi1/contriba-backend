const express = require('express');
const router = express.Router();
const supabase = require('../config/database');

// ── MIDDLEWARE: Verify JWT Token ──
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ── GET /api/dashboard ── Get Dashboard Data
router.get('/', verifyToken, async (req, res) => {
  try {
    // Get user's events
    const { data: events } = await supabase
      .from('events')
      .select('*')
      .eq('owner_id', req.user.userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    // Get wallet
    const { data: wallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.userId)
      .single();

    // Get recent contributions for all user events
    const eventIds = events?.map(e => e.id) || [];
    let recentContributions = [];
    let totalContributors = 0;

    if (eventIds.length > 0) {
      const { data: contributions } = await supabase
        .from('contributions')
        .select('*')
        .in('event_id', eventIds)
        .eq('status', 'success')
        .order('created_at', { ascending: false })
        .limit(10);

      recentContributions = contributions || [];
      totalContributors = contributions?.length || 0;
    }

    // Get unread notifications count
    const { data: notifications } = await supabase
      .from('notifications')
      .select('id')
      .eq('user_id', req.user.userId)
      .eq('is_read', false);

    const unreadNotifications = notifications?.length || 0;

    // Calculate total raised across all events
    const totalRaised = events?.reduce((sum, e) => sum + (e.total_raised || 0), 0) || 0;

    res.json({
      success: true,
      dashboard: {
        total_events: events?.length || 0,
        total_raised: totalRaised,
        total_contributors: totalContributors,
        wallet_balance: wallet?.balance || 0,
        unread_notifications: unreadNotifications,
        events: events || [],
        recent_contributions: recentContributions,
      },
    });

  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get dashboard data' });
  }
});

module.exports = router;