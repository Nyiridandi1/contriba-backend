const express = require('express');
const router = express.Router();
const supabase = require('../config/database');

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  try {
    const jwt = require('jsonwebtoken');
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

const defaultSettings = {
  preferences: {
    language: 'English',
    country: 'Rwanda',
    currency: 'RWF',
    timezone: 'Africa/Kigali',
    date_format: 'DD/MM/YYYY',
    number_format: '1,000.00',
  },
  notifications: {
    contribution_alerts: true,
    payment_alerts: true,
    email_notifications: true,
    push_notifications: true,
    weekly_reports: true,
    marketing_emails: false,
  },
  security: {
    two_factor_enabled: false,
    login_alerts: true,
    device_history_enabled: true,
    last_logout_all_at: null,
  },
  payment: {
    preferred_payout_method: 'MTN MoMo',
    payout_phone: '',
    payout_name: '',
    auto_withdraw: false,
    minimum_withdraw_amount: 500,
  },
  appearance: {
    theme: 'light',
    accent_color: '#E50914',
    compact_mode: false,
    reduce_motion: false,
  },
  ai: {
    enabled: true,
    smart_suggestions: true,
    weekly_ai_reports: true,
    growth_reminders: true,
    ai_language: 'English',
  },
};

const mergeSettings = (settings) => ({
  ...defaultSettings,
  ...(settings || {}),
  preferences: { ...defaultSettings.preferences, ...(settings?.preferences || {}) },
  notifications: { ...defaultSettings.notifications, ...(settings?.notifications || {}) },
  security: { ...defaultSettings.security, ...(settings?.security || {}) },
  payment: { ...defaultSettings.payment, ...(settings?.payment || {}) },
  appearance: { ...defaultSettings.appearance, ...(settings?.appearance || {}) },
  ai: { ...defaultSettings.ai, ...(settings?.ai || {}) },
});

const getOrCreateSettings = async (userId) => {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  if (data) return mergeSettings(data);

  const { data: created, error: createError } = await supabase
    .from('user_settings')
    .insert({
      user_id: userId,
      preferences: defaultSettings.preferences,
      notifications: defaultSettings.notifications,
      security: defaultSettings.security,
      payment: defaultSettings.payment,
      appearance: defaultSettings.appearance,
      ai: defaultSettings.ai,
    })
    .select()
    .single();

  if (createError) throw createError;

  return mergeSettings(created);
};

const updateSection = async (userId, section, body) => {
  const current = await getOrCreateSettings(userId);

  const nextSection = {
    ...current[section],
    ...(body || {}),
  };

  const { data, error } = await supabase
    .from('user_settings')
    .upsert(
      {
        user_id: userId,
        [section]: nextSection,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) throw error;

  return mergeSettings(data);
};

router.get('/', verifyToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, phone, avatar_url, email_verified, push_token, created_at')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const settings = await getOrCreateSettings(req.user.userId);

    res.json({ success: true, user, settings });
  } catch (err) {
    console.error('Get settings error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get settings' });
  }
});

router.put('/profile', verifyToken, async (req, res) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = String(req.body.name).trim();
    if (req.body.email !== undefined) updates.email = String(req.body.email).trim();
    if (req.body.phone !== undefined) updates.phone = String(req.body.phone).trim();

    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.userId)
      .select('id, name, email, phone, avatar_url, email_verified, push_token, created_at')
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Profile updated successfully', user });
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

router.put('/preferences', verifyToken, async (req, res) => {
  try {
    const settings = await updateSection(req.user.userId, 'preferences', req.body);
    res.json({ success: true, message: 'Preferences saved successfully', settings });
  } catch (err) {
    console.error('Preferences error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save preferences' });
  }
});

router.put('/notifications', verifyToken, async (req, res) => {
  try {
    const settings = await updateSection(req.user.userId, 'notifications', req.body);
    res.json({ success: true, message: 'Notifications saved successfully', settings });
  } catch (err) {
    console.error('Notifications error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save notifications' });
  }
});

router.put('/security', verifyToken, async (req, res) => {
  try {
    const settings = await updateSection(req.user.userId, 'security', req.body);
    res.json({ success: true, message: 'Security saved successfully', settings });
  } catch (err) {
    console.error('Security error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save security' });
  }
});

router.put('/payment', verifyToken, async (req, res) => {
  try {
    const settings = await updateSection(req.user.userId, 'payment', req.body);
    res.json({ success: true, message: 'Payment settings saved successfully', settings });
  } catch (err) {
    console.error('Payment settings error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save payment settings' });
  }
});

router.put('/appearance', verifyToken, async (req, res) => {
  try {
    const settings = await updateSection(req.user.userId, 'appearance', req.body);
    res.json({ success: true, message: 'Appearance saved successfully', settings });
  } catch (err) {
    console.error('Appearance error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save appearance' });
  }
});

router.put('/ai', verifyToken, async (req, res) => {
  try {
    const settings = await updateSection(req.user.userId, 'ai', req.body);
    res.json({ success: true, message: 'AI settings saved successfully', settings });
  } catch (err) {
    console.error('AI settings error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save AI settings' });
  }
});

router.post('/change-pin', verifyToken, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { old_pin, new_pin } = req.body;

    if (!old_pin || !new_pin) {
      return res.status(400).json({
        success: false,
        message: 'Current PIN and new PIN are required',
      });
    }

    if (String(new_pin).length < 4) {
      return res.status(400).json({
        success: false,
        message: 'New PIN must be at least 4 digits',
      });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, pin')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(String(old_pin), user.pin);

    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Wrong current PIN' });
    }

    const hashedPin = await bcrypt.hash(String(new_pin), 10);

    const { error: updateError } = await supabase
      .from('users')
      .update({ pin: hashedPin })
      .eq('id', req.user.userId);

    if (updateError) throw updateError;

    res.json({ success: true, message: 'PIN changed successfully' });
  } catch (err) {
    console.error('Change PIN error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to change PIN' });
  }
});

router.post('/logout-all', verifyToken, async (req, res) => {
  try {
    const settings = await updateSection(req.user.userId, 'security', {
      last_logout_all_at: new Date().toISOString(),
    });

    res.json({ success: true, message: 'All sessions marked for logout', settings });
  } catch (err) {
    console.error('Logout all error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to logout all sessions' });
  }
});

router.delete('/account', verifyToken, async (req, res) => {
  try {
    const { confirm } = req.body || {};

    if (confirm !== 'DELETE') {
      return res.status(400).json({
        success: false,
        message: 'Type DELETE to confirm account deletion',
      });
    }

    const { error } = await supabase
      .from('users')
      .update({
        deleted_at: new Date().toISOString(),
        name: 'Deleted User',
        email: null,
        phone: `deleted-${req.user.userId}`,
      })
      .eq('id', req.user.userId);

    if (error) throw error;

    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete account' });
  }
});

module.exports = router;