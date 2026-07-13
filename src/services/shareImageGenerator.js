const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

const BRAND_RED = "#E50914";
const BRAND_RED_DARK = "#B60710";
const TEXT_DARK = "#14151A";
const TEXT_MUTED = "#6B7280";
const SURFACE = "#FFFFFF";
const SURFACE_SOFT = "#F7F7F9";
const BORDER = "#E8E8ED";

const LOGO_PATH = path.join(__dirname, "../assets/logo.png");

function number(value) {
  const parsed = Number(value || 0);

  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, maxLength) {
  const clean = normalizeWhitespace(value);

  if (clean.length <= maxLength) {
    return clean;
  }

  return `${clean
    .slice(0, Math.max(maxLength - 1, 1))
    .trim()}…`;
}

function formatMoney(value) {
  return `RWF ${Math.round(number(value)).toLocaleString("en-US")}`;
}

function formatCategory(value) {
  const clean = normalizeWhitespace(value || "Event");

  return clean
    .split(" ")
    .map((word) => {
      if (!word) return "";

      return `${word.charAt(0).toUpperCase()}${word
        .slice(1)
        .toLowerCase()}`;
    })
    .join(" ");
}

function formatDate(value) {
  if (!value) {
    return "Open for contributions";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Open for contributions";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getOrganizerName(event) {
  return (
    event?.creator?.name ||
    event?.organizer_name ||
    event?.owner_name ||
    event?.created_by_name ||
    "Contriba Organizer"
  );
}

function getRaisedAmount(event) {
  return number(
    event?.total_raised ||
      event?.raised ||
      event?.amount_raised ||
      event?.collected_amount
  );
}

function getGoalAmount(event) {
  return number(
    event?.goal_amount ||
      event?.goal ||
      event?.target ||
      event?.target_amount
  );
}

function getProgress(raised, goal) {
  if (goal <= 0) {
    return 0;
  }

  return clamp(
    Math.round((raised / goal) * 100),
    0,
    100
  );
}

function getCoverUrl(event) {
  return (
    event?.cover_image ||
    event?.photo_url ||
    event?.image_url ||
    event?.photo1_url ||
    null
  );
}

async function readLogoBuffer() {
  try {
    if (!fs.existsSync(LOGO_PATH)) {
      return null;
    }

    return await fs.promises.readFile(LOGO_PATH);
  } catch (error) {
    console.warn(
      "Share image logo could not be loaded:",
      error.message
    );

    return null;
  }
}

async function downloadImage(url) {
  if (!url) {
    return null;
  }

  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 12000,
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
      headers: {
        "User-Agent": "Contriba-Share-Image/1.0",
        Accept: "image/*",
      },
    });

    return Buffer.from(response.data);
  } catch (error) {
    console.warn(
      "Event cover could not be downloaded:",
      error.message
    );

    return null;
  }
}

async function prepareCoverBuffer(sourceBuffer) {
  if (!sourceBuffer) {
    return null;
  }

  try {
    return await sharp(sourceBuffer)
      .rotate()
      .resize(590, CARD_HEIGHT, {
        fit: "cover",
        position: "attention",
      })
      .jpeg({
        quality: 88,
        progressive: true,
        chromaSubsampling: "4:4:4",
      })
      .toBuffer();
  } catch (error) {
    console.warn(
      "Event cover could not be prepared:",
      error.message
    );

    return null;
  }
}

async function prepareLogoBuffer(sourceBuffer) {
  if (!sourceBuffer) {
    return null;
  }

  try {
    return await sharp(sourceBuffer)
      .resize({
        width: 190,
        height: 64,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch (error) {
    console.warn(
      "Contriba logo could not be prepared:",
      error.message
    );

    return null;
  }
}function fallbackCoverSvg(category) {
  const safeCategory = escapeXml(truncate(category, 24));

  return Buffer.from(`
    <svg
      width="590"
      height="${CARD_HEIGHT}"
      viewBox="0 0 590 ${CARD_HEIGHT}"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="fallbackGradient"
          x1="0"
          y1="0"
          x2="1"
          y2="1"
        >
          <stop offset="0%" stop-color="#FF3540" />
          <stop offset="50%" stop-color="${BRAND_RED}" />
          <stop offset="100%" stop-color="#8F0008" />
        </linearGradient>

        <radialGradient
          id="fallbackGlow"
          cx="0.25"
          cy="0.2"
          r="0.9"
        >
          <stop
            offset="0%"
            stop-color="#FFFFFF"
            stop-opacity="0.28"
          />
          <stop
            offset="100%"
            stop-color="#FFFFFF"
            stop-opacity="0"
          />
        </radialGradient>
      </defs>

      <rect
        width="590"
        height="${CARD_HEIGHT}"
        fill="url(#fallbackGradient)"
      />

      <rect
        width="590"
        height="${CARD_HEIGHT}"
        fill="url(#fallbackGlow)"
      />

      <circle
        cx="70"
        cy="80"
        r="210"
        fill="#FFFFFF"
        opacity="0.08"
      />

      <circle
        cx="555"
        cy="570"
        r="230"
        fill="none"
        stroke="#FFFFFF"
        stroke-width="52"
        opacity="0.08"
      />

      <circle
        cx="555"
        cy="570"
        r="145"
        fill="none"
        stroke="#FFFFFF"
        stroke-width="2"
        opacity="0.22"
      />

      <g opacity="0.1">
        <path
          d="M0 420 C160 330, 310 540, 590 360 L590 630 L0 630 Z"
          fill="#4E0004"
        />
      </g>

      <rect
        x="54"
        y="54"
        width="160"
        height="44"
        rx="22"
        fill="#FFFFFF"
        opacity="0.16"
      />

      <text
        x="134"
        y="82"
        text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="17"
        font-weight="700"
        fill="#FFFFFF"
      >
        ${safeCategory}
      </text>

      <text
        x="54"
        y="310"
        font-family="Arial, Helvetica, sans-serif"
        font-size="58"
        font-weight="800"
        fill="#FFFFFF"
      >
        Celebrate.
      </text>

      <text
        x="54"
        y="375"
        font-family="Arial, Helvetica, sans-serif"
        font-size="58"
        font-weight="800"
        fill="#FFFFFF"
      >
        Contribute.
      </text>

      <text
        x="54"
        y="425"
        font-family="Arial, Helvetica, sans-serif"
        font-size="21"
        font-weight="500"
        fill="#FFFFFF"
        opacity="0.8"
      >
        Powered by Contriba
      </text>
    </svg>
  `);
}

function createOverlaySvg({
  title,
  organizer,
  category,
  description,
  location,
  dateLabel,
  raised,
  goal,
  progress,
  hasCover,
}) {
  const safeTitle = escapeXml(truncate(title, 56));
  const safeOrganizer = escapeXml(truncate(organizer, 36));
  const safeCategory = escapeXml(truncate(category, 22));

  const safeDescription = escapeXml(
    truncate(
      description ||
        `Support ${organizer}'s event by contributing securely with Contriba.`,
      94
    )
  );

  const safeLocation = escapeXml(
    truncate(location || "Rwanda", 30)
  );

  const safeDate = escapeXml(dateLabel);

  const progressWidth = Math.round(
    (progress / 100) * 390
  );

  const raisedLabel = escapeXml(
    formatMoney(raised)
  );

  const goalLabel = escapeXml(
    goal > 0
      ? formatMoney(goal)
      : "Open goal"
  );

  return Buffer.from(`
    <svg
      width="${CARD_WIDTH}"
      height="${CARD_HEIGHT}"
      viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="photoShade"
          x1="0"
          y1="0"
          x2="1"
          y2="0"
        >
          <stop
            offset="0%"
            stop-color="#050505"
            stop-opacity="${hasCover ? "0.18" : "0"}"
          />

          <stop
            offset="100%"
            stop-color="#050505"
            stop-opacity="${hasCover ? "0.48" : "0"}"
          />
        </linearGradient>

        <linearGradient
          id="accentGradient"
          x1="0"
          y1="0"
          x2="1"
          y2="0"
        >
          <stop
            offset="0%"
            stop-color="#FF2D38"
          />

          <stop
            offset="58%"
            stop-color="${BRAND_RED}"
          />

          <stop
            offset="100%"
            stop-color="${BRAND_RED_DARK}"
          />
        </linearGradient>

        <linearGradient
          id="rightGlow"
          x1="0"
          y1="0"
          x2="1"
          y2="1"
        >
          <stop
            offset="0%"
            stop-color="#FFFFFF"
          />

          <stop
            offset="100%"
            stop-color="#FFF7F7"
          />
        </linearGradient>

        <filter
          id="softShadow"
          x="-40%"
          y="-40%"
          width="180%"
          height="180%"
        >
          <feDropShadow
            dx="0"
            dy="14"
            stdDeviation="20"
            flood-color="#5F0006"
            flood-opacity="0.13"
          />
        </filter>

        <filter
          id="tinyShadow"
          x="-40%"
          y="-40%"
          width="180%"
          height="180%"
        >
          <feDropShadow
            dx="0"
            dy="5"
            stdDeviation="7"
            flood-color="#000000"
            flood-opacity="0.12"
          />
        </filter>
      </defs>

      <rect
        width="${CARD_WIDTH}"
        height="${CARD_HEIGHT}"
        fill="${SURFACE}"
      />

      <rect
        x="0"
        y="0"
        width="590"
        height="${CARD_HEIGHT}"
        fill="url(#photoShade)"
      />

      <rect
        x="590"
        y="0"
        width="610"
        height="${CARD_HEIGHT}"
        fill="url(#rightGlow)"
      />

      <circle
        cx="1160"
        cy="40"
        r="150"
        fill="${BRAND_RED}"
        opacity="0.035"
      />

      <circle
        cx="1160"
        cy="40"
        r="105"
        fill="none"
        stroke="${BRAND_RED}"
        stroke-width="2"
        opacity="0.075"
      />

      <g opacity="0.055">
        ${Array.from({ length: 6 }, (_, row) =>
          Array.from(
            { length: 6 },
            (_, col) =>
              `<circle
                cx="${920 + col * 33}"
                cy="${60 + row * 33}"
                r="3"
                fill="${BRAND_RED}"
              />`
          ).join("")
        ).join("")}
      </g>

      <rect
        x="38"
        y="36"
        width="188"
        height="46"
        rx="23"
        fill="${BRAND_RED}"
        filter="url(#tinyShadow)"
      />

      <text
        x="132"
        y="65"
        text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="17"
        font-weight="800"
        fill="#FFFFFF"
      >
        ${safeCategory}
      </text>

      <rect
        x="620"
        y="42"
        width="152"
        height="38"
        rx="19"
        fill="#FFF0F1"
      />

      <text
        x="696"
        y="66"
        text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="14"
        font-weight="800"
        fill="${BRAND_RED}"
      >
        EVENT CONTRIBUTION
      </text>

      <text
        x="620"
        y="145"
        font-family="Arial, Helvetica, sans-serif"
        font-size="54"
        font-weight="900"
        fill="${TEXT_DARK}"
      >
        ${safeTitle}
      </text>

      <text
        x="620"
        y="190"
        font-family="Arial, Helvetica, sans-serif"
        font-size="18"
        font-weight="600"
        fill="${TEXT_MUTED}"
      >
        Organized by ${safeOrganizer}
      </text>

      <text
        x="620"
        y="245"
        font-family="Arial, Helvetica, sans-serif"
        font-size="19"
        font-weight="500"
        fill="#3D3F46"
      >
        ${safeDescription}
      </text>      <g
        transform="translate(620 286)"
        filter="url(#softShadow)"
      >
        <rect
          width="520"
          height="155"
          rx="24"
          fill="#FFFFFF"
          stroke="${BORDER}"
        />

        <text
          x="26"
          y="38"
          font-family="Arial, Helvetica, sans-serif"
          font-size="13"
          font-weight="800"
          fill="${BRAND_RED}"
        >
          RAISED
        </text>

        <text
          x="26"
          y="75"
          font-family="Arial, Helvetica, sans-serif"
          font-size="31"
          font-weight="900"
          fill="${TEXT_DARK}"
        >
          ${raisedLabel}
        </text>

        <line
          x1="262"
          y1="24"
          x2="262"
          y2="84"
          stroke="${BORDER}"
          stroke-width="2"
        />

        <text
          x="286"
          y="38"
          font-family="Arial, Helvetica, sans-serif"
          font-size="13"
          font-weight="800"
          fill="${TEXT_MUTED}"
        >
          GOAL
        </text>

        <text
          x="286"
          y="74"
          font-family="Arial, Helvetica, sans-serif"
          font-size="24"
          font-weight="850"
          fill="${TEXT_DARK}"
        >
          ${goalLabel}
        </text>

        <rect
          x="26"
          y="106"
          width="390"
          height="16"
          rx="8"
          fill="#EEEFF2"
        />

        <rect
          x="26"
          y="106"
          width="${progressWidth}"
          height="16"
          rx="8"
          fill="url(#accentGradient)"
        />

        <text
          x="488"
          y="121"
          text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="21"
          font-weight="900"
          fill="${TEXT_DARK}"
        >
          ${progress}%
        </text>
      </g>

      <g transform="translate(620 478)">
        <rect
          width="250"
          height="50"
          rx="16"
          fill="${SURFACE_SOFT}"
          stroke="${BORDER}"
        />

        <circle
          cx="28"
          cy="25"
          r="8"
          fill="${BRAND_RED}"
          opacity="0.16"
        />

        <circle
          cx="28"
          cy="25"
          r="3.5"
          fill="${BRAND_RED}"
        />

        <text
          x="48"
          y="31"
          font-family="Arial, Helvetica, sans-serif"
          font-size="15"
          font-weight="700"
          fill="#404149"
        >
          ${safeLocation}
        </text>
      </g>

      <g transform="translate(888 478)">
        <rect
          width="252"
          height="50"
          rx="16"
          fill="${SURFACE_SOFT}"
          stroke="${BORDER}"
        />

        <rect
          x="20"
          y="17"
          width="16"
          height="16"
          rx="3"
          fill="${BRAND_RED}"
          opacity="0.16"
        />

        <rect
          x="23"
          y="20"
          width="10"
          height="10"
          rx="2"
          fill="${BRAND_RED}"
        />

        <text
          x="48"
          y="31"
          font-family="Arial, Helvetica, sans-serif"
          font-size="15"
          font-weight="700"
          fill="#404149"
        >
          ${safeDate}
        </text>
      </g>

      <rect
        x="590"
        y="558"
        width="610"
        height="72"
        fill="url(#accentGradient)"
      />

      <g transform="translate(620 577)">
        <circle
          cx="18"
          cy="18"
          r="18"
          fill="#FFFFFF"
          opacity="0.16"
        />

        <path
          d="M12 18c0-5 3-8 7-8 3 0 5 2 6 4 1-2 3-4 6-4 4 0 7 3 7 8s-3 8-7 8c-3 0-5-2-6-4-1 2-3 4-6 4-4 0-7-3-7-8Z"
          transform="translate(-7 0) scale(.7)"
          fill="none"
          stroke="#FFFFFF"
          stroke-width="3"
        />

        <text
          x="48"
          y="24"
          font-family="Arial, Helvetica, sans-serif"
          font-size="17"
          font-weight="800"
          fill="#FFFFFF"
        >
          Contribute securely with Contriba
        </text>
      </g>

      <text
        x="1142"
        y="602"
        text-anchor="end"
        font-family="Arial, Helvetica, sans-serif"
        font-size="16"
        font-weight="800"
        fill="#FFFFFF"
      >
        contriba.online
      </text>
    </svg>
  `);
}

function createLogoFallbackSvg() {
  return Buffer.from(`
    <svg
      width="190"
      height="64"
      viewBox="0 0 190 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 32c0-14 9-23 21-23 10 0 17 6 22 14 5-8 12-14 22-14 12 0 21 9 21 23s-9 23-21 23c-10 0-17-6-22-14-5 8-12 14-22 14C17 55 8 46 8 32Z"
        fill="none"
        stroke="${BRAND_RED}"
        stroke-width="10"
      />

      <text
        x="106"
        y="42"
        font-family="Arial, Helvetica, sans-serif"
        font-size="31"
        font-weight="900"
        fill="${TEXT_DARK}"
      >
        contriba
      </text>
    </svg>
  `);
}

async function generateEventShareImage(event) {
  if (!event || !event.id) {
    throw new Error(
      "A valid event is required to generate a share image."
    );
  }

  const title = event.title || "Contriba Event";
  const organizer = getOrganizerName(event);
  const category = formatCategory(
    event.type ||
      event.category ||
      "Event"
  );

  const description = event.description || "";
  const location = event.location || "Rwanda";
  const dateLabel = formatDate(event.date);

  const raised = getRaisedAmount(event);
  const goal = getGoalAmount(event);
  const progress = getProgress(raised, goal);

  const [coverSource, logoSource] = await Promise.all([
    downloadImage(getCoverUrl(event)),
    readLogoBuffer(),
  ]);

  const [preparedCover, preparedLogo] = await Promise.all([
    prepareCoverBuffer(coverSource),
    prepareLogoBuffer(logoSource),
  ]);

  const coverBuffer =
    preparedCover ||
    fallbackCoverSvg(category);

  const logoBuffer =
    preparedLogo ||
    createLogoFallbackSvg();

  const overlaySvg = createOverlaySvg({
    title,
    organizer,
    category,
    description,
    location,
    dateLabel,
    raised,
    goal,
    progress,
    hasCover: Boolean(preparedCover),
  });

  const finalImage = await sharp({
    create: {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      channels: 4,
      background: SURFACE,
    },
  })
    .composite([
      {
        input: coverBuffer,
        left: 0,
        top: 0,
      },
      {
        input: overlaySvg,
        left: 0,
        top: 0,
      },
      {
        input: logoBuffer,
        left: 930,
        top: 91,
      },
    ])
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: false,
    })
    .toBuffer();

  return finalImage;
}

module.exports = {
  CARD_WIDTH,
  CARD_HEIGHT,
  generateEventShareImage,
};