const express = require('express');
const router = express.Router();
const supabase = require('../config/database');

// ── MIDDLEWARE: Verify JWT Token ──
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'No token provided',
    });
  }

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }
};

// ── GET /api/notifications ── Get All Notifications
router.get('/', verifyToken, async (req, res) => {
  try {
    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const unreadCount = notifications.filter(
      (notification) => !notification.is_read
    ).length;

    return res.json({
      success: true,
      notifications,
      unread_count: unreadCount,
    });
  } catch (err) {
    console.error('Get notifications error:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to get notifications',
    });
  }
});

// ── PUT /api/notifications/:id/read ── Mark as Read
router.put('/:id/read', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', req.user.userId)
      .select('id');

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
    }

    return res.json({
      success: true,
      message: 'Notification marked as read',
    });
  } catch (err) {
    console.error('Mark read error:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to mark notification',
    });
  }
});

// ── PUT /api/notifications/read-all ── Mark All as Read
router.put('/read-all', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.userId)
      .eq('is_read', false);

    if (error) throw error;

    return res.json({
      success: true,
      message: 'All notifications marked as read',
    });
  } catch (err) {
    console.error('Mark all read error:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to mark notifications',
    });
  }
});

// ── DELETE /api/notifications/:id ── Delete One Notification
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.userId)
      .select('id');

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
    }

    return res.json({
      success: true,
      message: 'Notification deleted successfully',
      deleted_id: id,
    });
  } catch (err) {
    console.error('Delete notification error:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to delete notification',
    });
  }
});

// ── DELETE /api/notifications ── Delete All Notifications
router.delete('/', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .delete()
      .eq('user_id', req.user.userId)
      .select('id');

    if (error) throw error;

    return res.json({
      success: true,
      message: 'All notifications deleted successfully',
      deleted_count: data?.length || 0,
    });
  } catch (err) {
    console.error('Delete all notifications error:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to delete notifications',
    });
  }
});

module.exports = router;