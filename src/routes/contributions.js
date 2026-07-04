const express = require("express");
const router = express.Router();
const supabase = require("../config/database");

// ── MIDDLEWARE: Verify JWT Token ──
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "No token provided",
    });
  }

  try {
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }
};

// ── Send Push Notification ──
async function sendPushNotification(pushToken, title, body, data = {}) {
  try {
    if (!pushToken) return;

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: pushToken,
        sound: "default",
        title,
        body,
        data,
      }),
    });

    const result = await response.json();
    console.log("Push notification result:", result);
  } catch (err) {
    console.error("Push notification error:", err.message);
  }
}

// ── Helpers ──
function getInitials(name) {
  if (!name || name === "Anonymous") return "AN";

  return name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatAmount(amount) {
  return `RWF ${Number(amount || 0).toLocaleString()}`;
}

function formatMethod(method) {
  if (!method) return "Unknown";

  const clean = method.toLowerCase();

  if (clean.includes("mtn")) return "MTN MoMo";
  if (clean.includes("airtel")) return "Airtel Money";
  if (clean.includes("visa") || clean.includes("card")) return "Visa / Card";

  return method;
}

function formatStatus(status) {
  if (!status) return "Pending";

  const clean = status.toLowerCase();

  if (clean === "success") return "Success";
  if (clean === "failed") return "Failed";
  return "Pending";
}

function normalizeStatusForDb(status) {
  if (!status) return null;

  const clean = status.toLowerCase();

  if (clean === "success") return "success";
  if (clean === "failed") return "failed";
  if (clean === "pending") return "pending";

  return null;
}

function buildReceiptId(contribution) {
  if (contribution.receipt_id) return contribution.receipt_id;

  const shortId = String(contribution.id || "").slice(0, 8).toUpperCase();
  return `CTR-${shortId}`;
}

async function saveContributionHistory({
  contribution_id,
  event_id,
  user_id,
  title,
  detail,
  status = "pending",
}) {
  try {
    await supabase.from("contribution_history").insert({
      contribution_id,
      event_id,
      user_id,
      title,
      detail,
      status,
    });
  } catch (err) {
    console.error("Contribution history save error:", err.message);
  }
}

function mapContribution(item, eventMap = {}) {
  const isAnonymous = item.is_anonymous === true;
  const displayName = isAnonymous
    ? "Anonymous"
    : item.contributor_name || "Unknown Contributor";

  const eventTitle =
    eventMap[item.event_id]?.title || item.event_title || "All Events";

  return {
    id: item.id,
    event_id: item.event_id,
    event_title: eventTitle,
    name: displayName,
    phone: isAnonymous ? "Hidden" : item.contributor_phone || "Hidden",
    amount: formatAmount(item.amount),
    raw_amount: Number(item.amount || 0),
    method: formatMethod(item.payment_method),
    date: item.created_at,
    time: item.created_at,
    status: formatStatus(item.status),
    raw_status: item.status || "pending",
    message: item.message || "No message provided.",
    avatar: getInitials(displayName),
    total: formatAmount(item.amount),
    contributions: 1,
    transaction_id: item.transaction_id || null,
    receipt_id: item.receipt_id || buildReceiptId(item),
    thank_you_sent: item.thank_you_sent === true,
    thank_you_sent_at: item.thank_you_sent_at || null,
  };
}

async function getOwnerEvents(userId) {
  const { data: events, error } = await supabase
    .from("events")
    .select("id, title, owner_id, status, goal_amount, total_raised, created_at")
    .eq("owner_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return events || [];
}

function buildEventMap(events = []) {
  return events.reduce((acc, event) => {
    acc[event.id] = event;
    return acc;
  }, {});
}

function calculateAnalytics(contributions = []) {
  const successful = contributions.filter((item) => item.status === "success");
  const pending = contributions.filter((item) => item.status === "pending");
  const failed = contributions.filter((item) => item.status === "failed");

  const totalCollected = successful.reduce(
    (sum, item) => sum + Number(item.amount || 0),
    0
  );

  const averageContribution =
    successful.length > 0
      ? Math.round(totalCollected / successful.length)
      : 0;

  const highestContribution = [...contributions].sort(
    (a, b) => Number(b.amount || 0) - Number(a.amount || 0)
  )[0];

  const methodCounts = contributions.reduce((acc, item) => {
    const method = formatMethod(item.payment_method);
    acc[method] = (acc[method] || 0) + 1;
    return acc;
  }, {});

  const mostUsedMethod =
    Object.entries(methodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    "None yet";

  const successRate =
    contributions.length > 0
      ? Math.round((successful.length / contributions.length) * 100)
      : 0;

  return {
    total_contributions: contributions.length,
    successful_contributions: successful.length,
    pending_contributions: pending.length,
    failed_contributions: failed.length,
    total_collected: totalCollected,
    average_contribution: averageContribution,
    highest_contribution: highestContribution
      ? {
          id: highestContribution.id,
          name: highestContribution.is_anonymous
            ? "Anonymous"
            : highestContribution.contributor_name,
          amount: Number(highestContribution.amount || 0),
          formatted_amount: formatAmount(highestContribution.amount),
        }
      : null,
    most_used_method: mostUsedMethod,
    success_rate: successRate,
  };
}

function buildAIRecommendation(contributions = [], analytics = {}) {
  if (contributions.length === 0) {
    return {
      title: "No contributor data yet",
      message:
        "Create and share your first event to start building your contributor CRM.",
    };
  }

  const followUpCount =
    Number(analytics.pending_contributions || 0) +
    Number(analytics.failed_contributions || 0);

  if (followUpCount > 0) {
    return {
      title: `${followUpCount} payments need attention`,
      message:
        "Follow up with pending or failed contributors to recover missed support.",
    };
  }

  const unthanked = contributions.filter(
    (item) => item.status === "success" && item.thank_you_sent !== true
  ).length;

  if (unthanked > 0) {
    return {
      title: `${unthanked} thank-you messages pending`,
      message:
        "Send thank-you messages now to build trust and encourage event sharing.",
    };
  }

  return {
    title: "Contributor flow looks healthy",
    message: `Most used method is ${
      analytics.most_used_method || "None yet"
    }. Success rate is ${analytics.success_rate || 0}%.`,
  };
}function applyContributionFilters(contributions = [], query = {}) {
  let list = [...contributions];

  const search = String(query.search || "").trim().toLowerCase();
  const eventId = query.event_id || query.eventId || "";
  const method = String(query.method || "").trim().toLowerCase();
  const status = normalizeStatusForDb(query.status);
  const sort = query.sort || "latest";

  if (eventId && eventId !== "all") {
    list = list.filter((item) => String(item.event_id) === String(eventId));
  }

  if (search) {
    list = list.filter((item) => {
      return (
        item.contributor_name?.toLowerCase().includes(search) ||
        item.contributor_phone?.toLowerCase().includes(search) ||
        item.payment_method?.toLowerCase().includes(search) ||
        item.message?.toLowerCase().includes(search) ||
        item.status?.toLowerCase().includes(search) ||
        String(item.amount || "").includes(search)
      );
    });
  }

  if (method && method !== "all methods") {
    list = list.filter((item) =>
      formatMethod(item.payment_method).toLowerCase().includes(method)
    );
  }

  if (status) {
    list = list.filter((item) => item.status === status);
  }

  if (sort === "highest") {
    list.sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
  }

  if (sort === "lowest") {
    list.sort((a, b) => Number(a.amount || 0) - Number(b.amount || 0));
  }

  if (sort === "latest") {
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  if (sort === "oldest") {
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  return list;
}

function paginate(list = [], page = 1, limit = 20) {
  const safePage = Math.max(Number(page || 1), 1);
  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 100);

  const total = list.length;
  const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
  const start = (safePage - 1) * safeLimit;

  return {
    page: safePage,
    limit: safeLimit,
    total,
    total_pages: totalPages,
    has_next: safePage < totalPages,
    has_previous: safePage > 1,
    data: list.slice(start, start + safeLimit),
  };
}

async function getContributionWithEvent(contributionId, userId) {
  const { data: contribution, error: contributionError } = await supabase
    .from("contributions")
    .select("*")
    .eq("id", contributionId)
    .single();

  if (contributionError || !contribution) {
    return {
      error: {
        status: 404,
        message: "Contribution not found",
      },
    };
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("*")
    .eq("id", contribution.event_id)
    .single();

  if (eventError || !event) {
    return {
      error: {
        status: 404,
        message: "Event not found",
      },
    };
  }

  if (event.owner_id !== userId) {
    return {
      error: {
        status: 403,
        message: "You are not allowed to access this contribution",
      },
    };
  }

  return {
    contribution,
    event,
  };
}

// ── GET /api/contributions/events ── Organizer events for CRM filter
router.get("/events", verifyToken, async (req, res) => {
  try {
    const events = await getOwnerEvents(req.user.userId);

    res.json({
      success: true,
      events: [
        {
          id: "all",
          title: "All Event Supporters",
        },
        ...events.map((event) => ({
          id: event.id,
          title: event.title,
          status: event.status,
          goal_amount: event.goal_amount,
          total_raised: event.total_raised,
          created_at: event.created_at,
        })),
      ],
    });
  } catch (err) {
    console.error("Contributor events error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to get contributor events",
    });
  }
});

// ── GET /api/contributions/crm ── Contributor CRM Data
router.get("/crm", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const events = await getOwnerEvents(userId);
    const eventIds = events.map((event) => event.id);
    const eventMap = buildEventMap(events);

    if (eventIds.length === 0) {
      return res.json({
        success: true,
        stats: {
          total_contributors: 0,
          total_collected: 0,
          thank_you_pending: 0,
          failed_pending: 0,
        },
        contributors: [],
        pagination: paginate([], req.query.page, req.query.limit),
        analytics: calculateAnalytics([]),
        ai_recommendation: buildAIRecommendation([], calculateAnalytics([])),
        events: [
          {
            id: "all",
            title: "All Event Supporters",
          },
        ],
      });
    }

    const { data: contributions, error: contributionsError } = await supabase
      .from("contributions")
      .select("*")
      .in("event_id", eventIds)
      .order("created_at", { ascending: false });

    if (contributionsError) throw contributionsError;

    const allContributions = contributions || [];
    const filtered = applyContributionFilters(allContributions, req.query);
    const paginated = paginate(filtered, req.query.page, req.query.limit);

    const successfulContributions = filtered.filter(
      (item) => item.status === "success"
    );

    const totalCollected = successfulContributions.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );

    const failedPending = filtered.filter(
      (item) => item.status === "failed" || item.status === "pending"
    ).length;

    const thankYouPending = successfulContributions.filter(
      (item) => item.thank_you_sent !== true
    ).length;

    const analytics = calculateAnalytics(filtered);

    res.json({
      success: true,
      stats: {
        total_contributors: successfulContributions.length,
        total_collected: totalCollected,
        thank_you_pending: thankYouPending,
        failed_pending: failedPending,
      },
      contributors: paginated.data.map((item) => mapContribution(item, eventMap)),
      pagination: {
        page: paginated.page,
        limit: paginated.limit,
        total: paginated.total,
        total_pages: paginated.total_pages,
        has_next: paginated.has_next,
        has_previous: paginated.has_previous,
      },
      analytics,
      ai_recommendation: buildAIRecommendation(filtered, analytics),
      events: [
        {
          id: "all",
          title: "All Event Supporters",
        },
        ...events.map((event) => ({
          id: event.id,
          title: event.title,
          status: event.status,
          goal_amount: event.goal_amount,
          total_raised: event.total_raised,
          created_at: event.created_at,
        })),
      ],
    });
  } catch (err) {
    console.error("Contributor CRM error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to get contributor CRM data",
    });
  }
});

// ── GET /api/contributions/analytics ──
router.get("/analytics", verifyToken, async (req, res) => {
  try {
    const events = await getOwnerEvents(req.user.userId);
    const eventIds = events.map((event) => event.id);

    if (eventIds.length === 0) {
      return res.json({
        success: true,
        analytics: calculateAnalytics([]),
      });
    }

    const { data: contributions, error } = await supabase
      .from("contributions")
      .select("*")
      .in("event_id", eventIds);

    if (error) throw error;

    const filtered = applyContributionFilters(contributions || [], req.query);

    res.json({
      success: true,
      analytics: calculateAnalytics(filtered),
    });
  } catch (err) {
    console.error("Contributor analytics error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to get contributor analytics",
    });
  }
});// ── GET /api/contributions/ai-insights ──
router.get("/ai-insights", verifyToken, async (req, res) => {
  try {
    const events = await getOwnerEvents(req.user.userId);
    const eventIds = events.map((event) => event.id);

    if (eventIds.length === 0) {
      const analytics = calculateAnalytics([]);

      return res.json({
        success: true,
        ai_recommendation: buildAIRecommendation([], analytics),
        insights: [],
      });
    }

    const { data: contributions, error } = await supabase
      .from("contributions")
      .select("*")
      .in("event_id", eventIds);

    if (error) throw error;

    const filtered = applyContributionFilters(contributions || [], req.query);
    const analytics = calculateAnalytics(filtered);
    const aiRecommendation = buildAIRecommendation(filtered, analytics);

    const insights = [
      {
        title: "Success Rate",
        value: `${analytics.success_rate}%`,
        message: "Shows how many contributions completed successfully.",
      },
      {
        title: "Average Contribution",
        value: formatAmount(analytics.average_contribution),
        message: "Average amount from successful contributors.",
      },
      {
        title: "Most Used Method",
        value: analytics.most_used_method,
        message: "Most common payment method among contributors.",
      },
      {
        title: "Pending / Failed",
        value: String(
          analytics.pending_contributions + analytics.failed_contributions
        ),
        message: "Contributors who may need follow-up.",
      },
    ];

    res.json({
      success: true,
      ai_recommendation: aiRecommendation,
      insights,
      analytics,
    });
  } catch (err) {
    console.error("Contributor AI insights error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to get contributor AI insights",
    });
  }
});

// ── GET /api/contributions/export ──
router.get("/export", verifyToken, async (req, res) => {
  try {
    const events = await getOwnerEvents(req.user.userId);
    const eventIds = events.map((event) => event.id);
    const eventMap = buildEventMap(events);

    if (eventIds.length === 0) {
      return res.json({
        success: true,
        csv: "",
        contributors: [],
      });
    }

    const { data: contributions, error } = await supabase
      .from("contributions")
      .select("*")
      .in("event_id", eventIds)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const filtered = applyContributionFilters(contributions || [], req.query);
    const contributors = filtered.map((item) => mapContribution(item, eventMap));

    const headers = [
      "Name",
      "Phone",
      "Event",
      "Amount",
      "Method",
      "Status",
      "Date",
      "Message",
      "Thank You Sent",
      "Receipt ID",
      "Transaction ID",
    ];

    const rows = contributors.map((person) => [
      person.name,
      person.phone,
      person.event_title,
      person.amount,
      person.method,
      person.status,
      person.date,
      person.message,
      person.thank_you_sent ? "Yes" : "No",
      person.receipt_id || "",
      person.transaction_id || "",
    ]);

    const csv = [
      headers.join(","),
      ...rows.map((row) =>
        row
          .map((value) => `"${String(value || "").replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");

    res.json({
      success: true,
      csv,
      contributors,
      filename: "contriba-contributors.csv",
    });
  } catch (err) {
    console.error("Contributor export error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to export contributors",
    });
  }
});

// ── POST /api/contributions/:id/thank-you ──
router.post("/:id/thank-you", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await getContributionWithEvent(id, userId);

    if (result.error) {
      return res.status(result.error.status).json({
        success: false,
        message: result.error.message,
      });
    }

    const { contribution, event } = result;

    if (contribution.status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Only successful contributors can receive a thank-you message",
      });
    }

    const receiptId = buildReceiptId(contribution);

    const { data: updatedContribution, error: updateError } = await supabase
      .from("contributions")
      .update({
        thank_you_sent: true,
        thank_you_sent_at: new Date().toISOString(),
        receipt_id: contribution.receipt_id || receiptId,
      })
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    await saveContributionHistory({
      contribution_id: contribution.id,
      event_id: contribution.event_id,
      user_id: userId,
      title: "Thank-you message sent",
      detail: `Organizer thanked ${
        contribution.is_anonymous
          ? "Anonymous"
          : contribution.contributor_name || "a contributor"
      } for contributing to "${event.title}".`,
      status: "success",
    });

    await supabase.from("notifications").insert({
      user_id: userId,
      title: "Thank-you Sent",
      message: `You thanked ${
        contribution.is_anonymous
          ? "Anonymous"
          : contribution.contributor_name || "a contributor"
      } for contributing to "${event.title}".`,
      type: "thank_you",
    });

    res.json({
      success: true,
      message: "Thank-you message marked as sent",
      contribution: updatedContribution,
    });
  } catch (err) {
    console.error("Thank-you error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to send thank-you message",
    });
  }
});

// ── GET /api/contributions/:id/receipt ──
router.get("/:id/receipt", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await getContributionWithEvent(id, req.user.userId);

    if (result.error) {
      return res.status(result.error.status).json({
        success: false,
        message: result.error.message,
      });
    }

    const { contribution, event } = result;
    const receiptId = buildReceiptId(contribution);

    if (!contribution.receipt_id) {
      await supabase
        .from("contributions")
        .update({
          receipt_id: receiptId,
        })
        .eq("id", id);
    }

    const receipt = {
      receipt_id: receiptId,
      contribution_id: contribution.id,
      event_id: event.id,
      event_title: event.title,
      organizer_id: event.owner_id,
      contributor_name: contribution.is_anonymous
        ? "Anonymous"
        : contribution.contributor_name || "Unknown Contributor",
      contributor_phone: contribution.is_anonymous
        ? "Hidden"
        : contribution.contributor_phone || "Hidden",
      amount: Number(contribution.amount || 0),
      formatted_amount: formatAmount(contribution.amount),
      payment_method: formatMethod(contribution.payment_method),
      status: formatStatus(contribution.status),
      transaction_id: contribution.transaction_id || null,
      message: contribution.message || "No message provided.",
      paid_at: contribution.created_at,
      generated_at: new Date().toISOString(),
    };

    await saveContributionHistory({
      contribution_id: contribution.id,
      event_id: event.id,
      user_id: req.user.userId,
      title: "Receipt generated",
      detail: `Receipt ${receiptId} was generated for ${receipt.formatted_amount}.`,
      status: "success",
    });

    res.json({
      success: true,
      receipt,
    });
  } catch (err) {
    console.error("Receipt error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to get receipt",
    });
  }
});// ── GET /api/contributions/:id/receipt/download ──
// For now this returns receipt text data. Later we can turn this into real PDF.
router.get("/:id/receipt/download", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await getContributionWithEvent(id, req.user.userId);

    if (result.error) {
      return res.status(result.error.status).json({
        success: false,
        message: result.error.message,
      });
    }

    const { contribution, event } = result;
    const receiptId = buildReceiptId(contribution);

    const receiptText = `
CONTRIBA RECEIPT
------------------------------
Receipt ID: ${receiptId}
Event: ${event.title}
Contributor: ${
      contribution.is_anonymous
        ? "Anonymous"
        : contribution.contributor_name || "Unknown Contributor"
    }
Phone: ${
      contribution.is_anonymous
        ? "Hidden"
        : contribution.contributor_phone || "Hidden"
    }
Amount: ${formatAmount(contribution.amount)}
Payment Method: ${formatMethod(contribution.payment_method)}
Status: ${formatStatus(contribution.status)}
Transaction ID: ${contribution.transaction_id || "N/A"}
Message: ${contribution.message || "No message provided."}
Date: ${contribution.created_at}
------------------------------
Thank you for supporting this event.
`;

    await saveContributionHistory({
      contribution_id: contribution.id,
      event_id: event.id,
      user_id: req.user.userId,
      title: "Receipt downloaded",
      detail: `Receipt ${receiptId} was downloaded.`,
      status: "success",
    });

    res.json({
      success: true,
      receipt_id: receiptId,
      filename: `${receiptId}.txt`,
      content: receiptText,
    });
  } catch (err) {
    console.error("Receipt download error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to download receipt",
    });
  }
});

// ── GET /api/contributions/:id/timeline ──
router.get("/:id/timeline", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await getContributionWithEvent(id, req.user.userId);

    if (result.error) {
      return res.status(result.error.status).json({
        success: false,
        message: result.error.message,
      });
    }

    const { contribution, event } = result;

    const { data: history, error } = await supabase
      .from("contribution_history")
      .select("*")
      .eq("contribution_id", id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    const baseTimeline = [
      {
        title: "Contribution created",
        detail: `${formatAmount(contribution.amount)} contribution started for "${
          event.title
        }".`,
        status: "pending",
        created_at: contribution.created_at,
      },
    ];

    if (contribution.status === "success") {
      baseTimeline.push({
        title: "Payment confirmed",
        detail: `${formatAmount(contribution.amount)} received through ${formatMethod(
          contribution.payment_method
        )}.`,
        status: "success",
        created_at: contribution.created_at,
      });
    }

    if (contribution.status === "failed") {
      baseTimeline.push({
        title: "Payment failed",
        detail: "Payment failed before confirmation.",
        status: "failed",
        created_at: contribution.created_at,
      });
    }

    if (contribution.thank_you_sent) {
      baseTimeline.push({
        title: "Thank-you message sent",
        detail: "Organizer has thanked this contributor.",
        status: "success",
        created_at: contribution.thank_you_sent_at || contribution.created_at,
      });
    }

    const savedTimeline = (history || []).map((item) => ({
      title: item.title,
      detail: item.detail,
      status: item.status,
      created_at: item.created_at,
    }));

    res.json({
      success: true,
      timeline: [...baseTimeline, ...savedTimeline],
    });
  } catch (err) {
    console.error("Timeline error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to get contribution timeline",
    });
  }
});

// ── POST /api/contributions/initiate ──
router.post("/initiate", async (req, res) => {
  try {
    const {
      event_id,
      contributor_name,
      contributor_phone,
      amount,
      payment_method,
      message,
      is_anonymous,
    } = req.body;

    if (
      !event_id ||
      !contributor_name ||
      !contributor_phone ||
      !amount ||
      !payment_method
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("*")
      .eq("id", event_id)
      .single();

    if (eventError || !event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const receiptId = `CTR-${Date.now()}`;

    const { data: contribution, error } = await supabase
      .from("contributions")
      .insert({
        event_id,
        contributor_name,
        contributor_phone,
        amount,
        payment_method,
        message,
        status: "pending",
        is_anonymous: is_anonymous || false,
        thank_you_sent: false,
        receipt_id: receiptId,
      })
      .select()
      .single();

    if (error) throw error;

    await saveContributionHistory({
      contribution_id: contribution.id,
      event_id,
      user_id: event.owner_id,
      title: "Contribution created",
      detail: `${contributor_name} started a ${formatAmount(
        amount
      )} contribution.`,
      status: "pending",
    });

    res.json({
      success: true,
      message: "Contribution initiated",
      contribution,
    });
  } catch (err) {
    console.error("Initiate contribution error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to initiate contribution",
    });
  }
});

// ── GET /api/contributions/event/:eventId ──
router.get("/event/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;

    const { data: contributions, error } = await supabase
      .from("contributions")
      .select("*")
      .eq("event_id", eventId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const totalRaised = contributions
      .filter((c) => c.status === "success")
      .reduce((sum, c) => sum + Number(c.amount || 0), 0);

    res.json({
      success: true,
      contributions,
      total_raised: totalRaised,
      total_contributors: contributions.filter((c) => c.status === "success")
        .length,
    });
  } catch (err) {
    console.error("Get contributions error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to get contributions",
    });
  }
});

// ── PUT /api/contributions/:id/confirm ──
router.put("/:id/confirm", async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;

    const { data: contribution, error } = await supabase
      .from("contributions")
      .update({
        status: "success",
        transaction_id,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    const { data: event } = await supabase
      .from("events")
      .select("*, users(push_token, name)")
      .eq("id", contribution.event_id)
      .single();

    if (event) {
      await supabase
        .from("events")
        .update({
          total_raised: (event.total_raised || 0) + Number(contribution.amount || 0),
        })
        .eq("id", contribution.event_id);

      const { data: wallet } = await supabase
        .from("wallets")
        .select("*")
        .eq("user_id", event.owner_id)
        .single();

      if (wallet) {
        await supabase
          .from("wallets")
          .update({
            balance: (wallet.balance || 0) + Number(contribution.amount || 0),
            total_in: (wallet.total_in || 0) + Number(contribution.amount || 0),
          })
          .eq("user_id", event.owner_id);
      }

      await supabase.from("transactions").insert({
        wallet_id: wallet?.id,
        type: "in",
        amount: Number(contribution.amount || 0),
        reference: transaction_id,
        status: "success",
      });

      await saveContributionHistory({
        contribution_id: contribution.id,
        event_id: contribution.event_id,
        user_id: event.owner_id,
        title: "Payment confirmed",
        detail: `${formatAmount(contribution.amount)} received through ${formatMethod(
          contribution.payment_method
        )}.`,
        status: "success",
      });

      const displayName = contribution.is_anonymous
        ? "Someone 🙈"
        : contribution.contributor_name;

      const notifMessage = `${displayName} contributed RWF ${Number(
        contribution.amount || 0
      ).toLocaleString()} to "${event.title}"! 🎉`;

      await supabase.from("notifications").insert({
        user_id: event.owner_id,
        title: "💰 New Contribution Received!",
        message: notifMessage,
        type: "contribution",
      });

      const { data: ownerData } = await supabase
        .from("users")
        .select("push_token, name")
        .eq("id", event.owner_id)
        .single();

      if (ownerData?.push_token) {
        await sendPushNotification(
          ownerData.push_token,
          "💰 New Contribution!",
          notifMessage,
          {
            event_id: contribution.event_id,
            contribution_id: id,
          }
        );

        console.log(`Push notification sent to ${ownerData.name || "owner"}`);
      }
    }

    res.json({
      success: true,
      message: "Contribution confirmed",
      contribution,
    });
  } catch (err) {
    console.error("Confirm contribution error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to confirm contribution",
    });
  }
});

module.exports = router;