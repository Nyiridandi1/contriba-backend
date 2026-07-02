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

    const eventIds = events?.map(e => e.id) || [];
    let recentContributions = [];
    let allContributions = [];
    let totalContributors = 0;
    let totalRaised = 0;

    if (eventIds.length > 0) {
      // ✅ Get ALL successful contributions to calculate real totals
      const { data: allContribs } = await supabase
        .from('contributions')
        .select('*')
        .in('event_id', eventIds)
        .eq('status', 'success')
        .order('created_at', { ascending: false });

      allContributions = allContribs || [];

      // ✅ Calculate real total raised from contributions
      totalRaised = allContributions.reduce(
        (sum, c) => sum + Number(c.amount || 0), 0
      );
      totalContributors = allContributions.length;

      // Recent 10 for display
      recentContributions = allContributions.slice(0, 10);
    }

    // ✅ Calculate total raised per event
    const eventsWithRaised = (events || []).map(event => {
      const eventContribs = allContributions.filter(
        c => c.event_id === event.id
      );
      const eventRaised = eventContribs.reduce(
        (sum, c) => sum + Number(c.amount || 0), 0
      );
      return {
        ...event,
        total_raised: eventRaised,
        total_contributors: eventContribs.length,
      };
    });

    // Get unread notifications count
    const { data: notifications } = await supabase
      .from('notifications')
      .select('id')
      .eq('user_id', req.user.userId)
      .eq('is_read', false);

    const unreadNotifications = notifications?.length || 0;

    res.json({
      success: true,
      dashboard: {
        total_events: events?.length || 0,
        total_raised: totalRaised,
        total_contributors: totalContributors,
        wallet_balance: wallet?.balance || 0,
        unread_notifications: unreadNotifications,
        events: eventsWithRaised,
        recent_contributions: recentContributions,
      },
    });

  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get dashboard data' });
  }
});

module.exports = router;