const express = require('express');
const router = express.Router();
const supabase = require('../config/database');

// ── MIDDLEWARE: Verify JWT Token ──
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
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
    const {
      title, type, date, location, description,
      goal_amount, owner_phone, owner_payment_method,
      cover_image, photo2_url, photo3_url, photo4_url,
      is_private, // ✅ new field
    } = req.body;

    if (!title) return res.status(400).json({ success: false, message: 'Event title is required' });
    if (!owner_phone) return res.status(400).json({ success: false, message: 'Owner phone number is required' });

    const shareLink = `https://contriba.rw/e/${title.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;

    const { data: event, error } = await supabase
      .from('events')
      .insert({
        owner_id: req.user.userId,
        title, type, date, location, description,
        goal_amount: goal_amount || 0,
        share_link: shareLink,
        status: 'active',
        owner_phone: owner_phone || null,
        owner_payment_method: owner_payment_method || 'mtn',
        cover_image: cover_image || null,
        photo2_url: photo2_url || null,
        photo3_url: photo3_url || null,
        photo4_url: photo4_url || null,
        is_private: is_private || false, // ✅ save privacy setting
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, message: 'Event created successfully', event });

  } catch (err) {
    console.error('Create event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create event' });
  }
});

// ── GET /api/events ── Get All Public Events only
router.get('/', async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .eq('status', 'active')
      .eq('is_private', false)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const eventIds = events?.map((event) => event.id) || [];

    if (eventIds.length === 0) {
      return res.json({ success: true, events: [] });
    }

    const { data: contributions, error: contributionsError } = await supabase
      .from('contributions')
      .select('id, event_id, amount, status')
      .in('event_id', eventIds);

    if (contributionsError) throw contributionsError;

    const eventsWithStats = events.map((event) => {
      const successfulContributions = (contributions || []).filter(
        (item) => item.event_id === event.id && item.status === 'success'
      );

      const totalRaised = successfulContributions.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0
      );

      return {
        ...event,
        total_raised: totalRaised,
        total_contributors: successfulContributions.length,
      };
    });

    res.json({ success: true, events: eventsWithStats });

  } catch (err) {
    console.error('Get events error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get events' });
  }
});

// ── GET /api/events/my-events ── Get Owner's Events (all — public + private)
router.get('/my-events', verifyToken, async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .eq('owner_id', req.user.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, events });

  } catch (err) {
    console.error('Get my events error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get events' });
  }
});

// ── GET /api/events/:id ── Get Single Event (public or private via link)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: event, error } = await supabase
      .from('events').select('*').eq('id', id).single();

    if (error || !event) return res.status(404).json({ success: false, message: 'Event not found' });

    // ✅ Fetch creator profile
    const { data: creator } = await supabase
      .from('users')
      .select('id, name, phone, avatar_url')
      .eq('id', event.owner_id)
      .single();

    const { data: contributions } = await supabase
      .from('contributions')
      .select('id, contributor_name, amount, message, is_anonymous, created_at, status')
      .eq('event_id', id)
      .order('created_at', { ascending: false });

    const successfulContributions = contributions?.filter(c => c.status === 'success') || [];
    const totalRaised = successfulContributions.reduce((sum, c) => sum + c.amount, 0);
    const totalContributors = successfulContributions.length;

    const publicFeed = contributions?.map(c => ({
      id: c.id,
      name: c.is_anonymous ? 'Anonymous 🙈' : c.contributor_name,
      message: c.message,
      is_anonymous: c.is_anonymous,
      created_at: c.created_at,
      status: c.status,
      amount: c.is_anonymous ? null : c.amount,
    })) || [];

    // ✅ Get total likes
    const { count: likesCount } = await supabase
      .from('event_likes')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', id);

    res.json({
      success: true,
      event: {
        ...event,
        total_raised: totalRaised,
        total_contributors: totalContributors,
        total_likes: likesCount || 0,
        creator: creator || null,
      },
      public_feed: publicFeed,
    });

  } catch (err) {
    console.error('Get event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get event' });
  }
});

// ── GET /api/events/:id/contributions ── Get Full Contributions (Owner only)
router.get('/:id/contributions', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: event } = await supabase.from('events').select('owner_id').eq('id', id).single();
    if (!event || event.owner_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { data: contributions, error } = await supabase
      .from('contributions').select('*').eq('event_id', id).order('created_at', { ascending: false });

    if (error) throw error;

    const totalRaised = contributions?.filter(c => c.status === 'success').reduce((sum, c) => sum + c.amount, 0) || 0;

    res.json({
      success: true,
      contributions,
      total_raised: totalRaised,
      total_contributors: contributions?.filter(c => c.status === 'success').length || 0,
    });

  } catch (err) {
    console.error('Get contributions error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get contributions' });
  }
});

// ── PUT /api/events/:id ── Update Event
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, type, date, location, description,
      goal_amount, owner_phone, owner_payment_method,
      cover_image, photo2_url, photo3_url, photo4_url,
      is_private, // ✅ allow updating privacy
    } = req.body;

    const { data: event, error } = await supabase
      .from('events')
      .update({
        title, type, date, location, description,
        goal_amount, owner_phone, owner_payment_method,
        cover_image, photo2_url, photo3_url, photo4_url,
        is_private: is_private || false, // ✅ update privacy
      })
      .eq('id', id)
      .eq('owner_id', req.user.userId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, message: 'Event updated successfully', event });

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
      .from('events').update({ status: 'deleted' }).eq('id', id).eq('owner_id', req.user.userId);
    if (error) throw error;
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (err) {
    console.error('Delete event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete event' });
  }
});

// ── POST /api/events/:id/like ── Like Event
router.post('/:id/like', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing } = await supabase
      .from('event_likes')
      .select('id')
      .eq('event_id', id)
      .eq('user_id', req.user.userId)
      .single();

    if (existing) {
      return res.json({ success: true, liked: true, message: 'Already liked' });
    }

    const { error } = await supabase
      .from('event_likes')
      .insert({ event_id: id, user_id: req.user.userId });

    if (error) throw error;

    const { count } = await supabase
      .from('event_likes')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', id);

    res.json({ success: true, liked: true, likes: count });

  } catch (err) {
    console.error('Like event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to like event' });
  }
});

// ── DELETE /api/events/:id/like ── Unlike Event
router.delete('/:id/like', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('event_likes')
      .delete()
      .eq('event_id', id)
      .eq('user_id', req.user.userId);

    if (error) throw error;

    const { count } = await supabase
      .from('event_likes')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', id);

    res.json({ success: true, liked: false, likes: count });

  } catch (err) {
    console.error('Unlike event error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to unlike event' });
  }
});

// ── GET /api/events/:id/likes ── Get Like Count + User Like Status
router.get('/:id/likes', async (req, res) => {
  try {
    const { id } = req.params;

    const { count } = await supabase
      .from('event_likes')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', id);

    // Check if current user liked (optional auth)
    const token = req.headers.authorization?.split(' ')[1];
    let userLiked = false;

    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { data: existing } = await supabase
          .from('event_likes')
          .select('id')
          .eq('event_id', id)
          .eq('user_id', decoded.userId)
          .single();
        userLiked = !!existing;
      } catch {
        // Invalid token — skip
      }
    }

    res.json({ success: true, likes: count || 0, liked: userLiked });

  } catch (err) {
    console.error('Get likes error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get likes' });
  }
});

module.exports = router;