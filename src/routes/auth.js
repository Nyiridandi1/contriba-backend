const express = require('express');
const router = express.Router();
const supabase = require('../config/database');
const jwt = require('jsonwebtoken');

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + 60 * 60 * 1000;

    await supabase.from('otps').delete().eq('phone', phone);

    const { error } = await supabase.from('otps').insert({
      phone,
      otp_code: otp,
      expires_at: new Date(expiresAt).toISOString(),
    });

    if (error) throw error;

    console.log(`OTP for ${phone}: ${otp}`);

    res.json({ success: true, message: 'OTP sent successfully', otp });

  } catch (err) {
    console.error('Send OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone and OTP are required' });
    }

    const { data: otpData, error } = await supabase
      .from('otps')
      .select('*')
      .eq('phone', phone)
      .eq('otp_code', otp)
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !otpData || otpData.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    const foundOtp = otpData[0];
    await supabase.from('otps').update({ used: true }).eq('id', foundOtp.id);

    let { data: users } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .limit(1);

    let user = users && users.length > 0 ? users[0] : null;

    if (!user) {
      const { data: newUsers, error: createError } = await supabase
        .from('users')
        .insert({ phone })
        .select();

      if (createError) throw createError;
      user = newUsers[0];
      await supabase.from('wallets').insert({ user_id: user.id });
    }

    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url,
      },
    });

  } catch (err) {
    console.error('Verify OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to verify OTP' });
  }
});

// POST /api/auth/google ── Google Sign-In
router.post('/google', async (req, res) => {
  try {
    const { email, name, photo, google_id } = req.body;

    if (!email || !google_id) {
      return res.status(400).json({ success: false, message: 'Email and Google ID are required' });
    }

    // Check if user exists by email
    let { data: users } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .limit(1);

    let user = users && users.length > 0 ? users[0] : null;

    if (!user) {
      // Create new user with Google info
      const { data: newUsers, error: createError } = await supabase
        .from('users')
        .insert({
          email,
          name,
          avatar_url: photo,
          google_id,
        })
        .select();

      if (createError) throw createError;
      user = newUsers[0];

      // Create wallet for new user
      await supabase.from('wallets').insert({ user_id: user.id });

      console.log(`New Google user created: ${email}`);
    } else {
      // Update existing user with latest Google info
      await supabase
        .from('users')
        .update({ name, avatar_url: photo, google_id })
        .eq('id', user.id);

      user = { ...user, name, avatar_url: photo };
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'Google login successful',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url,
      },
    });

  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).json({ success: false, message: 'Google login failed' });
  }
});

module.exports = router;