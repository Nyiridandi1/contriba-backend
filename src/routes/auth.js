const express = require('express');
const router = express.Router();
const supabase = require('../config/database');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Send OTP Email ──
async function sendOTPEmail(email, otp, name) {
  try {
    await resend.emails.send({
      from: 'Contriba <onboarding@resend.dev>',
      to: email,
      subject: `${otp} is your Contriba verification code`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #7A001F; padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 24px;">
            <h1 style="color: white; margin: 0; font-size: 28px;">Contriba</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0 0;">Digital Event Contributions 🇷🇼</p>
          </div>
          <h2 style="color: #1A1A1A;">Hello ${name || 'there'} 👋</h2>
          <p style="color: #666; font-size: 16px;">Your verification code is:</p>
          <div style="background: #F9EEF1; border: 2px solid #7A001F; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <h1 style="color: #7A001F; font-size: 48px; letter-spacing: 12px; margin: 0;">${otp}</h1>
          </div>
          <p style="color: #666; font-size: 14px;">This code expires in <strong>60 minutes</strong>.</p>
          <p style="color: #666; font-size: 14px;">If you didn't request this code, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
          <p style="color: #999; font-size: 12px; text-align: center;">Contriba - Digital Event Contributions Platform 🇷🇼<br>Kigali, Rwanda</p>
        </div>
      `,
    });
    console.log(`OTP email sent to ${email}`);
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    return false;
  }
}

// ── Send Welcome Email ──
async function sendWelcomeEmail(email, name) {
  try {
    await resend.emails.send({
      from: 'Contriba <onboarding@resend.dev>',
      to: email,
      subject: `Welcome to Contriba${name ? ', ' + name : ''}! 🎉`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #7A001F; padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 24px;">
            <h1 style="color: white; margin: 0; font-size: 28px;">Contriba</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0 0;">Digital Event Contributions 🇷🇼</p>
          </div>
          <h2 style="color: #1A1A1A;">Welcome ${name || 'to Contriba'}! 🎉</h2>
          <p style="color: #666; font-size: 16px;">You're now part of the Contriba family!</p>
          <div style="background: #F9EEF1; border-radius: 12px; padding: 20px; margin: 24px 0;">
            <h3 style="color: #7A001F; margin-top: 0;">What you can do with Contriba:</h3>
            <p style="color: #666; margin: 8px 0;">🎊 Create events (Weddings, Birthdays, Introductions)</p>
            <p style="color: #666; margin: 8px 0;">💰 Receive contributions via MTN MoMo & Airtel</p>
            <p style="color: #666; margin: 8px 0;">🔴 Live feed of contributions</p>
            <p style="color: #666; margin: 8px 0;">🙈 Anonymous contribution option</p>
          </div>
          <p style="color: #666; font-size: 14px;">Start by creating your first event!</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
          <p style="color: #999; font-size: 12px; text-align: center;">Contriba - Digital Event Contributions Platform 🇷🇼<br>Kigali, Rwanda</p>
        </div>
      `,
    });
    console.log(`Welcome email sent to ${email}`);
  } catch (err) {
    console.error('Welcome email error:', err.message);
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

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { phone, email, name, is_login } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });

    // Check if user exists
    const { data: users } = await supabase.from('users').select('*').eq('phone', phone).limit(1);
    const existingUser = users && users.length > 0 ? users[0] : null;

    // ── LOGIN: existing user ──
    if (existingUser) {

      // Block if signing up with existing number
      if (!is_login && email) {
        return res.status(400).json({
          success: false,
          message: 'This number already has an account. Please login instead!',
        });
      }

      // If email provided on login, verify it matches
      if (email && existingUser.email && existingUser.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(400).json({
          success: false,
          message: 'Credentials mismatch! The email does not match this phone number.',
        });
      }

      const otp = generateOTP();
      await supabase.from('otps').delete().eq('phone', phone);
      await supabase.from('otps').insert({
        phone, otp_code: otp, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      console.log(`OTP for ${phone}: ${otp}`);

      // Send to their saved email automatically
      const emailToUse = existingUser.email || email;
      if (emailToUse) {
        await sendOTPEmail(emailToUse, otp, existingUser.name);
        return res.json({
          success: true,
          message: `OTP sent to your registered email`,
          email_sent: true,
          email_hint: emailToUse.replace(/(.{2}).*(@.*)/, '$1***$2'),
        });
      }

      return res.json({ success: true, message: 'OTP sent successfully', otp });
    }

    // ── SIGN UP: new user ──

    // Block unregistered numbers from login screen
    if (is_login) {
      return res.status(400).json({
        success: false,
        message: 'This number is not registered. Please sign up first!',
      });
    }

    // Check if email already used by another account
    if (email) {
      const { data: emailUsers } = await supabase.from('users').select('*').eq('email', email).limit(1);
      if (emailUsers && emailUsers.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'This email is already linked to another account. Please use a different email.',
        });
      }
    }

    const otp = generateOTP();
    await supabase.from('otps').delete().eq('phone', phone);
    await supabase.from('otps').insert({
      phone, otp_code: otp, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    console.log(`OTP for ${phone}: ${otp}`);

    if (email) {
      await sendOTPEmail(email, otp, name);
      return res.json({ success: true, message: `OTP sent to ${email}`, email_sent: true });
    }

    res.json({ success: true, message: 'OTP sent successfully', otp });

  } catch (err) {
    console.error('Send OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name, email } = req.body;

    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required' });

    const { data: otpData, error } = await supabase
      .from('otps').select('*').eq('phone', phone).eq('otp_code', otp)
      .eq('used', false).order('created_at', { ascending: false }).limit(1);

    if (error || !otpData || otpData.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    await supabase.from('otps').update({ used: true }).eq('id', otpData[0].id);

    let { data: users } = await supabase.from('users').select('*').eq('phone', phone).limit(1);
    let user = users && users.length > 0 ? users[0] : null;
    let isNewUser = false;

    if (!user) {
      const { data: newUsers, error: createError } = await supabase
        .from('users').insert({ phone, name: name || null, email: email || null }).select();
      if (createError) throw createError;
      user = newUsers[0];
      await supabase.from('wallets').insert({ user_id: user.id });
      isNewUser = true;
    } else if (name && !user.name) {
      await supabase.from('users').update({ name, email }).eq('id', user.id);
      user = { ...user, name, email };
    }

    if (isNewUser && email) {
      await sendWelcomeEmail(email, name);
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
      user: { id: user.id, phone: user.phone, name: user.name, email: user.email, avatar_url: user.avatar_url },
    });

  } catch (err) {
    console.error('Verify OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to verify OTP' });
  }
});

// POST /api/auth/google
router.post('/google', async (req, res) => {
  try {
    const { email, name, photo, google_id } = req.body;

    if (!email || !google_id) return res.status(400).json({ success: false, message: 'Email and Google ID are required' });

    let { data: users } = await supabase.from('users').select('*').eq('email', email).limit(1);
    let user = users && users.length > 0 ? users[0] : null;
    let isNewUser = false;

    if (!user) {
      const { data: newUsers, error: createError } = await supabase
        .from('users').insert({ email, name, avatar_url: photo, google_id }).select();
      if (createError) throw createError;
      user = newUsers[0];
      await supabase.from('wallets').insert({ user_id: user.id });
      isNewUser = true;
    } else {
      await supabase.from('users').update({ name, avatar_url: photo, google_id }).eq('id', user.id);
      user = { ...user, name, avatar_url: photo };
    }

    if (isNewUser) await sendWelcomeEmail(email, name);

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

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

// POST /api/auth/update-profile
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

module.exports = router;