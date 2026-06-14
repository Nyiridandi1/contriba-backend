const express = require('express');
const router = express.Router();
const supabase = require('../config/database');

// ── MIDDLEWARE: Verify JWT Token ──
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ── Send Push Notification ──
async function sendPushNotification(pushToken, title, body, data = {}) {
  try {
    if (!pushToken) return;
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushToken, sound: 'default', title, body, data }),
    });
    const result = await response.json();
    console.log('Push notification result:', result);
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

// ── POST /api/contributions/initiate ──
router.post('/initiate', async (req, res) => {
  try {
    const { event_id, contributor_name, contributor_phone, amount, payment_method, message, is_anonymous } = req.body;

    if (!event_id || !contributor_name || !contributor_phone || !amount || !payment_method) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const { data: event, error: eventError } = await supabase
      .from('events').select('*').eq('id', event_id).single();

    if (eventError || !event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const { data: contribution, error } = await supabase
      .from('contributions')
      .insert({
        event_id,
        contributor_name,
        contributor_phone,
        amount,
        payment_method,
        message,
        status: 'pending',
        is_anonymous: is_anonymous || false,
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Contribution initiated', contribution });

  } catch (err) {
    console.error('Initiate contribution error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to initiate contribution' });
  }
});

// ── GET /api/contributions/event/:eventId ──
router.get('/event/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    const { data: contributions, error } = await supabase
      .from('contributions').select('*').eq('event_id', eventId).order('created_at', { ascending: false });

    if (error) throw error;

    const totalRaised = contributions.filter(c => c.status === 'success').reduce((sum, c) => sum + c.amount, 0);

    res.json({
      success: true,
      contributions,
      total_raised: totalRaised,
      total_contributors: contributions.filter(c => c.status === 'success').length,
    });

  } catch (err) {
    console.error('Get contributions error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get contributions' });
  }
});

// ── PUT /api/contributions/:id/confirm ──
router.put('/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;

    const { data: contribution, error } = await supabase
      .from('contributions')
      .update({ status: 'success', transaction_id })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const { data: event } = await supabase
      .from('events').select('*, users(push_token, name)').eq('id', contribution.event_id).single();

    if (event) {
      // Update event total raised
      await supabase
        .from('events')
        .update({ total_raised: (event.total_raised || 0) + contribution.amount })
        .eq('id', contribution.event_id);

      // Update owner wallet
      const { data: wallet } = await supabase
        .from('wallets').select('*').eq('user_id', event.owner_id).single();

      if (wallet) {
        await supabase
          .from('wallets')
          .update({
            balance: (wallet.balance || 0) + contribution.amount,
            total_in: (wallet.total_in || 0) + contribution.amount,
          })
          .eq('user_id', event.owner_id);
      }

      // Save transaction
      await supabase.from('transactions').insert({
        wallet_id: wallet?.id,
        type: 'in',
        amount: contribution.amount,
        reference: transaction_id,
        status: 'success',
      });

      // Create in-app notification
      const displayName = contribution.is_anonymous ? 'Someone 🙈' : contribution.contributor_name;
      const notifMessage = `${displayName} contributed RWF ${contribution.amount.toLocaleString()} to "${event.title}"! 🎉`;

      await supabase.from('notifications').insert({
        user_id: event.owner_id,
        title: '💰 New Contribution Received!',
        message: notifMessage,
        type: 'contribution',
      });

      // Send push notification to event owner!
      const { data: ownerData } = await supabase
        .from('users').select('push_token, name').eq('id', event.owner_id).single();

      if (ownerData?.push_token) {
        await sendPushNotification(
          ownerData.push_token,
          '💰 New Contribution!',
          notifMessage,
          { event_id: contribution.event_id, contribution_id: id }
        );
        console.log(`Push notification sent to ${ownerData.name || 'owner'}`);
      }
    }

    res.json({ success: true, message: 'Contribution confirmed', contribution });

  } catch (err) {
    console.error('Confirm contribution error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to confirm contribution' });
  }
});

module.exports = router;