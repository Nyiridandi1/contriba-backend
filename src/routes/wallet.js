const express = require('express');
const router = express.Router();
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

// ── GET /api/wallet ── Get Wallet Balance
router.get('/', verifyToken, async (req, res) => {
  try {
    const { data: wallet, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.userId)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      wallet,
    });

  } catch (err) {
    console.error('Get wallet error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get wallet' });
  }
});

// ── GET /api/wallet/transactions ── Get Transaction History
router.get('/transactions', verifyToken, async (req, res) => {
  try {
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', req.user.userId)
      .single();

    if (!wallet) {
      return res.status(404).json({ success: false, message: 'Wallet not found' });
    }

    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      transactions,
    });

  } catch (err) {
    console.error('Get transactions error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get transactions' });
  }
});

// ── POST /api/wallet/withdraw ── Withdraw Funds
router.post('/withdraw', verifyToken, async (req, res) => {
  try {
    const { amount, payment_method, phone_number } = req.body;

    if (!amount || !payment_method || !phone_number) {
      return res.status(400).json({
        success: false,
        message: 'Amount, payment method and phone number are required',
      });
    }

    // Get wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({ success: false, message: 'Wallet not found' });
    }

    // Check balance
    if (wallet.balance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
      });
    }

    // Update wallet balance
    const { error: updateError } = await supabase
      .from('wallets')
      .update({
        balance: wallet.balance - amount,
        total_out: wallet.total_out + amount,
      })
      .eq('user_id', req.user.userId);

    if (updateError) throw updateError;

    // Save transaction
    const { data: transaction } = await supabase
      .from('transactions')
      .insert({
        wallet_id: wallet.id,
        type: 'out',
        amount,
        reference: `WD-${Date.now()}`,
        status: 'pending',
      })
      .select()
      .single();

    // Create notification
    await supabase.from('notifications').insert({
      user_id: req.user.userId,
      title: 'Withdrawal Initiated',
      message: `Your withdrawal of RWF ${amount.toLocaleString()} is being processed`,
      type: 'wallet',
    });

    res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      transaction,
      new_balance: wallet.balance - amount,
    });

  } catch (err) {
    console.error('Withdraw error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to process withdrawal' });
  }
});

// ── POST /api/wallet/topup ── Top Up Wallet
router.post('/topup', verifyToken, async (req, res) => {
  try {
    const { amount, payment_method } = req.body;

    if (!amount || !payment_method) {
      return res.status(400).json({
        success: false,
        message: 'Amount and payment method are required',
      });
    }

    // Get wallet
    const { data: wallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', req.user.userId)
      .single();

    // Update wallet balance
    await supabase
      .from('wallets')
      .update({
        balance: wallet.balance + amount,
        total_in: wallet.total_in + amount,
      })
      .eq('user_id', req.user.userId);

    // Save transaction
    await supabase.from('transactions').insert({
      wallet_id: wallet.id,
      type: 'in',
      amount,
      reference: `TP-${Date.now()}`,
      status: 'success',
    });

    res.json({
      success: true,
      message: 'Wallet topped up successfully',
      new_balance: wallet.balance + amount,
    });

  } catch (err) {
    console.error('Top up error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to top up wallet' });
  }
});

module.exports = router;