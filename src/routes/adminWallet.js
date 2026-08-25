const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const supabase = require("../config/database");

const router = express.Router();

const KIGALI_TIMEZONE = "Africa/Kigali";
const KIGALI_OFFSET = "+02:00";
const MINIMUM_WITHDRAWAL = 5000;

/* =========================================================
   AUTHENTICATION
========================================================= */

function verifyToken(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      success: false,
      message: "Please log in again.",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (!decoded?.userId) {
      return res.status(401).json({
        success: false,
        message: "Invalid session.",
      });
    }

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Session expired. Please log in again.",
    });
  }
}

/* =========================================================
   ADMIN AUTHORIZATION

   Do not trust the role stored in localStorage or JWT.
   Always confirm the role directly from the users table.
========================================================= */

async function requireAdmin(req, res, next) {
  try {
    const { data: admin, error } = await supabase
      .from("users")
      .select("id, name, email, phone, role, deleted_at")
      .eq("id", req.user.userId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!admin || admin.deleted_at) {
      return res.status(401).json({
        success: false,
        message: "Admin account not found.",
      });
    }

    if (admin.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access is required.",
      });
    }

    req.admin = admin;
    next();
  } catch (error) {
    console.error(
      "Admin wallet authorization error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Could not verify administrator access.",
    });
  }
}

/* =========================================================
   HELPERS
========================================================= */

function normalizePage(value) {
  const page = Number.parseInt(value, 10);

  if (!Number.isFinite(page) || page < 1) {
    return 1;
  }

  return page;
}

function normalizeLimit(value) {
  const limit = Number.parseInt(value, 10);

  if (!Number.isFinite(limit) || limit < 1) {
    return 20;
  }

  return Math.min(limit, 100);
}

function normalizeTransactionType(value) {
  const normalized = String(value || "all")
    .trim()
    .toLowerCase();

  const allowed = new Set([
    "all",
    "platform_fee",
    "withdrawal",
    "refund",
    "adjustment",
  ]);

  return allowed.has(normalized)
    ? normalized
    : "all";
}

function normalizeTransactionStatus(value) {
  const normalized = String(value || "all")
    .trim()
    .toLowerCase();

  const allowed = new Set([
    "all",
    "pending",
    "success",
    "failed",
  ]);

  return allowed.has(normalized)
    ? normalized
    : "all";
}

function toSafeNumber(value) {
  const numeric = Number(value || 0);

  return Number.isFinite(numeric)
    ? numeric
    : 0;
}

function getKigaliDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: KIGALI_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  );

  const parts = formatter.formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
  };
}

function getKigaliBoundaries() {
  const {
    year,
    month,
    day,
  } = getKigaliDateParts();

  const startOfToday = new Date(
    `${year}-${month}-${day}T00:00:00${KIGALI_OFFSET}`
  );

  const startOfMonth = new Date(
    `${year}-${month}-01T00:00:00${KIGALI_OFFSET}`
  );

  return {
    startOfToday: startOfToday.toISOString(),
    startOfMonth: startOfMonth.toISOString(),
  };
}

async function getPlatformWallet() {
  const { data: wallet, error } = await supabase
    .from("platform_wallet")
    .select(
      [
        "id",
        "balance",
        "total_fees_earned",
        "total_withdrawn",
        "created_at",
        "updated_at",
      ].join(", ")
    )
    .order("id", {
      ascending: true,
    })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!wallet) {
    throw new Error(
      "Platform wallet has not been initialized."
    );
  }

  return wallet;
}

async function sumSuccessfulPlatformFeesSince(
  isoDate
) {
  const { data, error } = await supabase
    .from("platform_transactions")
    .select("amount")
    .eq("type", "platform_fee")
    .eq("status", "success")
    .gte("created_at", isoDate);

  if (error) {
    throw error;
  }

  return (data || []).reduce(
    (total, transaction) =>
      total + toSafeNumber(transaction.amount),
    0
  );
}

async function sumPendingWithdrawals() {
  const { data, error } = await supabase
    .from("platform_transactions")
    .select("amount")
    .eq("type", "withdrawal")
    .eq("status", "pending");

  if (error) {
    throw error;
  }

  return (data || []).reduce(
    (total, transaction) =>
      total + toSafeNumber(transaction.amount),
    0
  );
}

async function enrichTransactions(
  transactions
) {
  const records = transactions || [];

  if (records.length === 0) {
    return [];
  }

  const eventIds = [
    ...new Set(
      records
        .map((transaction) => transaction.event_id)
        .filter(Boolean)
    ),
  ];

  const contributionIds = [
    ...new Set(
      records
        .map(
          (transaction) =>
            transaction.contribution_id
        )
        .filter(Boolean)
    ),
  ];

  let eventsById = {};
  let contributionsById = {};

  if (eventIds.length > 0) {
    const { data: events, error: eventsError } =
      await supabase
        .from("events")
        .select("id, title, owner_id")
        .in("id", eventIds);

    if (eventsError) {
      throw eventsError;
    }

    eventsById = Object.fromEntries(
      (events || []).map((event) => [
        event.id,
        event,
      ])
    );
  }

  if (contributionIds.length > 0) {
    const {
      data: contributions,
      error: contributionsError,
    } = await supabase
      .from("contributions")
      .select(
        [
          "id",
          "contributor_name",
          "contributor_phone",
          "payment_method",
          "amount",
          "transaction_id",
          "created_at",
        ].join(", ")
      )
      .in("id", contributionIds);

    if (contributionsError) {
      throw contributionsError;
    }

    contributionsById = Object.fromEntries(
      (contributions || []).map(
        (contribution) => [
          contribution.id,
          contribution,
        ]
      )
    );
  }

  return records.map((transaction) => ({
    ...transaction,
    amount: toSafeNumber(transaction.amount),
    event:
      transaction.event_id
        ? eventsById[transaction.event_id] || null
        : null,
    contribution:
      transaction.contribution_id
        ? contributionsById[
            transaction.contribution_id
          ] || null
        : null,
  }));
}

async function getPaypackToken() {
  const response = await axios.post(
    "https://payments.paypack.rw/api/auth/agents/authorize",
    {
      client_id: process.env.PAYPACK_CLIENT_ID,
      client_secret: process.env.PAYPACK_CLIENT_SECRET,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.access;
}

function formatPhone(phone) {
  if (!phone) {
    return "";
  }

  const clean = String(phone).replace(/[\s-]/g, "");

  if (clean.startsWith("+250")) {
    return `250${clean.slice(4)}`;
  }

  if (clean.startsWith("0")) {
    return `250${clean.slice(1)}`;
  }

  if (clean.startsWith("250")) {
    return clean;
  }

  return clean;
}

async function getPaypackCashoutStatus(
  reference,
  token
) {
  try {
    const response = await axios.get(
      `https://payments.paypack.rw/api/events/transactions?ref=${encodeURIComponent(
        reference
      )}&kind=CASHOUT`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    const transactions =
      response.data?.transactions || [];

    const processedEvent = transactions.find(
      (item) =>
        item.event_kind === "transaction:processed" &&
        item.data?.ref === reference &&
        item.data?.kind === "CASHOUT"
    );

    const status = String(
      processedEvent?.data?.status || "pending"
    ).toLowerCase();

    if (
      status === "successful" ||
      status === "success"
    ) {
      return {
        status: "success",
        paypack: processedEvent?.data || null,
      };
    }

    if (status === "failed") {
      return {
        status: "failed",
        paypack: processedEvent?.data || null,
      };
    }

    return {
      status: "pending",
      paypack: processedEvent?.data || null,
    };
  } catch (error) {
    console.error(
      `Admin Paypack withdrawal status check failed for ${reference}:`,
      error.response?.data || error.message
    );

    return {
      status: "pending",
      paypack: null,
    };
  }
}

async function syncPendingPlatformWithdrawals() {
  const { data: pending, error: pendingError } =
    await supabase
      .from("platform_transactions")
      .select("*")
      .eq("type", "withdrawal")
      .eq("status", "pending");

  if (pendingError) {
    throw pendingError;
  }

  if (!pending || pending.length === 0) {
    return;
  }

  const paypackToken = await getPaypackToken();

  for (const transaction of pending) {
    if (!transaction.reference) {
      continue;
    }

    const result = await getPaypackCashoutStatus(
      transaction.reference,
      paypackToken
    );

    if (result.status === "success") {
      const {
        data: updatedRows,
        error: updateError,
      } = await supabase
        .from("platform_transactions")
        .update({
          status: "success",
        })
        .eq("id", transaction.id)
        .eq("status", "pending")
        .select("id");

      if (updateError) {
        console.error(
          `Failed to complete platform withdrawal ${transaction.reference}:`,
          updateError.message
        );
        continue;
      }

      if (updatedRows && updatedRows.length > 0) {
        const wallet = await getPlatformWallet();

        const { error: walletUpdateError } =
          await supabase
            .from("platform_wallet")
            .update({
              total_withdrawn:
                toSafeNumber(wallet.total_withdrawn) +
                toSafeNumber(transaction.amount),
              updated_at: new Date().toISOString(),
            })
            .eq("id", wallet.id);

        if (walletUpdateError) {
          console.error(
            `Failed to update total withdrawn for ${transaction.reference}:`,
            walletUpdateError.message
          );
        }
      }

      continue;
    }

    if (result.status === "failed") {
      const {
        data: updatedRows,
        error: failUpdateError,
      } = await supabase
        .from("platform_transactions")
        .update({
          status: "failed",
        })
        .eq("id", transaction.id)
        .eq("status", "pending")
        .select("id");

      if (failUpdateError) {
        console.error(
          `Failed to mark platform withdrawal ${transaction.reference} failed:`,
          failUpdateError.message
        );
        continue;
      }

      if (!updatedRows || updatedRows.length === 0) {
        continue;
      }

      const wallet = await getPlatformWallet();

      const { error: refundError } = await supabase
        .from("platform_wallet")
        .update({
          balance:
            toSafeNumber(wallet.balance) +
            toSafeNumber(transaction.amount),
          updated_at: new Date().toISOString(),
        })
        .eq("id", wallet.id);

      if (refundError) {
        console.error(
          `Failed to refund platform withdrawal ${transaction.reference}:`,
          refundError.message
        );
      }
    }
  }
}

/* =========================================================
   GET /api/admin/wallet

   Main Admin Platform Wallet endpoint.
   Returns:
   - Available balance
   - Total fees earned
   - Fees today
   - Fees this month
   - Total withdrawn
   - Pending withdrawals
   - Recent fee transactions
========================================================= */

router.get(
  "/",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      await syncPendingPlatformWithdrawals();
      const wallet = await getPlatformWallet();

      const {
        startOfToday,
        startOfMonth,
      } = getKigaliBoundaries();

      const [
        feesToday,
        feesThisMonth,
        pendingWithdrawals,
        recentResult,
      ] = await Promise.all([
        sumSuccessfulPlatformFeesSince(
          startOfToday
        ),
        sumSuccessfulPlatformFeesSince(
          startOfMonth
        ),
        sumPendingWithdrawals(),
        supabase
          .from("platform_transactions")
          .select(
            [
              "id",
              "type",
              "amount",
              "reference",
              "contribution_id",
              "event_id",
              "status",
              "description",
              "created_at",
            ].join(", ")
          )
          .order("created_at", {
            ascending: false,
          })
          .limit(10),
      ]);

      if (recentResult.error) {
        throw recentResult.error;
      }

      const recentTransactions =
        await enrichTransactions(
          recentResult.data || []
        );

      return res.json({
        success: true,

        admin: {
          id: req.admin.id,
          name: req.admin.name,
          email: req.admin.email,
          role: req.admin.role,
        },

        wallet: {
          id: wallet.id,

          available_balance:
            toSafeNumber(wallet.balance),

          total_fees_earned:
            toSafeNumber(
              wallet.total_fees_earned
            ),

          fees_today:
            toSafeNumber(feesToday),

          fees_this_month:
            toSafeNumber(feesThisMonth),

          total_withdrawn:
            toSafeNumber(
              wallet.total_withdrawn
            ),

          pending_withdrawals:
            toSafeNumber(
              pendingWithdrawals
            ),

          created_at:
            wallet.created_at,

          updated_at:
            wallet.updated_at,

          currency: "RWF",
          timezone: KIGALI_TIMEZONE,
          minimum_withdrawal: MINIMUM_WITHDRAWAL,
        },

        recent_transactions:
          recentTransactions,
      });
    } catch (error) {
      console.error(
        "Get admin platform wallet error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not load the Contriba platform wallet.",
      });
    }
  }
);

/* =========================================================
   GET /api/admin/wallet/stats

   Lightweight endpoint for dashboard cards.
========================================================= */

router.get(
  "/stats",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      const wallet = await getPlatformWallet();

      const {
        startOfToday,
        startOfMonth,
      } = getKigaliBoundaries();

      const [
        feesToday,
        feesThisMonth,
        pendingWithdrawals,
      ] = await Promise.all([
        sumSuccessfulPlatformFeesSince(
          startOfToday
        ),
        sumSuccessfulPlatformFeesSince(
          startOfMonth
        ),
        sumPendingWithdrawals(),
      ]);

      return res.json({
        success: true,
        stats: {
          available_balance:
            toSafeNumber(wallet.balance),

          total_fees_earned:
            toSafeNumber(
              wallet.total_fees_earned
            ),

          fees_today:
            toSafeNumber(feesToday),

          fees_this_month:
            toSafeNumber(feesThisMonth),

          total_withdrawn:
            toSafeNumber(
              wallet.total_withdrawn
            ),

          pending_withdrawals:
            toSafeNumber(
              pendingWithdrawals
            ),

          currency: "RWF",
          timezone: KIGALI_TIMEZONE,
          updated_at:
            wallet.updated_at,
        },
      });
    } catch (error) {
      console.error(
        "Get admin wallet stats error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not load platform wallet statistics.",
      });
    }
  }
);

/* =========================================================
   GET /api/admin/wallet/transactions

   Query options:
   ?page=1
   ?limit=20
   ?type=all
   ?status=all
========================================================= */

router.get(
  "/transactions",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      const page = normalizePage(
        req.query.page
      );

      const limit = normalizeLimit(
        req.query.limit
      );

      const type =
        normalizeTransactionType(
          req.query.type
        );

      const status =
        normalizeTransactionStatus(
          req.query.status
        );

      const from =
        (page - 1) * limit;

      const to =
        from + limit - 1;

      let query = supabase
        .from("platform_transactions")
        .select(
          [
            "id",
            "type",
            "amount",
            "reference",
            "contribution_id",
            "event_id",
            "status",
            "description",
            "created_at",
          ].join(", "),
          {
            count: "exact",
          }
        )
        .order("created_at", {
          ascending: false,
        })
        .range(from, to);

      if (type !== "all") {
        query = query.eq(
          "type",
          type
        );
      }

      if (status !== "all") {
        query = query.eq(
          "status",
          status
        );
      }

      const {
        data,
        error,
        count,
      } = await query;

      if (error) {
        throw error;
      }

      const transactions =
        await enrichTransactions(
          data || []
        );

      const total = count || 0;

      const totalPages = Math.max(
        1,
        Math.ceil(
          total / limit
        )
      );

      return res.json({
        success: true,

        transactions,

        pagination: {
          page,
          limit,
          total,
          total_pages:
            totalPages,
          has_next_page:
            page < totalPages,
          has_previous_page:
            page > 1,
        },

        filters: {
          type,
          status,
        },
      });
    } catch (error) {
      console.error(
        "Get admin wallet transactions error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not load platform wallet transactions.",
      });
    }
  }
);

/* =========================================================
   POST /api/admin/wallet/withdraw

   Withdraw ONLY Contriba platform-fee profit.
   Organizer wallets are never touched by this endpoint.
========================================================= */

router.post(
  "/withdraw",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      const amount = Number(req.body.amount || 0);
      const method = String(
        req.body.method ||
          req.body.payment_method ||
          ""
      )
        .trim()
        .toLowerCase();

      const phone =
        req.body.phone ||
        req.body.phone_number ||
        "";

      if (!amount || !method || !phone) {
        return res.status(400).json({
          success: false,
          message:
            "Amount, payment method and phone number are required.",
        });
      }

      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          message:
            "Withdrawal amount must be a whole number greater than zero.",
        });
      }

      if (amount < MINIMUM_WITHDRAWAL) {
        return res.status(400).json({
          success: false,
          message: `Minimum withdrawal is RWF ${MINIMUM_WITHDRAWAL.toLocaleString()}.`,
        });
      }

      if (!["mtn", "airtel"].includes(method)) {
        return res.status(400).json({
          success: false,
          message:
            "Please choose MTN MoMo or Airtel Money.",
        });
      }

      const formattedPhone = formatPhone(phone);

      if (!/^2507\d{8}$/.test(formattedPhone)) {
        return res.status(400).json({
          success: false,
          message:
            "Please enter a valid Rwanda mobile money number.",
        });
      }

      // Resolve any older pending cash-outs before
      // checking the spendable platform balance.
      await syncPendingPlatformWithdrawals();

      const wallet = await getPlatformWallet();
      const availableBalance =
        toSafeNumber(wallet.balance);

      if (availableBalance < amount) {
        return res.status(400).json({
          success: false,
          message:
            "Insufficient platform wallet balance.",
        });
      }

      const paypackToken = await getPaypackToken();

      const response = await axios.post(
        "https://payments.paypack.rw/api/transactions/cashout",
        {
          amount,
          number: formattedPhone,
        },
        {
          headers: {
            Authorization: `Bearer ${paypackToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key":
              `admin-wd-${Date.now()}-${req.admin.id}`
                .replace(/[^a-zA-Z0-9-]/g, "")
                .slice(0, 32),
          },
        }
      );

      const paypackTransaction = response.data;

      if (!paypackTransaction?.ref) {
        return res.status(502).json({
          success: false,
          message:
            "Paypack did not return a withdrawal reference.",
        });
      }

      const initialStatus =
        String(
          paypackTransaction.status || ""
        ).toLowerCase() === "successful"
          ? "success"
          : "pending";

      const newBalance =
        availableBalance - amount;

      // Reserve/deduct the amount immediately so the
      // same platform balance cannot be withdrawn twice.
      const { error: walletUpdateError } =
        await supabase
          .from("platform_wallet")
          .update({
            balance: newBalance,
            total_withdrawn:
              initialStatus === "success"
                ? toSafeNumber(
                    wallet.total_withdrawn
                  ) + amount
                : toSafeNumber(
                    wallet.total_withdrawn
                  ),
            updated_at: new Date().toISOString(),
          })
          .eq("id", wallet.id);

      if (walletUpdateError) {
        throw walletUpdateError;
      }

      const {
        data: transaction,
        error: transactionError,
      } = await supabase
        .from("platform_transactions")
        .insert({
          type: "withdrawal",
          amount,
          reference: paypackTransaction.ref,
          status: initialStatus,
          description:
            `Admin platform withdrawal to ${formattedPhone} via ${method.toUpperCase()}`,
        })
        .select()
        .single();

      if (transactionError) {
        // The Paypack request already exists. Restore the
        // local reserved balance if ledger recording fails.
        await supabase
          .from("platform_wallet")
          .update({
            balance: availableBalance,
            total_withdrawn:
              toSafeNumber(wallet.total_withdrawn),
            updated_at: new Date().toISOString(),
          })
          .eq("id", wallet.id);

        throw transactionError;
      }

      return res.json({
        success: true,
        message:
          initialStatus === "success"
            ? "Platform withdrawal completed successfully."
            : "Platform withdrawal initiated. Check the mobile money account.",
        transaction,
        transaction_ref:
          paypackTransaction.ref,
        status: initialStatus,
        new_balance: newBalance,
        minimum_withdrawal:
          MINIMUM_WITHDRAWAL,
      });
    } catch (error) {
      console.error(
        "Admin platform withdrawal error:",
        error.response?.data || error.message
      );

      return res.status(500).json({
        success: false,
        message:
          error.response?.data?.message ||
          "Failed to process platform withdrawal.",
      });
    }
  }
);

module.exports = router;