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

// ── Format Phone for Paypack ──
function formatPhone(phone) {
  if (!phone) return phone;
  phone = phone.replace(/[\s-]/g, '');
  if (phone.startsWith('+250')) return '250' + phone.slice(4);
  if (phone.startsWith('0')) return '250' + phone.slice(1);
  if (phone.startsWith('250')) return phone;
  return phone;
}

// ── Send Push Notification via Expo ──
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

// ── Calculate Contriba Fee ──
// Contriba keeps 1% of the contribution amount
// Paypack cashout fee is flat 200 RWF
function calculateFees(amount) {
  const contribaFeePercent = 0.01;                              // 1%
  const paypackCashoutFee  = 200;                               // flat RWF
  const contribaFee        = Math.floor(amount * contribaFeePercent);
  const ownerAmount        = amount - contribaFee - paypackCashoutFee;
  return { contribaFee, paypackCashoutFee, ownerAmount };
}

// ── Automatic Cashout to Event Owner ──
async function disbursToOwner(token, ownerPhone, ownerAmount, eventTitle, contributorName) {
  try {
    const formattedPhone = formatPhone(ownerPhone);
    console.log(`Disbursing RWF ${ownerAmount} to event owner: ${formattedPhone}`);

    const response = await axios.post(
      'https://payments.paypack.rw/api/transactions/cashout',
      {
        amount: parseInt(ownerAmount),
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

    console.log(`Disbursement successful to ${formattedPhone}:`, response.data.ref);
    return response.data;
  } catch (err) {
    console.error('Disbursement error:', err.response?.data || err.message);
    return null;
  }
}

// ── POST /api/payments/cashin ──
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

// ── GET /api/payments/status/:ref ──
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

        // ── Mark contribution as success ──
        await supabase
          .from('contributions')
          .update({ status: 'success' })
          .eq('transaction_id', ref);

        const { data: event } = await supabase
          .from('events')
          .select('*')
          .eq('id', contribution.event_id)
          .single();

        if (event) {

          // ── Calculate fees ──
          const { contribaFee, paypackCashoutFee, ownerAmount } = calculateFees(contribution.amount);

          console.log(`
            ── Fee Breakdown ──
            Contribution:       RWF ${contribution.amount}
            Contriba fee (1%):  RWF ${contribaFee}
            Paypack cashout:    RWF ${paypackCashoutFee}
            Owner receives:     RWF ${ownerAmount}
          `);

          // ── Update event total raised ──
          await supabase
            .from('events')
            .update({ total_raised: (event.total_raised || 0) + contribution.amount })
            .eq('id', contribution.event_id);

          // ── Update owner wallet with amount AFTER fees ──
          const { data: wallet } = await supabase
            .from('wallets')
            .select('*')
            .eq('user_id', event.owner_id)
            .single();

          if (wallet) {
            await supabase
              .from('wallets')
              .update({
                balance: wallet.balance + ownerAmount,
                total_in: wallet.total_in + ownerAmount,
              })
              .eq('user_id', event.owner_id);
          }

          // ── Get event owner details ──
          const { data: owner } = await supabase
            .from('users')
            .select('push_token, name, phone')
            .eq('id', event.owner_id)
            .single();

          // ── Auto disburse to event owner's MoMo ──
          if (owner?.phone && ownerAmount > 0) {
            const disbursement = await disbursToOwner(
              token,
              owner.phone,
              ownerAmount,
              event.title,
              contribution.contributor_name
            );

            // Save disbursement reference
            if (disbursement) {
              await supabase
                .from('contributions')
                .update({ disbursement_ref: disbursement.ref })
                .eq('transaction_id', ref);
            }
          }

          // ── Send notification to event owner ──
          await supabase.from('notifications').insert({
            user_id: event.owner_id,
            title: 'New Contribution Received!',
            message: `${contribution.contributor_name || 'Someone'} contributed RWF ${contribution.amount.toLocaleString()} to "${event.title}". You received RWF ${ownerAmount.toLocaleString()} after fees.`,
            type: 'contribution',
          });

          if (owner?.push_token) {
            await sendPushNotification(
              owner.push_token,
              'New Contribution!',
              `${contribution.contributor_name || 'Someone'} contributed RWF ${contribution.amount.toLocaleString()}! You received RWF ${ownerAmount.toLocaleString()} 💸`,
              { type: 'contribution', event_id: contribution.event_id }
            );
          }

          // ── Goal milestone notifications ──
          const newTotal = (event.total_raised || 0) + contribution.amount;
          const goalPercent = event.goal_amount > 0
            ? Math.round((newTotal / event.goal_amount) * 100) : 0;

          if (goalPercent >= 100 && event.total_raised < event.goal_amount) {
            await supabase.from('notifications').insert({
              user_id: event.owner_id,
              title: 'Goal Reached! 🎉',
              message: `Congratulations! Your event "${event.title}" has reached its goal!`,
              type: 'goal_reached',
            });

            if (owner?.push_token) {
              await sendPushNotification(
                owner.push_token,
                'Goal Reached! 🎉',
                `Congratulations! "${event.title}" has reached its fundraising goal!`,
                { type: 'goal_reached', event_id: event.id }
              );
            }
          } else if (goalPercent >= 80 && goalPercent < 100) {
            if (owner?.push_token) {
              await sendPushNotification(
                owner.push_token,
                'Almost There!',
                `"${event.title}" is ${goalPercent}% funded! Keep sharing!`,
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

// ── POST /api/payments/cashout ──
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

    const { data: user } = await supabase
      .from('users')
      .select('push_token')
      .eq('id', req.user.userId)
      .single();

    if (user?.push_token) {
      await sendPushNotification(
        user.push_token,
        'Withdrawal Initiated!',
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

// ── POST /api/payments/webhook ──
// Paypack calls this when a transaction is processed
router.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body));

    const { event, data } = req.body;

    // Only handle successful cashin transactions
    if (event === 'transaction:processed' && data?.kind === 'CASHIN') {
      const ref = data.ref;
      console.log(`Webhook: transaction processed, ref=${ref}`);

      // Find the contribution with this transaction ref
      const { data: contribution } = await supabase
        .from('contributions')
        .select('*')
        .eq('transaction_id', ref)
        .single();

      if (contribution && contribution.status !== 'success') {

        // Mark contribution as success
        await supabase
          .from('contributions')
          .update({ status: 'success' })
          .eq('transaction_id', ref);

        // Get event details
        const { data: event } = await supabase
          .from('events')
          .select('*')
          .eq('id', contribution.event_id)
          .single();

        if (event) {
          // Calculate fees
          const { contribaFee, paypackCashoutFee, ownerAmount } = calculateFees(contribution.amount);

          console.log(`Webhook fee breakdown: amount=${contribution.amount}, contribaFee=${contribaFee}, ownerAmount=${ownerAmount}`);

          // Update event total raised
          await supabase
            .from('events')
            .update({ total_raised: (event.total_raised || 0) + contribution.amount })
            .eq('id', contribution.event_id);

          // Update owner wallet
          const { data: wallet } = await supabase
            .from('wallets')
            .select('*')
            .eq('user_id', event.owner_id)
            .single();

          if (wallet) {
            await supabase
              .from('wallets')
              .update({
                balance: wallet.balance + ownerAmount,
                total_in: wallet.total_in + ownerAmount,
              })
              .eq('user_id', event.owner_id);
          }

          // Get owner details
          const { data: owner } = await supabase
            .from('users')
            .select('push_token, name, phone')
            .eq('id', event.owner_id)
            .single();

          // Auto disburse to event owner MoMo
          if (owner?.phone && ownerAmount > 0) {
            const token = await getPaypackToken();
            const disbursement = await disbursToOwner(
              token,
              owner.phone,
              ownerAmount,
              event.title,
              contribution.contributor_name
            );

            if (disbursement) {
              await supabase
                .from('contributions')
                .update({ disbursement_ref: disbursement.ref })
                .eq('transaction_id', ref);
            }
          }

          // Send notification to owner
          await supabase.from('notifications').insert({
            user_id: event.owner_id,
            title: 'New Contribution Received!',
            message: `${contribution.contributor_name || 'Someone'} contributed RWF ${contribution.amount.toLocaleString()} to "${event.title}". You received RWF ${ownerAmount.toLocaleString()} after fees.`,
            type: 'contribution',
          });

          if (owner?.push_token) {
            await sendPushNotification(
              owner.push_token,
              'New Contribution!',
              `${contribution.contributor_name || 'Someone'} contributed RWF ${contribution.amount.toLocaleString()}! You received RWF ${ownerAmount.toLocaleString()} 💸`,
              { type: 'contribution', event_id: contribution.event_id }
            );
          }
        }
      }
    }

    res.json({ success: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;