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

// ── POST /api/events ── Create Event
router.post('/', verifyToken, async (req, res) => {
  try {
    const { title, type, date, location, description, goal_amount } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'Event title is required' });
    }

    // Generate share link
    const shareLink = `https://contriba.rw/e/${title.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;

    // Create event
    const { data: event, error } = await supabase
      .from('events')
      .insert({
        owner_id: req.user.userId,
        title,
        type,
        date,
        location,
        description,
        goal_amount: goal_amount || 0,
        share_link: shareLink,
        status: 'active',
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Event created successfully',
      event,
    });

  } catch (err) {
    console.error('Create event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create event' });
  }
});

// ── GET /api/events ── Get All Events
router.get('/', async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      events,
    });

  } catch (err) {
    console.error('Get events error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get events' });
  }
});

// ── GET /api/events/my-events ── Get Owner's Events
router.get('/my-events', verifyToken, async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .eq('owner_id', req.user.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      events,
    });

  } catch (err) {
    console.error('Get my events error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get events' });
  }
});

// ── GET /api/events/:id ── Get Single Event
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: event, error } = await supabase
      .from('events')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    // Get total contributions
    const { data: contributions } = await supabase
      .from('contributions')
      .select('amount')
      .eq('event_id', id)
      .eq('status', 'success');

    const totalRaised = contributions?.reduce((sum, c) => sum + c.amount, 0) || 0;
    const totalContributors = contributions?.length || 0;

    res.json({
      success: true,
      event: {
        ...event,
        total_raised: totalRaised,
        total_contributors: totalContributors,
      },
    });

  } catch (err) {
    console.error('Get event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get event' });
  }
});

// ── PUT /api/events/:id ── Update Event
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, type, date, location, description, goal_amount } = req.body;

    const { data: event, error } = await supabase
      .from('events')
      .update({ title, type, date, location, description, goal_amount })
      .eq('id', id)
      .eq('owner_id', req.user.userId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Event updated successfully',
      event,
    });

  } catch (err) {
    console.error('Update event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update event' });
  }
});

// ── DELETE /api/events/:id ── Delete Event
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('events')
      .update({ status: 'deleted' })
      .eq('id', id)
      .eq('owner_id', req.user.userId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Event deleted successfully',
    });

  } catch (err) {
    console.error('Delete event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete event' });
  }
});

module.exports = router;