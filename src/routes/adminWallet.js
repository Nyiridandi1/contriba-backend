const express = require("express");
const jwt = require("jsonwebtoken");

const supabase = require("../config/database");

const router = express.Router();

const KIGALI_TIMEZONE = "Africa/Kigali";
const KIGALI_OFFSET = "+02:00";

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
   WITHDRAWALS

   Intentionally NOT implemented in this file yet.

   First we verify that Admin Center reads the correct
   platform wallet balance and fee ledger safely.

   The withdrawal endpoint will be added only after the
   read-only wallet is confirmed working.
========================================================= */

module.exports = router;