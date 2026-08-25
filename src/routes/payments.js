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

// ── Calculate Contribution Wallet Credit ──
// Contribution flow:
// 1. Contributor pays the full amount through Paypack cashin
// 2. Paypack cashin fee is deducted
// 3. Contriba keeps 1% platform fee
// 4. Remaining amount is credited to organizer Contriba Wallet
// 5. No automatic cashout happens here
function calculateContributionCredit(amount, paymentMethod = 'mtn') {
  const numericAmount = Number(amount || 0);
  const cashinFeeRate = paymentMethod === 'airtel' ? 0.025 : 0.035;
  const paypackCashinFee = Math.ceil(numericAmount * cashinFeeRate);
  const afterCashin = Math.max(numericAmount - paypackCashinFee, 0);
  const contribaFee = Math.floor(afterCashin * 0.01);
  const walletCredit = Math.max(afterCashin - contribaFee, 0);

  return {
    paypackCashinFee,
    afterCashin,
    contribaFee,
    walletCredit,
  };
}


// ── Record Contriba Platform Fee ──
// Adds ONLY Contriba platform-fee revenue to the separate platform wallet.
// Existing organizer wallet logic remains unchanged.
async function recordPlatformFee({
  contribution,
  event,
  ref,
  contribaFee,
}) {
  const numericFee = Number(contribaFee || 0);

  if (!numericFee || numericFee <= 0) {
    return;
  }

  const { data: existingFee, error: existingFeeError } = await supabase
    .from('platform_transactions')
    .select('id')
    .eq('type', 'platform_fee')
    .eq('contribution_id', contribution.id)
    .maybeSingle();

  if (existingFeeError) {
    throw existingFeeError;
  }

  if (existingFee) {
    console.log(
      `Platform fee already recorded for contribution ${contribution.id}`
    );
    return;
  }

  const { data: insertedFee, error: feeInsertError } = await supabase
    .from('platform_transactions')
    .insert({
      type: 'platform_fee',
      amount: numericFee,
      reference: ref,
      contribution_id: contribution.id,
      event_id: event.id,
      status: 'success',
      description: `Contriba platform fee from contribution to "${event.title}"`,
    })
    .select()
    .single();

  if (feeInsertError) {
    if (feeInsertError.code === '23505') {
      console.log(`Platform fee already recorded for ${ref}`);
      return;
    }

    throw feeInsertError;
  }

  const { data: platformWallet, error: platformWalletError } = await supabase
    .from('platform_wallet')
    .select('*')
    .limit(1)
    .single();

  if (platformWalletError || !platformWallet) {
    throw platformWalletError || new Error('Platform wallet not found');
  }

  const { error: platformWalletUpdateError } = await supabase
    .from('platform_wallet')
    .update({
      balance:
        Number(platformWallet.balance || 0) +
        Number(insertedFee.amount || 0),

      total_fees_earned:
        Number(platformWallet.total_fees_earned || 0) +
        Number(insertedFee.amount || 0),

      updated_at: new Date().toISOString(),
    })
    .eq('id', platformWallet.id);

  if (platformWalletUpdateError) {
    throw platformWalletUpdateError;
  }

  console.log(
    `Platform wallet credited RWF ${Number(
      insertedFee.amount || 0
    ).toLocaleString()} from ${ref}`
  );
}

// ── Process Successful Payment ──
async function processSuccessfulPayment(ref) {
  try {
    const { data: contribution, error: contributionError } = await supabase
      .from('contributions')
      .select('*')
      .eq('transaction_id', ref)
      .single();

    if (contributionError || !contribution) {
      console.log(`Contribution ${ref} not found`);
      return;
    }

    if (contribution.status === 'success') {
      console.log(`Contribution ${ref} already processed`);
      return;
    }

    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('*')
      .eq('id', contribution.event_id)
      .single();

    if (eventError || !event) {
      console.log(`Event not found for contribution ${ref}`);
      return;
    }

    const paymentMethod = contribution.payment_method || 'mtn';
    const { contribaFee, walletCredit } = calculateContributionCredit(
      contribution.amount,
      paymentMethod
    );

    const numericContributionAmount = Number(contribution.amount || 0);

    const { error: contributionUpdateError } = await supabase
      .from('contributions')
      .update({
        status: 'success',
      })
      .eq('transaction_id', ref)
      .neq('status', 'success');

    if (contributionUpdateError) throw contributionUpdateError;

    const { error: eventUpdateError } = await supabase
      .from('events')
      .update({
        total_raised: Number(event.total_raised || 0) + numericContributionAmount,
      })
      .eq('id', contribution.event_id);

    if (eventUpdateError) throw eventUpdateError;

    let { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', event.owner_id)
      .single();

    if (walletError && walletError.code !== 'PGRST116') {
      throw walletError;
    }

    if (!wallet) {
      const { data: createdWallet, error: createWalletError } = await supabase
        .from('wallets')
        .insert({
          user_id: event.owner_id,
          balance: 0,
          total_in: 0,
          total_out: 0,
        })
        .select()
        .single();

      if (createWalletError) throw createWalletError;
      wallet = createdWallet;
    }

    const { error: walletUpdateError } = await supabase
      .from('wallets')
      .update({
        balance: Number(wallet.balance || 0) + walletCredit,
        total_in: Number(wallet.total_in || 0) + walletCredit,
      })
      .eq('id', wallet.id);

    if (walletUpdateError) throw walletUpdateError;

    const { error: transactionError } = await supabase
      .from('transactions')
      .insert({
        wallet_id: wallet.id,
        type: 'deposit',
        amount: walletCredit,
        reference: ref,
        status: 'success',
      });

    if (transactionError) throw transactionError;

    await recordPlatformFee({
      contribution,
      event,
      ref,
      contribaFee,
    });

    const { data: owner } = await supabase
      .from('users')
      .select('push_token, name')
      .eq('id', event.owner_id)
      .single();

    await supabase.from('notifications').insert({
      user_id: event.owner_id,
      title: 'New Contribution Received! 💸',
      message: `${contribution.contributor_name || 'Someone'} contributed RWF ${numericContributionAmount.toLocaleString()} to "${event.title}". RWF ${walletCredit.toLocaleString()} is now available in your Contriba Wallet.`,
      type: 'contribution',
    });

    if (owner?.push_token) {
      await sendPushNotification(
        owner.push_token,
        'New Contribution! 💸',
        `${contribution.contributor_name || 'Someone'} contributed RWF ${numericContributionAmount.toLocaleString()}! RWF ${walletCredit.toLocaleString()} was added to your Contriba Wallet.`,
        { type: 'contribution', event_id: contribution.event_id }
      );
    }

    const newTotal = Number(event.total_raised || 0) + numericContributionAmount;
    const goalPercent = Number(event.goal_amount || 0) > 0
      ? Math.round((newTotal / Number(event.goal_amount)) * 100)
      : 0;

    if (
      goalPercent >= 100 &&
      Number(event.total_raised || 0) < Number(event.goal_amount || 0)
    ) {
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
    } else if (goalPercent >= 80 && goalPercent < 100 && owner?.push_token) {
      await sendPushNotification(
        owner.push_token,
        'Almost There!',
        `"${event.title}" is ${goalPercent}% funded! Keep sharing!`,
        { type: 'milestone', event_id: event.id }
      );
    }

    console.log(
      `Payment ${ref} processed. Wallet credited RWF ${walletCredit}. Contriba fee RWF ${contribaFee}.`
    );
  } catch (err) {
    console.error('Process payment error:', err.message);
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

    // ✅ Use Events API — gives real status!
    const response = await axios.get(
      `https://payments.paypack.rw/api/events/transactions?ref=${ref}&kind=CASHIN`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      }
    );

    const eventsData = response.data;

    // Find processed event
    const processedEvent = eventsData.transactions?.find(
      t => t.event_kind === 'transaction:processed'
    );

    const transactionStatus = processedEvent?.data?.status || 'pending';
    console.log(`Transaction ${ref} status: ${transactionStatus}`);

    // If successful, process payment
    if (transactionStatus === 'successful') {
      await processSuccessfulPayment(ref);
    }

    res.json({
      success: true,
      status: transactionStatus,
      ref,
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
// Legacy endpoint retained only to prevent two separate withdrawal implementations.
// Use POST /api/wallet/withdraw for organizer withdrawals.
router.post('/cashout', verifyToken, async (req, res) => {
  return res.status(410).json({
    success: false,
    message: 'Withdrawal endpoint moved to /api/wallet/withdraw.',
  });
});

// ── POST /api/payments/webhook ──
router.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body));
    const { event, data } = req.body;
    if (event === 'transaction:processed' && data?.kind === 'CASHIN' && data?.status === 'successful') {
      console.log(`Webhook: processing payment ref=${data.ref}`);
      await processSuccessfulPayment(data.ref);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;