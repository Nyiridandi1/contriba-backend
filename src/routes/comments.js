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

// ── GET /api/comments/:event_id ── Get Comments for Event
router.get('/:event_id', async (req, res) => {
  try {
    const { event_id } = req.params;

    const { data: comments, error } = await supabase
      .from('comments')
      .select('*')
      .eq('event_id', event_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, comments });

  } catch (err) {
    console.error('Get comments error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get comments' });
  }
});

// ── POST /api/comments/:event_id ── Add Comment
router.post('/:event_id', async (req, res) => {
  try {
    const { event_id } = req.params;
    const { message, name, is_anonymous } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    const { data: comment, error } = await supabase
      .from('comments')
      .insert({
        event_id,
        name: is_anonymous ? 'Anonymous' : (name || 'Guest'),
        message,
        is_anonymous: is_anonymous || false,
      })
      .select()
      .single();

    if (error) throw error;

    // ── Notify event owner about new comment ──
    const { data: event } = await supabase
      .from('events')
      .select('owner_id, title')
      .eq('id', event_id)
      .single();

    if (event) {
      // ✅ Save event_id in notification
      await supabase.from('notifications').insert({
        user_id: event.owner_id,
        title: '💬 New Comment!',
        message: `${is_anonymous ? 'Someone' : name} commented on "${event.title}"`,
        type: 'comment',
        event_id: event_id,
      });

      // Send push notification
      const { data: owner } = await supabase
        .from('users')
        .select('push_token')
        .eq('id', event.owner_id)
        .single();

      if (owner?.push_token) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: owner.push_token,
            sound: 'default',
            title: '💬 New Comment!',
            body: `${is_anonymous ? 'Someone' : name} commented: "${message}"`,
            data: { type: 'comment', event_id },
          }),
        });
      }
    }

    res.json({ success: true, comment });

  } catch (err) {
    console.error('Add comment error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add comment' });
  }
});

// ── DELETE /api/comments/:id ── Delete Comment (owner only)
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('comments')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.userId);

    if (error) throw error;

    res.json({ success: true, message: 'Comment deleted' });

  } catch (err) {
    console.error('Delete comment error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete comment' });
  }
});

module.exports = router;