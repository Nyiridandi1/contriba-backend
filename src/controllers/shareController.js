const supabase = require("../config/database");

const {
  generateEventShareImage,
} = require("../services/shareImageGenerator");

const shareImageCache = new Map();

const ALLOWED_PLATFORMS = [
  "whatsapp",
  "instagram",
  "facebook",
  "direct_link",
  "copy_link",
  "native_share",
  "qr",
  "poster",
  "sms",
  "email",
];

function getClientMeta(req) {
  const userAgent = req.headers["user-agent"] || "";
  const forwardedFor = req.headers["x-forwarded-for"];

  const ip =
    (typeof forwardedFor === "string" &&
      forwardedFor.split(",")[0]?.trim()) ||
    req.socket?.remoteAddress ||
    req.ip ||
    null;

  return {
    ip_address: ip,
    user_agent: userAgent,
    referrer:
      req.headers.referer ||
      req.headers.referrer ||
      null,
  };
}

function parseNumber(value) {
  const parsed = Number(value || 0);

  return Number.isFinite(parsed) ? parsed : 0;
}

function formatHour(dateValue) {
  const date = dateValue
    ? new Date(dateValue)
    : new Date();

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  const hour = date.getHours();
  const next = (hour + 1) % 24;

  const format = (value) => {
    const suffix = value >= 12 ? "PM" : "AM";
    const normal = value % 12 || 12;

    return `${normal}${suffix}`;
  };

  return `${format(hour)} – ${format(next)}`;
}

function dateKey(dateValue) {
  const date = dateValue
    ? new Date(dateValue)
    : new Date();

  if (Number.isNaN(date.getTime())) {
    return new Date()
      .toISOString()
      .slice(0, 10);
  }

  return date
    .toISOString()
    .slice(0, 10);
}

function normalizePlatform(platform) {
  const clean = String(
    platform || "direct_link"
  )
    .trim()
    .toLowerCase();

  if (clean === "link") {
    return "direct_link";
  }

  if (clean === "copy") {
    return "copy_link";
  }

  return ALLOWED_PLATFORMS.includes(clean)
    ? clean
    : "direct_link";
}

async function getEvent(eventId) {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getEventCreator(ownerId) {
  if (!ownerId) {
    return null;
  }

  const { data, error } = await supabase
    .from("users")
    .select("id, name, phone, avatar_url")
    .eq("id", ownerId)
    .maybeSingle();

  if (error) {
    console.warn(
      "Share image creator lookup failed:",
      error.message
    );

    return null;
  }

  return data || null;
}

async function getContributions(eventId) {
  const { data, error } = await supabase
    .from("contributions")
    .select("*")
    .eq("event_id", eventId);

  if (error) {
    console.warn(
      "Share contributions lookup failed:",
      error.message
    );

    return [];
  }

  return Array.isArray(data)
    ? data
    : [];
}

function successfulContributions(contributions) {
  return contributions.filter((item) => {
    const status = String(
      item.status ||
        item.payment_status ||
        ""
    ).toLowerCase();

    return (
      !status ||
      [
        "success",
        "paid",
        "completed",
        "confirmed",
      ].includes(status)
    );
  });
}

function contributionAmount(item) {
  return parseNumber(
    item.amount ||
      item.paid_amount ||
      item.total_amount
  );
}

function contributorName(item) {
  return (
    item.contributor_name ||
    item.name ||
    item.sender_name ||
    item.phone ||
    item.phone_number ||
    "Contributor"
  );
}

async function getShares(eventId) {
  const { data, error } = await supabase
    .from("event_shares")
    .select("*")
    .eq("event_id", eventId);

  if (error) {
    console.warn(
      "Share history lookup failed:",
      error.message
    );

    return [];
  }

  return Array.isArray(data)
    ? data
    : [];
}

async function getVisits(eventId) {
  const { data, error } = await supabase
    .from("event_visits")
    .select("*")
    .eq("event_id", eventId);

  if (error) {
    console.warn(
      "Visit history lookup failed:",
      error.message
    );

    return [];
  }

  return Array.isArray(data)
    ? data
    : [];
}

async function getQrScans(eventId) {
  const { data, error } = await supabase
    .from("qr_scans")
    .select("*")
    .eq("event_id", eventId);

  if (error) {
    console.warn(
      "QR history lookup failed:",
      error.message
    );

    return [];
  }

  return Array.isArray(data)
    ? data
    : [];
}

function buildOverview(
  event,
  shares,
  visits,
  qrScans,
  contributions
) {
  const paidContributions =
    successfulContributions(contributions);

  const raisedFromContributions =
    paidContributions.reduce(
      (sum, item) =>
        sum + contributionAmount(item),
      0
    );

  const raisedFromEvent = parseNumber(
    event?.total_raised ||
      event?.raised ||
      event?.amount_raised
  );

  const raised =
    raisedFromEvent ||
    raisedFromContributions;

  const contributorsFromEvent =
    parseNumber(
      event?.total_contributors ||
        event?.contributors ||
        event?.contributors_count
    );

  const contributors =
    contributorsFromEvent ||
    new Set(
      paidContributions.map((item) =>
        contributorName(item)
      )
    ).size;

  const visitors = visits.length;
  const totalShares = shares.length;
  const scans = qrScans.length;

  const goal = parseNumber(
    event?.goal_amount ||
      event?.target ||
      event?.goal
  );

  const progress =
    goal > 0
      ? Math.min(
          (raised / goal) * 100,
          100
        )
      : 0;

  const conversion =
    visitors > 0
      ? (contributors / visitors) * 100
      : 0;

  const shareCtr =
    visitors > 0
      ? (totalShares / visitors) * 100
      : 0;

  const platformCounts = shares.reduce(
    (accumulator, item) => {
      const platform =
        normalizePlatform(item.platform);

      accumulator[platform] =
        (accumulator[platform] || 0) + 1;

      return accumulator;
    },
    {}
  );

  const bestPlatform =
    Object.entries(platformCounts).sort(
      (a, b) => b[1] - a[1]
    )[0]?.[0] || "direct_link";  const hours = [
    ...shares,
    ...visits,
    ...qrScans,
  ].reduce((accumulator, item) => {
    const hour = formatHour(
      item.created_at ||
        item.shared_at ||
        item.visited_at ||
        item.scanned_at
    );

    accumulator[hour] =
      (accumulator[hour] || 0) + 1;

    return accumulator;
  }, {});

  const bestTime =
    Object.entries(hours).sort(
      (a, b) => b[1] - a[1]
    )[0]?.[0] || "6PM – 9PM";

  return {
    event,
    stats: {
      visitors,
      shares: totalShares,
      qr_scans: scans,
      contributors,
      contributions:
        paidContributions.length,
      raised,
      goal,
      remaining: Math.max(
        goal - raised,
        0
      ),
      progress,
      conversion,
      share_ctr: shareCtr,
      best_platform: bestPlatform,
      best_time: bestTime,
    },
    platform_counts: platformCounts,
  };
}

async function getShareOverview(req, res) {
  try {
    const { eventId } = req.params;

    const event = await getEvent(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const [
      shares,
      visits,
      qrScans,
      contributions,
    ] = await Promise.all([
      getShares(eventId),
      getVisits(eventId),
      getQrScans(eventId),
      getContributions(eventId),
    ]);

    return res.json({
      success: true,
      ...buildOverview(
        event,
        shares,
        visits,
        qrScans,
        contributions
      ),
    });
  } catch (error) {
    console.error(
      "Share overview error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to load share overview",
    });
  }
}

async function getShareImage(req, res) {
  try {
    const { eventId } = req.params;

    const version = String(req.query.v || "default");
    const cacheKey = `${eventId}:${version}`;

    const sendImage = (buffer) => {
      // Prevent stale cached metadata (important for social crawlers)
      res.removeHeader("ETag");
      res.removeHeader("Last-Modified");

      res.set({
        "Content-Type": "image/jpeg",
        "Content-Length": buffer.length,
        "Cache-Control":
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "Content-Disposition": `inline; filename="contriba-event-${eventId}.jpg`,
      });

      return res.status(200).send(buffer);
    };

    const cachedImage = shareImageCache.get(cacheKey);

    if (cachedImage) {
      return sendImage(cachedImage);
    }

    const event = await getEvent(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const [creator, contributions] = await Promise.all([
      getEventCreator(event.owner_id),
      getContributions(eventId),
    ]);

    const paidContributions =
      successfulContributions(contributions);

    const totalRaised = paidContributions.reduce(
      (sum, item) => sum + contributionAmount(item),
      0
    );

    const totalContributors = new Set(
      paidContributions.map((item) =>
        contributorName(item)
      )
    ).size;

    const eventForImage = {
      ...event,
      creator: creator || null,
      total_raised:
        parseNumber(
          event.total_raised ||
            event.raised ||
            event.amount_raised
        ) || totalRaised,
      total_contributors:
        parseNumber(
          event.total_contributors ||
            event.contributors ||
            event.contributors_count
        ) || totalContributors,
    };

    const imageBuffer =
      await generateEventShareImage(eventForImage);

    shareImageCache.set(cacheKey, imageBuffer);

    return sendImage(imageBuffer);
  } catch (error) {
    console.error("Share image generation error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to generate event share image",
    });
  }
}

async function trackShare(req, res) {
  try {
    const {
      event_id,
      platform,
      user_id = null,
    } = req.body || {};

    if (!event_id) {
      return res.status(400).json({
        success: false,
        message: "event_id is required",
      });
    }

    const event = await getEvent(event_id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const meta = getClientMeta(req);

    const { data, error } = await supabase
      .from("event_shares")
      .insert({
        event_id,
        user_id,
        platform:
          normalizePlatform(platform),
        ip_address: meta.ip_address,
        user_agent: meta.user_agent,
        referrer: meta.referrer,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      message:
        "Share tracked successfully",
      share: data,
    });
  } catch (error) {
    console.error(
      "Track share error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to track share",
    });
  }
}

async function trackVisit(req, res) {
  try {
    const {
      event_id,
      source = "direct",
      platform = null,
    } = req.body || {};

    if (!event_id) {
      return res.status(400).json({
        success: false,
        message: "event_id is required",
      });
    }

    const event = await getEvent(event_id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const meta = getClientMeta(req);

    const { data, error } = await supabase
      .from("event_visits")
      .insert({
        event_id,
        source,
        platform: platform
          ? normalizePlatform(platform)
          : null,
        ip_address: meta.ip_address,
        user_agent: meta.user_agent,
        referrer: meta.referrer,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      message:
        "Visit tracked successfully",
      visit: data,
    });
  } catch (error) {
    console.error(
      "Track visit error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to track visit",
    });
  }
}

async function trackQrScan(req, res) {
  try {
    const {
      event_id,
      source = "qr",
    } = req.body || {};

    if (!event_id) {
      return res.status(400).json({
        success: false,
        message: "event_id is required",
      });
    }

    const event = await getEvent(event_id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const meta = getClientMeta(req);

    const { data, error } = await supabase
      .from("qr_scans")
      .insert({
        event_id,
        source,
        ip_address: meta.ip_address,
        user_agent: meta.user_agent,
        referrer: meta.referrer,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      message:
        "QR scan tracked successfully",
      scan: data,
    });
  } catch (error) {
    console.error(
      "Track QR scan error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to track QR scan",
    });
  }
}

async function getShareAnalytics(req, res) {
  try {
    const { eventId } = req.params;

    const event = await getEvent(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const [
      shares,
      visits,
      qrScans,
      contributions,
    ] = await Promise.all([
      getShares(eventId),
      getVisits(eventId),
      getQrScans(eventId),
      getContributions(eventId),
    ]);

    const dailyMap = {};

    const addMetric = (
      date,
      key,
      amount = 1
    ) => {
      const day = dateKey(date);

      if (!dailyMap[day]) {
        dailyMap[day] = {
          date: day,
          visitors: 0,
          shares: 0,
          qr_scans: 0,
          contributions: 0,
          revenue: 0,
        };
      }

      dailyMap[day][key] += amount;
    };

    visits.forEach((item) => {
      addMetric(
        item.created_at ||
          item.visited_at,
        "visitors"
      );
    });

    shares.forEach((item) => {
      addMetric(
        item.created_at ||
          item.shared_at,
        "shares"
      );
    });

    qrScans.forEach((item) => {
      addMetric(
        item.created_at ||
          item.scanned_at,
        "qr_scans"
      );
    });

    successfulContributions(
      contributions
    ).forEach((item) => {
      addMetric(
        item.created_at ||
          item.paid_at,
        "contributions"
      );

      addMetric(
        item.created_at ||
          item.paid_at,
        "revenue",
        contributionAmount(item)
      );
    });

    return res.json({
      success: true,
      event,
      daily: Object.values(
        dailyMap
      ).sort((a, b) =>
        a.date.localeCompare(b.date)
      ),
      overview: buildOverview(
        event,
        shares,
        visits,
        qrScans,
        contributions
      ).stats,
    });
  } catch (error) {
    console.error(
      "Share analytics error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to load share analytics",
    });
  }
}

async function getSharePromoters(req, res) {
  try {
    const { eventId } = req.params;

    const event = await getEvent(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const contributions =
      await getContributions(eventId);

    const paid =
      successfulContributions(
        contributions
      );

    const promoterMap = new Map();

    paid.forEach((item) => {
      const name =
        contributorName(item);

      const current =
        promoterMap.get(name) || {
          name,
          total: 0,
          contributions: 0,
        };

      current.total +=
        contributionAmount(item);

      current.contributions += 1;

      promoterMap.set(
        name,
        current
      );
    });

    const promoters = Array.from(
      promoterMap.values()
    )
      .sort(
        (a, b) =>
          b.total - a.total
      )
      .slice(0, 10);

    return res.json({
      success: true,
      event,
      promoters,
    });
  } catch (error) {
    console.error(
      "Share promoters error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to load promoters",
    });
  }
}

async function getShareInsights(req, res) {
  try {
    const { eventId } = req.params;

    const event = await getEvent(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const [
      shares,
      visits,
      qrScans,
      contributions,
    ] = await Promise.all([
      getShares(eventId),
      getVisits(eventId),
      getQrScans(eventId),
      getContributions(eventId),
    ]);

    const overview = buildOverview(
      event,
      shares,
      visits,
      qrScans,
      contributions
    );

    const stats = overview.stats;
    const insights = [];

    if (stats.shares === 0) {
      insights.push(
        "Start by sharing your event link on WhatsApp and family groups."
      );
    } else {
      insights.push(
        `${stats.best_platform.replace(
          "_",
          " "
        )} is your strongest sharing channel so far.`
      );
    }

    if (stats.conversion > 0) {
      insights.push(
        `Your current visitor-to-contributor conversion is ${stats.conversion.toFixed(
          1
        )}%.`
      );
    } else {
      insights.push(
        "No tracked visitor has converted yet. Share again with a clear call to action."
      );
    }

    if (stats.remaining > 0) {
      insights.push(
        `You still need RWF ${Number(
          stats.remaining
        ).toLocaleString()} to reach your goal.`
      );
    } else if (stats.goal > 0) {
      insights.push(
        "Your event has reached its goal. Keep contributors updated and thank them."
      );
    }

    insights.push(
      `Best time based on current activity: ${stats.best_time}.`
    );

    return res.json({
      success: true,
      event,
      insights,
      summary: stats,
    });
  } catch (error) {
    console.error(
      "Share insights error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to load insights",
    });
  }
}

module.exports = {
  getShareOverview,
  getShareImage,
  trackShare,
  trackVisit,
  trackQrScan,
  getShareAnalytics,
  getSharePromoters,
  getShareInsights,
};