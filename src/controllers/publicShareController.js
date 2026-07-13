const supabase = require("../config/database");

const FRONTEND_URL = (
  process.env.FRONTEND_URL ||
  "https://www.contriba.online"
).replace(/\/+$/, "");

/*
|--------------------------------------------------------------------------
| HTML helpers
|--------------------------------------------------------------------------
*/

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cleanText(
  value,
  fallback = ""
) {
  return String(
    value || fallback
  )
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(
  value,
  maximumLength
) {
  const text =
    cleanText(value);

  if (
    text.length <=
    maximumLength
  ) {
    return text;
  }

  return `${text
    .slice(
      0,
      maximumLength - 1
    )
    .trim()}…`;
}

/*
|--------------------------------------------------------------------------
| Number helpers
|--------------------------------------------------------------------------
*/

function number(value) {
  const parsed =
    Number(value || 0);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : 0;
}

function formatMoney(value) {
  return `RWF ${Math.round(
    number(value)
  ).toLocaleString(
    "en-US"
  )}`;
}

/*
|--------------------------------------------------------------------------
| Contribution helpers
|--------------------------------------------------------------------------
*/

function successfulContributions(
  contributions
) {
  return (
    contributions || []
  ).filter((item) => {
    const status =
      String(
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

function contributionAmount(
  item
) {
  return number(
    item.amount ||
      item.paid_amount ||
      item.total_amount
  );
}

/*
|--------------------------------------------------------------------------
| URL helpers
|--------------------------------------------------------------------------
*/

function buildAbsoluteBackendUrl(
  req,
  pathname
) {
  const forwardedProtocol =
    req.headers[
      "x-forwarded-proto"
    ];

  const protocol =
    typeof forwardedProtocol ===
    "string"
      ? forwardedProtocol
          .split(",")[0]
          .trim()
      : req.protocol;

  const host =
    req.get("host") ||
    "contriba-backend-production.up.railway.app";

  return `${protocol}://${host}${pathname}`;
}

function createCacheVersion(
  req,
  event
) {
  const requestedVersion =
    cleanText(
      req.query?.v
    );

  if (requestedVersion) {
    return requestedVersion;
  }

  const eventVersion =
    event.updated_at ||
    event.created_at ||
    event.date ||
    event.event_date;

  if (eventVersion) {
    const date =
      new Date(
        eventVersion
      );

    if (
      !Number.isNaN(
        date.getTime()
      )
    ) {
      return String(
        date.getTime()
      );
    }
  }

  return String(
    Date.now()
  );
}

/*
|--------------------------------------------------------------------------
| Public share page
|--------------------------------------------------------------------------
*/

async function getPublicSharePage(
  req,
  res
) {
  try {
    const {
      eventId,
    } = req.params;

    const {
      data: event,
      error: eventError,
    } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .maybeSingle();

    if (eventError) {
      throw eventError;
    }

    if (!event) {
      return res
        .status(404)
        .set({
          "Content-Type":
            "text/html; charset=utf-8",

          "Cache-Control":
            "no-store, no-cache, must-revalidate",
        })
        .send(`
          <!doctype html>

          <html lang="en">
            <head>
              <meta charset="utf-8" />

              <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
              />

              <title>
                Event not found | Contriba
              </title>
            </head>

            <body
              style="
                margin: 0;
                min-height: 100vh;
                display: grid;
                place-items: center;
                font-family: Arial, sans-serif;
                background: #f7f8fb;
                color: #17181d;
              "
            >
              <div
                style="
                  padding: 30px;
                  text-align: center;
                "
              >
                <h1>
                  Event not found
                </h1>

                <p>
                  This Contriba event is unavailable.
                </p>

                <a
                  href="${escapeHtml(
                    FRONTEND_URL
                  )}"
                  style="
                    color: #e50914;
                    font-weight: 700;
                  "
                >
                  Return to Contriba
                </a>
              </div>
            </body>
          </html>
        `);
    }

    /*
    |--------------------------------------------------------------------------
    | Load organizer and contributions
    |--------------------------------------------------------------------------
    */

    const [
      creatorResult,
      contributionsResult,
    ] = await Promise.all([
      supabase
        .from("users")
        .select(
          "id, name"
        )
        .eq(
          "id",
          event.owner_id
        )
        .maybeSingle(),

      supabase
        .from(
          "contributions"
        )
        .select(
          "id, amount, paid_amount, total_amount, status, payment_status"
        )
        .eq(
          "event_id",
          eventId
        ),
    ]);

    const creator =
      creatorResult.data ||
      null;

    const contributions =
      contributionsResult.data ||
      [];

    const paidContributions =
      successfulContributions(
        contributions
      );

    const calculatedRaised =
      paidContributions.reduce(
        (
          sum,
          item
        ) => {
          return (
            sum +
            contributionAmount(
              item
            )
          );
        },
        0
      );

    const raised =
      number(
        event.total_raised ||
          event.raised ||
          event.amount_raised
      ) ||
      calculatedRaised;

    const goal =
      number(
        event.goal_amount ||
          event.goal ||
          event.target
      );

    const progress =
      goal > 0
        ? Math.min(
            Math.round(
              (
                raised /
                goal
              ) *
                100
            ),
            100
          )
        : 0;

    /*
    |--------------------------------------------------------------------------
    | Preview text
    |--------------------------------------------------------------------------
    */

    const title =
      truncate(
        event.title ||
          "Contriba Event",
        80
      );

    const organizerName =
      creator?.name ||
      event.organizer_name ||
      "Contriba Organizer";

    const fallbackDescription =
      `Support ${organizerName}'s event by contributing securely with Contriba.`;

    const description =
      truncate(
        event.description ||
          fallbackDescription,
        150
      );

    const previewDescription =
      goal > 0
        ? `${formatMoney(
            raised
          )} raised toward ${formatMoney(
            goal
          )} — ${progress}% funded. Contribute securely with Contriba.`
        : `${formatMoney(
            raised
          )} raised. Support this event securely with Contriba.`;

    /*
    |--------------------------------------------------------------------------
    | Cache version
    |--------------------------------------------------------------------------
    |
    | When the shared URL contains ?v=123, the exact same version is added
    | to the Open Graph image URL.
    |
    | This prevents WhatsApp and other platforms from reusing the old image.
    |
    */

    const cacheVersion =
      createCacheVersion(
        req,
        event
      );

    const encodedVersion =
      encodeURIComponent(
        cacheVersion
      );

    /*
    |--------------------------------------------------------------------------
    | Public URLs
    |--------------------------------------------------------------------------
    */

    const eventUrl =
      `${FRONTEND_URL}/events/${encodeURIComponent(
        eventId
      )}`;

    const imageBaseUrl =
      buildAbsoluteBackendUrl(
        req,
        `/api/share/events/${encodeURIComponent(
          eventId
        )}/image`
      );

    const imageUrl =
      `${imageBaseUrl}?v=${encodedVersion}`;

    const shareBaseUrl =
      buildAbsoluteBackendUrl(
        req,
        `/share/events/${encodeURIComponent(
          eventId
        )}`
      );

    const canonicalShareUrl =
      `${shareBaseUrl}?v=${encodedVersion}`;

    /*
    |--------------------------------------------------------------------------
    | Safe HTML values
    |--------------------------------------------------------------------------
    */

    const safeTitle =
      escapeHtml(title);

    const safeDescription =
      escapeHtml(
        previewDescription ||
          description
      );

    const safeImageUrl =
      escapeHtml(
        imageUrl
      );

    const safeCanonicalUrl =
      escapeHtml(
        canonicalShareUrl
      );

    const safeEventUrl =
      escapeHtml(
        eventUrl
      );

    /*
    |--------------------------------------------------------------------------
    | Return social preview HTML
    |--------------------------------------------------------------------------
    */

    return res
      .status(200)
      .set({
        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-store, no-cache, must-revalidate, proxy-revalidate",

        Pragma:
          "no-cache",

        Expires:
          "0",

        "Surrogate-Control":
          "no-store",
      })
      .send(`
        <!doctype html>

        <html lang="en">
          <head>
            <meta charset="utf-8" />

            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />

            <title>
              ${safeTitle} | Contriba
            </title>

            <meta
              name="description"
              content="${safeDescription}"
            />

            <link
              rel="canonical"
              href="${safeCanonicalUrl}"
            />

            <!-- Open Graph -->

            <meta
              property="og:type"
              content="website"
            />

            <meta
              property="og:site_name"
              content="Contriba"
            />

            <meta
              property="og:title"
              content="${safeTitle}"
            />

            <meta
              property="og:description"
              content="${safeDescription}"
            />

            <meta
              property="og:url"
              content="${safeCanonicalUrl}"
            />

            <meta
              property="og:image"
              content="${safeImageUrl}"
            />

            <meta
              property="og:image:url"
              content="${safeImageUrl}"
            />

            <meta
              property="og:image:secure_url"
              content="${safeImageUrl}"
            />

            <meta
              property="og:image:type"
              content="image/png"
            />

            <meta
              property="og:image:width"
              content="1200"
            />

            <meta
              property="og:image:height"
              content="630"
            />

            <meta
              property="og:image:alt"
              content="${safeTitle} event card"
            />

            <!-- Twitter / X -->

            <meta
              name="twitter:card"
              content="summary_large_image"
            />

            <meta
              name="twitter:title"
              content="${safeTitle}"
            />

            <meta
              name="twitter:description"
              content="${safeDescription}"
            />

            <meta
              name="twitter:image"
              content="${safeImageUrl}"
            />

            <meta
              name="twitter:image:alt"
              content="${safeTitle} event card"
            />

            <!-- Redirect real visitors -->

            <meta
              http-equiv="refresh"
              content="1;url=${safeEventUrl}"
            />

            <script>
              window.setTimeout(
                function () {
                  window.location.replace(
                    ${JSON.stringify(
                      eventUrl
                    )}
                  );
                },
                3000
              );
            </script>
          </head>

          <body
            style="
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              padding: 24px;
              box-sizing: border-box;
              font-family: Arial, sans-serif;
              text-align: center;
              background:
                radial-gradient(
                  circle at top,
                  rgba(229, 9, 20, 0.12),
                  transparent 35%
                ),
                #f7f8fb;
              color: #17181d;
            "
          >
            <main>
              <div
                style="
                  width: 56px;
                  height: 56px;
                  margin: 0 auto 18px;
                  display: grid;
                  place-items: center;
                  border-radius: 18px;
                  color: white;
                  background: #e50914;
                  font-size: 26px;
                  font-weight: 900;
                  box-shadow:
                    0 18px 38px
                    rgba(229, 9, 20, 0.24);
                "
              >
                C
              </div>

              <h1
                style="
                  margin: 0 0 10px;
                  font-size: 30px;
                "
              >
                Opening ${safeTitle}
              </h1>

              <p
                style="
                  margin: 0 0 20px;
                  color: #697080;
                "
              >
                Redirecting you to the secure Contriba event page.
              </p>

              <a
                href="${safeEventUrl}"
                style="
                  display: inline-block;
                  padding: 14px 20px;
                  border-radius: 14px;
                  color: white;
                  background: #e50914;
                  font-weight: 800;
                  text-decoration: none;
                "
              >
                Open event
              </a>
            </main>
          </body>
        </html>
      `);
  } catch (error) {
    console.error(
      "Public share page error:",
      error
    );

    return res
      .status(500)
      .set({
        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-store",
      })
      .send(`
        <!doctype html>

        <html lang="en">
          <head>
            <meta charset="utf-8" />

            <title>
              Contriba
            </title>
          </head>

          <body>
            <h1>
              Unable to open this event
            </h1>

            <p>
              Please try again shortly.
            </p>
          </body>
        </html>
      `);
  }
}

module.exports = {
  getPublicSharePage,
};