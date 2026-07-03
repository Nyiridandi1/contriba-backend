const express = require('express');
const router = express.Router();
const supabase = require('../config/database');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

function generateToken(userId, phone) {
  return jwt.sign({ userId, phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function formatPhone(phone) {
  if (!phone) return phone;
  phone = phone.toString().replace(/[\s\-\+]/g, '');
  if (phone.startsWith('2500')) return '0' + phone.slice(4);
  if (phone.startsWith('250')) return '0' + phone.slice(3);
  if (phone.startsWith('0')) return phone;
  return '0' + phone;
}

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

async function sendOTPEmail(email, otp, name, subject = 'Your Contriba verification code') {
  try {
    await resend.emails.send({
      from: 'Contriba <support@contriba.online>',
      to: email,
      subject: `${subject}: ${otp}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#f7f8fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fc;padding:40px 0;">
            <tr><td align="center">
              <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                <tr>
                  <td style="background:linear-gradient(135deg,#111827,#1f2937);padding:32px 40px;text-align:center;">
                    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:900;letter-spacing:-1px;">Contriba</h1>
                    <p style="margin:8px 0 0;color:rgba(255,255,255,0.6);font-size:14px;">Rwanda's #1 Event Contribution Platform</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px;">
                    <p style="margin:0 0 8px;color:#6b7280;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Hello ${name},</p>
                    <h2 style="margin:0 0 16px;color:#111827;font-size:24px;font-weight:900;letter-spacing:-0.5px;">${subject}</h2>
                    <p style="margin:0 0 32px;color:#6b7280;font-size:15px;line-height:1.7;">
                      Use the verification code below. This code expires in <strong style="color:#111827;">30 minutes</strong>.
                    </p>
                    <div style="background:#f7f8fc;border:2px solid #E50914;border-radius:16px;padding:24px;text-align:center;margin-bottom:32px;">
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Your verification code</p>
                      <p style="margin:0;color:#111827;font-size:48px;font-weight:900;letter-spacing:12px;">${otp}</p>
                    </div>
                    <div style="background:rgba(229,9,20,0.04);border:1px solid rgba(229,9,20,0.15);border-radius:12px;padding:16px;margin-bottom:24px;">
                      <p style="margin:0;color:#374151;font-size:13px;line-height:1.6;">
                        <strong style="color:#E50914;">Never share this code</strong> with anyone. Contriba staff will never ask for your verification code.
                      </p>
                    </div>
                    <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">If you did not request this code, please ignore this email.</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:24px 40px;border-top:1px solid #f3f4f6;text-align:center;">
                    <p style="margin:0;color:#9ca3af;font-size:12px;">© 2025 Contriba · Kigali, Rwanda · <a href="https://contriba.online" style="color:#E50914;text-decoration:none;">contriba.online</a></p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    });
    return true;
  } catch (err) {
    console.error('Send OTP email error:', err.message);
    return false;
  }
}

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

// ── POST /api/auth/send-otp ── Registration OTP
router.post('/send-otp', async (req, res) => {
  try {
    const { email, name, phone, isReset } = req.body;

    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    const cleanPhone = formatPhone(phone);

    if (!isReset) {
      // Registration: check phone and email not already used
      const { data: existingPhone } = await supabase
        .from('users').select('id').eq('phone', cleanPhone).limit(1);
      if (existingPhone && existingPhone.length > 0) {
        return res.status(400).json({ success: false, message: 'This phone number is already registered. Please login!' });
      }

      const { data: existingEmail } = await supabase
        .from('users').select('id').eq('email', email).limit(1);
      if (existingEmail && existingEmail.length > 0) {
        return res.status(400).json({ success: false, message: 'This email is already registered. Please login!' });
      }
    } else {
      // PIN reset: verify phone + email match a real account
      const { data: users } = await supabase
        .from('users').select('id, name').eq('phone', cleanPhone).eq('email', email).limit(1);
      if (!users || users.length === 0) {
        return res.status(400).json({ success: false, message: 'No account found with this phone and email combination.' });
      }
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await supabase.from('otps').delete().eq('email', email);
    await supabase.from('otps').insert({ email, otp, expires_at: expiresAt.toISOString() });

    const subject = isReset ? 'PIN Reset verification code' : 'Verify your email address';
    await sendOTPEmail(email, otp, name, subject);

    console.log(`OTP sent to ${email}: ${otp}`);

    res.json({
      success: true,
      message: `Verification code sent to ${email}`,
      otp, // ✅ Return OTP for display on screen
    });

  } catch (err) {
    console.error('Send OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

// ── POST /api/auth/verify-otp ── Complete registration
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp, name, phone, pin } = req.body;

    if (!email || !otp || !name || !phone || !pin) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const cleanPhone = formatPhone(phone);

    const { data: otps } = await supabase
      .from('otps').select('*').eq('email', email).eq('otp', otp).eq('used', false)
      .order('created_at', { ascending: false }).limit(1);

    const otpRecord = otps && otps.length > 0 ? otps[0] : null;

    if (!otpRecord) {
      return res.status(400).json({ success: false, message: 'Invalid verification code. Please try again.' });
    }

    if (new Date() > new Date(otpRecord.expires_at)) {
      return res.status(400).json({ success: false, message: 'Code expired. Please request a new one.' });
    }

    await supabase.from('otps').update({ used: true }).eq('id', otpRecord.id);

    const hashedPin = await bcrypt.hash(pin, 10);

    const { data: newUsers, error } = await supabase
      .from('users')
      .insert({ name, phone: cleanPhone, email, pin: hashedPin, email_verified: true })
      .select();

    if (error) throw error;

    const user = newUsers[0];
    await supabase.from('wallets').insert({ user_id: user.id });

    const token = generateToken(user.id, user.phone);

    console.log(`New verified user registered: ${cleanPhone} / ${email}`);

    res.json({
      success: true,
      message: 'Account created successfully!',
      token,
      user: { id: user.id, phone: user.phone, name: user.name, email: user.email, avatar_url: user.avatar_url },
    });

  } catch (err) {
    console.error('Verify OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to verify code' });
  }
});

// ── POST /api/auth/reset-pin ── Reset PIN after OTP verified
router.post('/reset-pin', async (req, res) => {
  try {
    const { phone, email, otp, new_pin } = req.body;

    if (!phone || !email || !otp || !new_pin) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const cleanPhone = formatPhone(phone);

    // Verify OTP
    const { data: otps } = await supabase
      .from('otps').select('*').eq('email', email).eq('otp', otp).eq('used', false)
      .order('created_at', { ascending: false }).limit(1);

    const otpRecord = otps && otps.length > 0 ? otps[0] : null;

    if (!otpRecord) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification code.' });
    }

    if (new Date() > new Date(otpRecord.expires_at)) {
      return res.status(400).json({ success: false, message: 'Code expired. Please request a new one.' });
    }

    // Find user
    const { data: users } = await supabase
      .from('users').select('*').eq('phone', cleanPhone).eq('email', email).limit(1);

    const user = users && users.length > 0 ? users[0] : null;

    if (!user) {
      return res.status(400).json({ success: false, message: 'Account not found.' });
    }

    // Update PIN
    const hashedPin = await bcrypt.hash(new_pin, 10);
    await supabase.from('users').update({ pin: hashedPin }).eq('id', user.id);

    // Mark OTP as used
    await supabase.from('otps').update({ used: true }).eq('id', otpRecord.id);

    console.log(`PIN reset for: ${cleanPhone}`);

    res.json({ success: true, message: 'PIN reset successfully!' });

  } catch (err) {
    console.error('Reset PIN error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reset PIN' });
  }
});

// ── POST /api/auth/register ── (mobile app compatibility)
router.post('/register', async (req, res) => {
  try {
    const { name, pin } = req.body;
    const phone = formatPhone(req.body.phone);

    if (!name) return res.status(400).json({ success: false, message: 'Full name is required' });
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });
    if (!pin || pin.length < 4) return res.status(400).json({ success: false, message: 'PIN must be at least 4 digits' });

    const { data: existing } = await supabase.from('users').select('id').eq('phone', phone).limit(1);
    if (existing && existing.length > 0) {
      return res.status(400).json({ success: false, message: 'This phone number is already registered. Please login!' });
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    const { data: newUsers, error } = await supabase
      .from('users').insert({ name, phone, pin: hashedPin }).select();

    if (error) throw error;

    const user = newUsers[0];
    await supabase.from('wallets').insert({ user_id: user.id });

    const token = generateToken(user.id, user.phone);

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
router.post('/login', async (req, res) => {
  try {
    const phone = formatPhone(req.body.phone);
    const { pin } = req.body;

    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });
    if (!pin) return res.status(400).json({ success: false, message: 'PIN is required' });

    const { data: users } = await supabase.from('users').select('*').eq('phone', phone).limit(1);
    const user = users && users.length > 0 ? users[0] : null;

    if (!user) return res.status(400).json({ success: false, message: 'Phone number not registered. Please create an account!' });
    if (!user.pin) return res.status(400).json({ success: false, message: 'No PIN set. Please create an account!' });

    const pinMatch = await bcrypt.compare(pin, user.pin);
    if (!pinMatch) return res.status(400).json({ success: false, message: 'Wrong PIN. Please try again!' });

    const token = generateToken(user.id, user.phone);

    res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: { id: user.id, phone: user.phone, name: user.name, email: user.email, avatar_url: user.avatar_url },
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
        .from('users').insert({ email, name, avatar_url: photo, google_id }).select();
      if (error) throw error;
      user = newUsers[0];
      await supabase.from('wallets').insert({ user_id: user.id });
    } else {
      await supabase.from('users').update({ name, avatar_url: photo, google_id }).eq('id', user.id);
      user = { ...user, name, avatar_url: photo };
    }

    const token = generateToken(user.id, user.phone);
    res.json({ success: true, message: 'Google login successful', token, user: { id: user.id, phone: user.phone, name: user.name, email: user.email, avatar_url: user.avatar_url } });

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
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

// ── POST /api/auth/update-avatar ──
router.post('/update-avatar', verifyToken, async (req, res) => {
  try {
    const { avatar_url } = req.body;
    await supabase.from('users').update({ avatar_url }).eq('id', req.user.userId);
    const { data: user } = await supabase.from('users').select('id, phone, name, email, avatar_url').eq('id', req.user.userId).single();
    res.json({ success: true, message: 'Avatar updated!', user });
  } catch (err) {
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
    res.status(500).json({ success: false, message: 'Failed to send notification' });
  }
});

module.exports = router;
module.exports.sendPushNotification = sendPushNotification;