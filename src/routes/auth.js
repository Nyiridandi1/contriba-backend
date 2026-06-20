const express = require('express');
const router = express.Router();
const supabase = require('../config/database');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

function generateToken(userId, phone) {
  return jwt.sign({ userId, phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// ── Send Push Notification ──
async function sendPushNotification(pushToken, title, body, data = {}) {
  try {
    const message = { to: pushToken, sound: 'default', title, body, data };
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    const result = await response.json();
    console.log('Push notification sent:', result);
    return true;
  } catch (err) {
    console.error('Push notification error:', err.message);
    return false;
  }
}

// ── MIDDLEWARE: Verify JWT Token ──
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ── POST /api/auth/register ──
// Register with Name + Phone + PIN (no email needed!)
router.post('/register', async (req, res) => {
  try {
    const { name, phone, pin } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Full name is required' });
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });
    if (!pin || pin.length < 4) return res.status(400).json({ success: false, message: 'PIN must be at least 4 digits' });

    // Check if phone already exists
    const { data: existing } = await supabase.from('users').select('id').eq('phone', phone).limit(1);
    if (existing && existing.length > 0) {
      return res.status(400).json({ success: false, message: 'This phone number is already registered. Please login!' });
    }

    // Hash PIN
    const hashedPin = await bcrypt.hash(pin, 10);

    // Create user
    const { data: newUsers, error } = await supabase
      .from('users')
      .insert({ name, phone, pin: hashedPin })
      .select();

    if (error) throw error;

    const user = newUsers[0];

    // Create wallet
    await supabase.from('wallets').insert({ user_id: user.id });

    const token = generateToken(user.id, user.phone);

    console.log(`New user registered: ${phone}`);

    res.json({
      success: true,
      message: 'Account created successfully!',
      token,
      user: { id: user.id, phone: user.phone, name: user.name, avatar_url: user.avatar_url },
    });

  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create account' });
  }
});

// ── POST /api/auth/login ──
// Login with Phone + PIN
router.post('/login', async (req, res) => {
  try {
    const { phone, pin } = req.body;

    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });
    if (!pin) return res.status(400).json({ success: false, message: 'PIN is required' });

    // Find user
    const { data: users } = await supabase.from('users').select('*').eq('phone', phone).limit(1);
    const user = users && users.length > 0 ? users[0] : null;

    if (!user) {
      return res.status(400).json({ success: false, message: 'Phone number not registered. Please create an account!' });
    }

    if (!user.pin) {
      return res.status(400).json({ success: false, message: 'No PIN set. Please create an account!' });
    }

    // Check PIN
    const pinMatch = await bcrypt.compare(pin, user.pin);
    if (!pinMatch) {
      return res.status(400).json({ success: false, message: 'Wrong PIN. Please try again!' });
    }

    const token = generateToken(user.id, user.phone);

    console.log(`User logged in: ${phone}`);

    res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: { id: user.id, phone: user.phone, name: user.name, avatar_url: user.avatar_url },
    });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to login' });
  }
});

// ── POST /api/auth/google ──
router.post('/google', async (req, res) => {
  try {
    const { email, name, photo, google_id } = req.body;
    if (!email || !google_id) return res.status(400).json({ success: false, message: 'Email and Google ID are required' });

    let { data: users } = await supabase.from('users').select('*').eq('email', email).limit(1);
    let user = users && users.length > 0 ? users[0] : null;

    if (!user) {
      const { data: newUsers, error } = await supabase
        .from('users')
        .insert({ email, name, avatar_url: photo, google_id })
        .select();
      if (error) throw error;
      user = newUsers[0];
      await supabase.from('wallets').insert({ user_id: user.id });
    } else {
      await supabase.from('users').update({ name, avatar_url: photo, google_id }).eq('id', user.id);
      user = { ...user, name, avatar_url: photo };
    }

    const token = generateToken(user.id, user.phone);

    res.json({
      success: true,
      message: 'Google login successful',
      token,
      user: { id: user.id, phone: user.phone, name: user.name, email: user.email, avatar_url: user.avatar_url },
    });

  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).json({ success: false, message: 'Google login failed' });
  }
});

// ── POST /api/auth/update-profile ──
router.post('/update-profile', verifyToken, async (req, res) => {
  try {
    const { name, email } = req.body;
    await supabase.from('users').update({ name, email }).eq('id', req.user.userId);
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

// ── POST /api/auth/update-avatar ──
router.post('/update-avatar', verifyToken, async (req, res) => {
  try {
    const { avatar_url } = req.body;
    await supabase.from('users').update({ avatar_url }).eq('id', req.user.userId);
    const { data: user } = await supabase
      .from('users')
      .select('id, phone, name, email, avatar_url')
      .eq('id', req.user.userId)
      .single();
    res.json({ success: true, message: 'Avatar updated!', user });
  } catch (err) {
    console.error('Update avatar error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update avatar' });
  }
});

// ── POST /api/auth/change-pin ──
router.post('/change-pin', verifyToken, async (req, res) => {
  try {
    const { old_pin, new_pin } = req.body;

    const { data: users } = await supabase.from('users').select('*').eq('id', req.user.userId).limit(1);
    const user = users && users.length > 0 ? users[0] : null;

    if (!user) return res.status(400).json({ success: false, message: 'User not found' });

    const pinMatch = await bcrypt.compare(old_pin, user.pin);
    if (!pinMatch) return res.status(400).json({ success: false, message: 'Wrong current PIN!' });

    const hashedPin = await bcrypt.hash(new_pin, 10);
    await supabase.from('users').update({ pin: hashedPin }).eq('id', req.user.userId);

    res.json({ success: true, message: 'PIN changed successfully!' });
  } catch (err) {
    console.error('Change PIN error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to change PIN' });
  }
});

// ── POST /api/auth/update-push-token ──
router.post('/update-push-token', verifyToken, async (req, res) => {
  try {
    const { push_token } = req.body;
    await supabase.from('users').update({ push_token }).eq('id', req.user.userId);
    res.json({ success: true, message: 'Push token saved' });
  } catch (err) {
    console.error('Push token error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save push token' });
  }
});

// ── POST /api/auth/send-push ──
router.post('/send-push', async (req, res) => {
  try {
    const { user_id, title, body, data } = req.body;
    const { data: users } = await supabase.from('users').select('push_token').eq('id', user_id).limit(1);
    const user = users && users.length > 0 ? users[0] : null;
    if (!user?.push_token) return res.json({ success: false, message: 'No push token found' });
    await sendPushNotification(user.push_token, title, body, data);
    res.json({ success: true, message: 'Notification sent!' });
  } catch (err) {
    console.error('Send push error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send notification' });
  }
});

module.exports = router;
module.exports.sendPushNotification = sendPushNotification;