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
  // Remove spaces and dashes
  phone = phone.replace(/[\s-]/g, '');
  // Keep as 07XXXXXXXX format for Paypack sandbox
  if (phone.startsWith('+250')) return '0' + phone.slice(4);
  if (phone.startsWith('250')) return '0' + phone.slice(3);
  return phone;
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

    // Get Paypack token
    const token = await getPaypackToken();

    // Initiate cashin
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

    // Update contribution with transaction ref
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

    // If payment successful → update contribution
    if (transaction.status === 'successful') {
      const { data: contribution } = await supabase
        .from('contributions')
        .select('*')
        .eq('transaction_id', ref)
        .single();

      if (contribution && contribution.status !== 'success') {
        await supabase
          .from('contributions')
          .update({ status: 'success' })
          .eq('transaction_id', ref);

        const { data: event } = await supabase
          .from('events')
          .select('total_raised, owner_id')
          .eq('id', contribution.event_id)
          .single();

        if (event) {
          await supabase
            .from('events')
            .update({ total_raised: (event.total_raised || 0) + contribution.amount })
            .eq('id', contribution.event_id);

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

          await supabase.from('notifications').insert({
            user_id: event.owner_id,
            title: 'New Contribution Received! 🎉',
            message: `${contribution.contributor_name} contributed RWF ${contribution.amount.toLocaleString()}`,
            type: 'contribution',
          });
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