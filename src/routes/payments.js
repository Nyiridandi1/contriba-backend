const express = require('express');
const router = express.Router();
const axios = require('axios');
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

// ── Get Paypack Access Token ──
async function getPaypackToken() {
  const response = await axios.post(
    'https://payments.paypack.rw/api/auth/agents/authorize',
    {
      client_id: process.env.PAYPACK_CLIENT_ID,
      client_secret: process.env.PAYPACK_CLIENT_SECRET,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data.access;
}

// ── Format phone for Paypack ──
function formatPhone(phone) {
  if (!phone) return phone;
  phone = phone.replace(/[\s-]/g, '');
  if (phone.startsWith('+250')) return '0' + phone.slice(4);
  if (phone.startsWith('250')) return '0' + phone.slice(3);
  return phone;
}

// ✅ Send Push Notification via Expo
async function sendPushNotification(pushToken, title, body, data = {}) {
  try {
    if (!pushToken) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: pushToken,
        sound: 'default',
        title,
        body,
        data,
        priority: 'high',
      }),
    });
    console.log('Push notification sent to:', pushToken);
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

// ── POST /api/payments/cashin ── Request Payment from User
router.post('/cashin', async (req, res) => {
  try {
    const { amount, phone, contribution_id } = req.body;

    if (!amount || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Amount and phone are required',
      });
    }

    const formattedPhone = formatPhone(phone);
    console.log(`Cashin: amount=${amount}, phone=${formattedPhone}`);

    const token = await getPaypackToken();

    const response = await axios.post(
      'https://payments.paypack.rw/api/transactions/cashin',
      {
        amount: parseInt(amount),
        number: formattedPhone,
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }
    );

    const transaction = response.data;

    if (contribution_id) {
      await supabase
        .from('contributions')
        .update({
          transaction_id: transaction.ref,
          status: 'pending',
        })
        .eq('id', contribution_id);
    }

    res.json({
      success: true,
      message: 'Payment request sent! Please check your phone.',
      transaction_ref: transaction.ref,
      status: transaction.status,
    });

  } catch (err) {
    console.error('Cashin error:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || 'Payment failed',
    });
  }
});

// ── GET /api/payments/status/:ref ── Check Payment Status
router.get('/status/:ref', async (req, res) => {
  try {
    const { ref } = req.params;
    const token = await getPaypackToken();

    const response = await axios.get(
      `https://payments.paypack.rw/api/transactions/find/${ref}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      }
    );

    const transaction = response.data;

    if (transaction.status === 'successful') {
      const { data: contribution } = await supabase
        .from('contributions')
        .select('*')
        .eq('transaction_id', ref)
        .single();

      if (contribution && contribution.status !== 'success') {
        // ✅ Update contribution status
        await supabase
          .from('contributions')
          .update({ status: 'success' })
          .eq('transaction_id', ref);

        const { data: event } = await supabase
          .from('events')
          .select('*, title')
          .eq('id', contribution.event_id)
          .single();

        if (event) {
          // ✅ Update event total raised
          await supabase
            .from('events')
            .update({ total_raised: (event.total_raised || 0) + contribution.amount })
            .eq('id', contribution.event_id);

          // ✅ Update wallet balance
          const { data: wallet } = await supabase
            .from('wallets')
            .select('*')
            .eq('user_id', event.owner_id)
            .single();

          if (wallet) {
            await supabase
              .from('wallets')
              .update({
                balance: wallet.balance + contribution.amount,
                total_in: wallet.total_in + contribution.amount,
              })
              .eq('user_id', event.owner_id);
          }

          // ✅ Save notification to database
          await supabase.from('notifications').insert({
            user_id: event.owner_id,
            title: '💰 New Contribution Received!',
            message: `${contribution.contributor_name || 'Someone'} contributed RWF ${contribution.amount.toLocaleString()} to "${event.title}"`,
            type: 'contribution',
          });

          // ✅ Send REAL push notification to event owner
          const { data: owner } = await supabase
            .from('users')
            .select('push_token, name')
            .eq('id', event.owner_id)
            .single();

          if (owner?.push_token) {
            await sendPushNotification(
              owner.push_token,
              '💰 New Contribution!',
              `${contribution.contributor_name || 'Someone'} just contributed RWF ${contribution.amount.toLocaleString()} to "${event.title}"! 🎉`,
              {
                type: 'contribution',
                event_id: contribution.event_id,
              }
            );
          }

          // ✅ Check if goal reached and notify
          const newTotal = (event.total_raised || 0) + contribution.amount;
          const goalPercent = event.goal_amount > 0
            ? Math.round((newTotal / event.goal_amount) * 100) : 0;

          if (goalPercent >= 100 && event.total_raised < event.goal_amount) {
            // Goal just reached!
            await supabase.from('notifications').insert({
              user_id: event.owner_id,
              title: '🎯 Goal Reached!',
              message: `Congratulations! Your event "${event.title}" has reached its goal! 🎉`,
              type: 'goal_reached',
            });

            if (owner?.push_token) {
              await sendPushNotification(
                owner.push_token,
                '🎯 Goal Reached!',
                `Congratulations! "${event.title}" has reached its fundraising goal! 🎉`,
                { type: 'goal_reached', event_id: event.id }
              );
            }
          } else if (goalPercent >= 80 && goalPercent < 100) {
            // 80% milestone
            if (owner?.push_token) {
              await sendPushNotification(
                owner.push_token,
                '🔥 Almost There!',
                `"${event.title}" is ${goalPercent}% funded! Keep sharing! 💪`,
                { type: 'milestone', event_id: event.id }
              );
            }
          }
        }
      }
    }

    res.json({
      success: true,
      status: transaction.status,
      amount: transaction.amount,
      ref: transaction.ref,
    });

  } catch (err) {
    console.error('Status check error:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to check payment status',
    });
  }
});

// ── POST /api/payments/cashout ── Send Money to User (Withdrawal)
router.post('/cashout', verifyToken, async (req, res) => {
  try {
    const { amount, phone } = req.body;

    if (!amount || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Amount and phone are required',
      });
    }

    const { data: wallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.userId)
      .single();

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
      });
    }

    const formattedPhone = formatPhone(phone);
    const token = await getPaypackToken();

    const response = await axios.post(
      'https://payments.paypack.rw/api/transactions/cashout',
      {
        amount: parseInt(amount),
        number: formattedPhone,
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }
    );

    const transaction = response.data;

    await supabase
      .from('wallets')
      .update({
        balance: wallet.balance - amount,
        total_out: wallet.total_out + amount,
      })
      .eq('user_id', req.user.userId);

    await supabase.from('transactions').insert({
      wallet_id: wallet.id,
      type: 'out',
      amount,
      reference: transaction.ref,
      status: 'pending',
    });

    // ✅ Notify user about withdrawal
    const { data: user } = await supabase
      .from('users')
      .select('push_token')
      .eq('id', req.user.userId)
      .single();

    if (user?.push_token) {
      await sendPushNotification(
        user.push_token,
        '💸 Withdrawal Initiated!',
        `RWF ${parseInt(amount).toLocaleString()} will be sent to your phone shortly!`,
        { type: 'withdrawal' }
      );
    }

    res.json({
      success: true,
      message: 'Withdrawal initiated! Money will be sent to your phone.',
      transaction_ref: transaction.ref,
    });

  } catch (err) {
    console.error('Cashout error:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || 'Withdrawal failed',
    });
  }
});

module.exports = router;