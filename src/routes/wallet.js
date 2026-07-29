const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../config/database');

const MINIMUM_WITHDRAWAL = 5000;

// ── MIDDLEWARE: Verify JWT Token ──
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'No token provided',
    });
  }

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }
};

// ── PAYPACK HELPERS ──
async function getPaypackToken() {
  const response = await axios.post(
    'https://payments.paypack.rw/api/auth/agents/authorize',
    {
      client_id: process.env.PAYPACK_CLIENT_ID,
      client_secret: process.env.PAYPACK_CLIENT_SECRET,
    },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.access;
}

function formatPhone(phone) {
  if (!phone) return '';

  const clean = String(phone).replace(/[\s-]/g, '');

  if (clean.startsWith('+250')) return `250${clean.slice(4)}`;
  if (clean.startsWith('0')) return `250${clean.slice(1)}`;
  if (clean.startsWith('250')) return clean;

  return clean;
}

async function sendPushNotification(pushToken, title, body, data = {}) {
  try {
    if (!pushToken) return;

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
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
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

async function getPaypackCashoutStatus(reference, token) {
  try {
    const response = await axios.get(
      `https://payments.paypack.rw/api/events/transactions?ref=${encodeURIComponent(
        reference
      )}&kind=CASHOUT`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }
    );

    const transactions = response.data?.transactions || [];

    const processedEvent = transactions.find(
      (item) =>
        item.event_kind === 'transaction:processed' &&
        item.data?.ref === reference &&
        item.data?.kind === 'CASHOUT'
    );

    const status = String(processedEvent?.data?.status || 'pending').toLowerCase();

    if (status === 'successful' || status === 'success') {
      return {
        status: 'success',
        paypack: processedEvent?.data || null,
      };
    }

    if (status === 'failed') {
      return {
        status: 'failed',
        paypack: processedEvent?.data || null,
      };
    }

    return {
      status: 'pending',
      paypack: processedEvent?.data || null,
    };
  } catch (err) {
    console.error(
      `Paypack withdrawal status check failed for ${reference}:`,
      err.response?.data || err.message
    );

    return {
      status: 'pending',
      paypack: null,
    };
  }
}

// Synchronize pending withdrawals with Paypack.
// Successful -> mark transaction success.
// Failed -> refund wallet exactly once by only acting on rows still marked pending.
async function syncPendingWithdrawals(wallet, userId) {
  const { data: pendingWithdrawals, error: pendingError } = await supabase
    .from('transactions')
    .select('*')
    .eq('wallet_id', wallet.id)
    .eq('type', 'withdrawal')
    .eq('status', 'pending');

  if (pendingError) {
    throw pendingError;
  }

  if (!pendingWithdrawals || pendingWithdrawals.length === 0) {
    return;
  }

  const paypackToken = await getPaypackToken();

  for (const transaction of pendingWithdrawals) {
    if (!transaction.reference) continue;

    const result = await getPaypackCashoutStatus(
      transaction.reference,
      paypackToken
    );

    if (result.status === 'success') {
      const { data: updatedRows, error: updateError } = await supabase
        .from('transactions')
        .update({
          status: 'success',
        })
        .eq('id', transaction.id)
        .eq('status', 'pending')
        .select('id');

      if (updateError) {
        console.error(
          `Failed to complete withdrawal ${transaction.reference}:`,
          updateError.message
        );
        continue;
      }

      if (updatedRows && updatedRows.length > 0) {
        await supabase.from('notifications').insert({
          user_id: userId,
          title: 'Withdrawal Completed',
          message: `Your withdrawal of RWF ${Number(
            transaction.amount || 0
          ).toLocaleString()} was completed successfully.`,
          type: 'withdrawal',
        });

        console.log(
          `Withdrawal ${transaction.reference} marked successful`
        );
      }

      continue;
    }

    if (result.status === 'failed') {
      // Claim this failed transaction first. If another request already handled it,
      // updatedRows will be empty and no second refund will happen.
      const { data: updatedRows, error: failUpdateError } = await supabase
        .from('transactions')
        .update({
          status: 'failed',
        })
        .eq('id', transaction.id)
        .eq('status', 'pending')
        .select('id');

      if (failUpdateError) {
        console.error(
          `Failed to mark withdrawal ${transaction.reference} failed:`,
          failUpdateError.message
        );
        continue;
      }

      if (!updatedRows || updatedRows.length === 0) {
        continue;
      }

      const { data: latestWallet, error: latestWalletError } = await supabase
        .from('wallets')
        .select('*')
        .eq('id', wallet.id)
        .single();

      if (latestWalletError || !latestWallet) {
        console.error(
          `Failed to reload wallet for refund ${transaction.reference}:`,
          latestWalletError?.message || 'Wallet not found'
        );
        continue;
      }

      const refundAmount = Number(transaction.amount || 0);

      const { error: refundError } = await supabase
        .from('wallets')
        .update({
          balance: Number(latestWallet.balance || 0) + refundAmount,
          total_out: Math.max(
            Number(latestWallet.total_out || 0) - refundAmount,
            0
          ),
        })
        .eq('id', latestWallet.id);

      if (refundError) {
        console.error(
          `Failed to refund withdrawal ${transaction.reference}:`,
          refundError.message
        );
        continue;
      }

      await supabase.from('notifications').insert({
        user_id: userId,
        title: 'Withdrawal Failed',
        message: `Your withdrawal of RWF ${refundAmount.toLocaleString()} failed. The amount was returned to your Contriba Wallet.`,
        type: 'withdrawal',
      });

      console.log(
        `Withdrawal ${transaction.reference} failed and RWF ${refundAmount} was refunded`
      );
    }
  }
}

// ── GET /api/wallet ── Get Wallet Balance
router.get('/', verifyToken, async (req, res) => {
  try {
    let { data: wallet, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!wallet) {
      const { data: createdWallet, error: createError } = await supabase
        .from('wallets')
        .insert({
          user_id: req.user.userId,
          balance: 0,
          total_in: 0,
          total_out: 0,
        })
        .select()
        .single();

      if (createError) throw createError;
      wallet = createdWallet;
    }

    // Refresh pending withdrawal statuses before returning balance.
    await syncPendingWithdrawals(wallet, req.user.userId);

    const { data: refreshedWallet, error: refreshError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', wallet.id)
      .single();

    if (refreshError) throw refreshError;

    return res.json({
      success: true,
      wallet: refreshedWallet,
      minimum_withdrawal: MINIMUM_WITHDRAWAL,
    });
  } catch (err) {
    console.error('Get wallet error:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to get wallet',
    });
  }
});

// ── GET /api/wallet/transactions ── Get Transaction History
router.get('/transactions', verifyToken, async (req, res) => {
  try {
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.userId)
      .single();

    if (walletError || !wallet) {
      return res.json({
        success: true,
        transactions: [],
      });
    }

    // Sync pending Paypack cashouts so the UI moves from Processing -> Completed/Failed.
    await syncPendingWithdrawals(wallet, req.user.userId);

    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({
      success: true,
      transactions: transactions || [],
    });
  } catch (err) {
    console.error('Get transactions error:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to get transactions',
    });
  }
});

// ── POST /api/wallet/withdraw ── Real Paypack Cashout
router.post('/withdraw', verifyToken, async (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const method = String(
      req.body.method || req.body.payment_method || ''
    ).toLowerCase();
    const phone = req.body.phone || req.body.phone_number;

    if (!amount || !method || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Amount, payment method and phone number are required',
      });
    }

    if (amount < MINIMUM_WITHDRAWAL) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdrawal is RWF ${MINIMUM_WITHDRAWAL.toLocaleString()}.`,
      });
    }

    if (!['mtn', 'airtel'].includes(method)) {
      return res.status(400).json({
        success: false,
        message: 'Please choose MTN MoMo or Airtel Money.',
      });
    }

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found',
      });
    }

    // First sync any previous pending withdrawal before checking spendable balance.
    await syncPendingWithdrawals(wallet, req.user.userId);

    const { data: refreshedWallet, error: refreshedWalletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', wallet.id)
      .single();

    if (refreshedWalletError || !refreshedWallet) {
      return res.status(404).json({
        success: false,
        message: 'Wallet not found',
      });
    }

    if (Number(refreshedWallet.balance || 0) < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
      });
    }

    const formattedPhone = formatPhone(phone);

    if (!/^2507\d{8}$/.test(formattedPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid Rwanda mobile money number.',
      });
    }

    const paypackToken = await getPaypackToken();

    const response = await axios.post(
      'https://payments.paypack.rw/api/transactions/cashout',
      {
        amount: parseInt(amount, 10),
        number: formattedPhone,
      },
      {
        headers: {
          Authorization: `Bearer ${paypackToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Idempotency-Key': `wd-${Date.now()}-${req.user.userId}`
            .replace(/[^a-zA-Z0-9-]/g, '')
            .slice(0, 32),
        },
      }
    );

    const paypackTransaction = response.data;

    if (!paypackTransaction?.ref) {
      return res.status(502).json({
        success: false,
        message: 'Paypack did not return a withdrawal reference.',
      });
    }

    const newBalance = Number(refreshedWallet.balance || 0) - amount;
    const newTotalOut = Number(refreshedWallet.total_out || 0) + amount;

    const { error: walletUpdateError } = await supabase
      .from('wallets')
      .update({
        balance: newBalance,
        total_out: newTotalOut,
      })
      .eq('id', refreshedWallet.id);

    if (walletUpdateError) throw walletUpdateError;

    const initialStatus =
      String(paypackTransaction.status || '').toLowerCase() === 'successful'
        ? 'success'
        : 'pending';

    const { data: transaction, error: transactionError } = await supabase
      .from('transactions')
      .insert({
        wallet_id: refreshedWallet.id,
        type: 'withdrawal',
        amount,
        reference: paypackTransaction.ref,
        status: initialStatus,
      })
      .select()
      .single();

    if (transactionError) throw transactionError;

    await supabase.from('notifications').insert({
      user_id: req.user.userId,
      title:
        initialStatus === 'success'
          ? 'Withdrawal Completed'
          : 'Withdrawal Initiated',
      message:
        initialStatus === 'success'
          ? `Your withdrawal of RWF ${amount.toLocaleString()} to ${phone} was completed successfully.`
          : `Your withdrawal of RWF ${amount.toLocaleString()} to ${phone} is being processed.`,
      type: 'withdrawal',
    });

    const { data: user } = await supabase
      .from('users')
      .select('push_token')
      .eq('id', req.user.userId)
      .single();

    if (user?.push_token) {
      await sendPushNotification(
        user.push_token,
        initialStatus === 'success'
          ? 'Withdrawal Completed!'
          : 'Withdrawal Initiated!',
        initialStatus === 'success'
          ? `RWF ${amount.toLocaleString()} was sent successfully to ${phone}.`
          : `RWF ${amount.toLocaleString()} is being sent to ${phone}.`,
        {
          type: 'withdrawal',
          reference: paypackTransaction.ref,
        }
      );
    }

    return res.json({
      success: true,
      message:
        initialStatus === 'success'
          ? 'Withdrawal completed successfully.'
          : 'Withdrawal initiated. Check your mobile money account.',
      transaction,
      transaction_ref: paypackTransaction.ref,
      new_balance: newBalance,
      minimum_withdrawal: MINIMUM_WITHDRAWAL,
    });
  } catch (err) {
    console.error('Withdraw error:', err.response?.data || err.message);

    return res.status(500).json({
      success: false,
      message:
        err.response?.data?.message || 'Failed to process withdrawal',
    });
  }
});

// ── POST /api/wallet/topup ──
// Prevent artificial wallet credits until a real Paypack top-up flow exists.
router.post('/topup', verifyToken, async (req, res) => {
  return res.status(501).json({
    success: false,
    message:
      'Wallet top up is not enabled yet. Wallet funds come from successful event contributions.',
  });
});

module.exports = router;