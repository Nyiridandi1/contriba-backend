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
      return res.status(400).json({
        success: false,
        message: 'Phone number is required',
      });
    }

    const otp = generateOTP();
    
    // Store expiry as unix timestamp (milliseconds)
    const expiresAt = Date.now() + 60 * 60 * 1000;

    // Delete old OTPs for this phone
    await supabase.from('otps').delete().eq('phone', phone);

    // Save new OTP
    const { error } = await supabase.from('otps').insert({
      phone,
      otp_code: otp,
      expires_at: new Date(expiresAt).toISOString(),
    });

    if (error) throw error;

    console.log(`OTP for ${phone}: ${otp}`);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      otp: otp,
    });

  } catch (err) {
    console.error('Send OTP error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP',
    });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Phone and OTP are required',
      });
    }

    // Find OTP - no expiry check, just find it
    const { data: otpData, error } = await supabase
      .from('otps')
      .select('*')
      .eq('phone', phone)
      .eq('otp_code', otp)
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !otpData || otpData.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP',
      });
    }

    const foundOtp = otpData[0];

    // Mark OTP as used
    await supabase.from('otps').update({ used: true }).eq('id', foundOtp.id);

    // Check if user exists
    let { data: users } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .limit(1);

    let user = users && users.length > 0 ? users[0] : null;

    // Create user if new
    if (!user) {
      const { data: newUsers, error: createError } = await supabase
        .from('users')
        .insert({ phone })
        .select();

      if (createError) throw createError;
      user = newUsers[0];

      // Create wallet for new user
      await supabase.from('wallets').insert({ user_id: user.id });
    }

    // Generate JWT token
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
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP',
    });
  }
});

module.exports = router;