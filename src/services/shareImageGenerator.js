const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");

/*
|--------------------------------------------------------------------------
| Contriba Open Graph Share Card
|--------------------------------------------------------------------------
|
| Final card size:
| 1200 × 630 pixels
|
| Layout:
| - Left panel: event information
| - Right panel: event cover photo
|
*/

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

const INFO_PANEL_WIDTH = 660;
const PHOTO_PANEL_WIDTH =
  CARD_WIDTH - INFO_PANEL_WIDTH;

const BRAND_RED = "#E50914";
const BRAND_RED_DARK = "#B40710";
const BRAND_RED_SOFT = "#FFF0F1";

const WHITE = "#FFFFFF";
const TEXT_DARK = "#17181D";
const TEXT_MUTED = "#667085";
const TEXT_LIGHT = "#98A2B3";
const BORDER = "#E7E9EE";
const PROGRESS_BACKGROUND = "#ECEEF2";

/*
|--------------------------------------------------------------------------
| Logo path
|--------------------------------------------------------------------------
|
| shareImageGenerator.js:
| src/services/shareImageGenerator.js
|
| Logo:
| src/assets/logo.png
|
*/

const LOGO_PATH = path.join(
  __dirname,
  "../assets/logo.png"
);

/*
|--------------------------------------------------------------------------
| Basic helpers
|--------------------------------------------------------------------------
*/

function toNumber(value) {
  const parsed = Number(value || 0);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.min(
    Math.max(value, minimum),
    maximum
  );
}

function cleanText(
  value,
  fallback = ""
) {
  return String(
    value || fallback
  )
    .replace(
      /[^\x20-\x7EÀ-ÿ]/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function escapeXml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(
  value,
  maximumLength
) {
  const text = cleanText(value);

  if (
    text.length <= maximumLength
  ) {
    return text;
  }

  return `${text
    .slice(
      0,
      maximumLength - 3
    )
    .trim()}...`;
}

/*
|--------------------------------------------------------------------------
| Money and progress formatting
|--------------------------------------------------------------------------
*/

function formatMoney(value) {
  const amount = Math.round(
    toNumber(value)
  );

  return `RWF ${amount.toLocaleString(
    "en-US"
  )}`;
}

function formatProgress(value) {
  const progress = clamp(
    toNumber(value),
    0,
    100
  );

  if (progress <= 0) {
    return "0%";
  }

  if (progress < 10) {
    return `${progress.toFixed(1)}%`;
  }

  return `${Math.round(
    progress
  )}%`;
}

/*
|--------------------------------------------------------------------------
| Event information helpers
|--------------------------------------------------------------------------
*/

function formatCategory(value) {
  const category = cleanText(
    value,
    "Event"
  );

  return category
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      const firstLetter =
        word
          .charAt(0)
          .toUpperCase();

      const remainingLetters =
        word
          .slice(1)
          .toLowerCase();

      return (
        firstLetter +
        remainingLetters
      );
    })
    .join(" ");
}

function formatDate(value) {
  if (!value) {
    return "Open date";
  }

  const date = new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "Open date";
  }

  return new Intl.DateTimeFormat(
    "en-GB",
    {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }
  ).format(date);
}

function getOrganizerName(event) {
  return cleanText(
    event?.creator?.name ||
      event?.creator_name ||
      event?.organizer_name ||
      event?.owner_name ||
      event?.user_name ||
      event?.created_by_name,
    "Contriba Organizer"
  );
}

function getRaisedAmount(event) {
  return toNumber(
    event?.total_raised ||
      event?.raised ||
      event?.amount_raised ||
      event?.collected_amount ||
      event?.total_collected ||
      event?.contribution_total
  );
}

function getGoalAmount(event) {
  return toNumber(
    event?.goal_amount ||
      event?.goal ||
      event?.target ||
      event?.target_amount ||
      event?.fundraising_goal
  );
}

function getProgress(
  raised,
  goal
) {
  if (goal <= 0) {
    return 0;
  }

  return clamp(
    (raised / goal) * 100,
    0,
    100
  );
}

function getLocation(event) {
  return cleanText(
    event?.location ||
      event?.venue ||
      event?.city ||
      event?.district ||
      event?.province,
    "Rwanda"
  );
}

function getDescription(
  event,
  organizer
) {
  return truncate(
    event?.description ||
      event?.short_description ||
      event?.summary ||
      `Support ${organizer}'s event securely through Contriba.`,
    108
  );
}

/*
|--------------------------------------------------------------------------
| Image URL helpers
|--------------------------------------------------------------------------
*/

function isValidUrl(value) {
  return (
    typeof value ===
      "string" &&
    /^https?:\/\//i.test(
      value.trim()
    )
  );
}

function extractImageUrl(value) {
  if (!value) {
    return null;
  }

  if (isValidUrl(value)) {
    return value.trim();
  }

  if (
    typeof value ===
      "object"
  ) {
    const nestedUrl =
      value.url ||
      value.image_url ||
      value.photo_url ||
      value.cover_url ||
      value.public_url ||
      value.secure_url ||
      value.src;

    return isValidUrl(
      nestedUrl
    )
      ? nestedUrl.trim()
      : null;
  }

  return null;
}

function getCoverUrl(event) {
  const candidates = [
    event?.cover_image,
    event?.coverImage,
    event?.cover_image_url,
    event?.cover_url,

    event?.photo1_url,
    event?.photo_1_url,
    event?.photo1,
    event?.photo_1,

    event?.image_url,
    event?.image,
    event?.photo_url,
    event?.photo,

    event?.thumbnail_url,
    event?.thumbnail,
    event?.banner_url,
    event?.banner,

    event?.photos?.[0],
    event?.images?.[0],
    event?.event_images?.[0],
    event?.gallery?.[0],
    event?.media?.[0],

    event?.photo2_url,
    event?.photo_2_url,
    event?.photo3_url,
    event?.photo_3_url,
    event?.photo4_url,
    event?.photo_4_url,
  ];

  for (
    const candidate
    of candidates
  ) {
    const url =
      extractImageUrl(
        candidate
      );

    if (url) {
      return url;
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| Title wrapping
|--------------------------------------------------------------------------
*/

function splitTitle(value) {
  const title = truncate(
    value || "Contriba Event",
    62
  );

  if (
    title.length <= 23
  ) {
    return [title];
  }

  const words = title
    .split(" ")
    .filter(Boolean);

  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const candidate =
      currentLine
        ? `${currentLine} ${word}`
        : word;

    if (
      candidate.length <= 25
    ) {
      currentLine =
        candidate;

      continue;
    }

    if (currentLine) {
      lines.push(
        currentLine
      );
    }

    currentLine = word;

    if (
      lines.length === 2
    ) {
      break;
    }
  }

  if (
    currentLine &&
    lines.length < 3
  ) {
    lines.push(
      currentLine
    );
  }

  const usedWordCount =
    lines
      .join(" ")
      .split(" ")
      .filter(Boolean)
      .length;

  if (
    usedWordCount <
      words.length &&
    lines.length > 0
  ) {
    const remainingWords =
      words
        .slice(
          usedWordCount
        )
        .join(" ");

    const lastLineIndex =
      lines.length - 1;

    lines[lastLineIndex] =
      truncate(
        `${lines[lastLineIndex]} ${remainingWords}`,
        28
      );
  }

  return lines.slice(0, 3);
}

/*
|--------------------------------------------------------------------------
| Remote event image download
|--------------------------------------------------------------------------
*/

async function downloadImage(url) {
  if (!url) {
    return null;
  }

  try {
    const response =
      await axios.get(
        url,
        {
          responseType:
            "arraybuffer",

          timeout: 20000,

          maxContentLength:
            25 *
            1024 *
            1024,

          maxBodyLength:
            25 *
            1024 *
            1024,

          headers: {
            "User-Agent":
              "Contriba-Share-Image/7.0",

            Accept:
              "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
        }
      );

    return Buffer.from(
      response.data
    );
  } catch (error) {
    console.warn(
      "Event cover image download failed:",
      error.message
    );

    return null;
  }
}/*
|--------------------------------------------------------------------------
| Prepare the real event photo
|--------------------------------------------------------------------------
|
| The image is resized specifically for the right side of the share card.
| "attention" helps Sharp keep the most important subject visible.
|
*/

async function prepareCoverBuffer(
  sourceBuffer
) {
  if (!sourceBuffer) {
    return null;
  }

  try {
    return await sharp(
      sourceBuffer
    )
      .rotate()
      .resize(
        PHOTO_PANEL_WIDTH,
        CARD_HEIGHT,
        {
          fit: "cover",
          position: "attention",
        }
      )
      .modulate({
        brightness: 1.03,
        saturation: 1.07,
      })
      .sharpen({
        sigma: 0.8,
      })
      .jpeg({
        quality: 94,
        chromaSubsampling:
          "4:4:4",
      })
      .toBuffer();
  } catch (error) {
    console.warn(
      "Event cover image processing failed:",
      error.message
    );

    return null;
  }
}

/*
|--------------------------------------------------------------------------
| Prepare the real Contriba logo
|--------------------------------------------------------------------------
*/

async function prepareLogoBuffer() {
  try {
    if (
      !fs.existsSync(
        LOGO_PATH
      )
    ) {
      console.warn(
        "Contriba logo was not found at:",
        LOGO_PATH
      );

      return null;
    }

    return await sharp(
      LOGO_PATH
    )
      .rotate()
      .trim()
      .resize({
        width: 170,
        height: 58,
        fit: "inside",
        withoutEnlargement:
          true,
      })
      .png()
      .toBuffer();
  } catch (error) {
    console.warn(
      "Contriba logo preparation failed:",
      error.message
    );

    return null;
  }
}

/*
|--------------------------------------------------------------------------
| Fallback photo panel
|--------------------------------------------------------------------------
|
| This is used only when an event does not have a valid photo,
| or when the remote photo cannot be downloaded.
|
*/

function createFallbackPhoto() {
  return Buffer.from(`
<svg
  width="${PHOTO_PANEL_WIDTH}"
  height="${CARD_HEIGHT}"
  viewBox="0 0 ${PHOTO_PANEL_WIDTH} ${CARD_HEIGHT}"
  xmlns="http://www.w3.org/2000/svg"
>

  <defs>

    <linearGradient
      id="fallbackBackground"
      x1="0"
      y1="0"
      x2="1"
      y2="1"
    >
      <stop
        offset="0%"
        stop-color="#FF3C46"
      />

      <stop
        offset="48%"
        stop-color="${BRAND_RED}"
      />

      <stop
        offset="100%"
        stop-color="#8D0008"
      />
    </linearGradient>

    <radialGradient
      id="fallbackGlowOne"
      cx="18%"
      cy="18%"
      r="70%"
    >
      <stop
        offset="0%"
        stop-color="#FFFFFF"
        stop-opacity="0.32"
      />

      <stop
        offset="100%"
        stop-color="#FFFFFF"
        stop-opacity="0"
      />
    </radialGradient>

    <radialGradient
      id="fallbackGlowTwo"
      cx="88%"
      cy="82%"
      r="65%"
    >
      <stop
        offset="0%"
        stop-color="#FF9CA2"
        stop-opacity="0.34"
      />

      <stop
        offset="100%"
        stop-color="#FF9CA2"
        stop-opacity="0"
      />
    </radialGradient>

    <filter
      id="fallbackBlur"
      x="-50%"
      y="-50%"
      width="200%"
      height="200%"
    >
      <feGaussianBlur
        stdDeviation="34"
      />
    </filter>

  </defs>

  <rect
    width="${PHOTO_PANEL_WIDTH}"
    height="${CARD_HEIGHT}"
    fill="url(#fallbackBackground)"
  />

  <rect
    width="${PHOTO_PANEL_WIDTH}"
    height="${CARD_HEIGHT}"
    fill="url(#fallbackGlowOne)"
  />

  <rect
    width="${PHOTO_PANEL_WIDTH}"
    height="${CARD_HEIGHT}"
    fill="url(#fallbackGlowTwo)"
  />

  <circle
    cx="440"
    cy="94"
    r="128"
    fill="#FFFFFF"
    fill-opacity="0.11"
    filter="url(#fallbackBlur)"
  />

  <circle
    cx="112"
    cy="536"
    r="144"
    fill="#FFFFFF"
    fill-opacity="0.08"
    filter="url(#fallbackBlur)"
  />

  <g
    transform="translate(150 200)"
    opacity="0.96"
  >

    <rect
      x="0"
      y="0"
      width="240"
      height="196"
      rx="34"
      fill="#FFFFFF"
      fill-opacity="0.13"
      stroke="#FFFFFF"
      stroke-opacity="0.26"
      stroke-width="2"
    />

    <circle
      cx="120"
      cy="75"
      r="36"
      fill="#FFFFFF"
      fill-opacity="0.92"
    />

    <path
      d="M47 160C61 121 86 105 120 105C154 105 179 121 193 160"
      fill="#FFFFFF"
      fill-opacity="0.92"
    />

  </g>

  <text
    x="${PHOTO_PANEL_WIDTH / 2}"
    y="458"
    text-anchor="middle"
    font-family="Arial, Helvetica, sans-serif"
    font-size="28"
    font-weight="900"
    fill="#FFFFFF"
  >
    Celebrate together
  </text>

  <text
    x="${PHOTO_PANEL_WIDTH / 2}"
    y="494"
    text-anchor="middle"
    font-family="Arial, Helvetica, sans-serif"
    font-size="18"
    font-weight="600"
    fill="#FFFFFF"
    fill-opacity="0.82"
  >
    Powered by Contriba
  </text>

</svg>
`);
}

/*
|--------------------------------------------------------------------------
| Logo fallback
|--------------------------------------------------------------------------
|
| This appears only if src/assets/logo.png is unavailable.
|
*/

function createLogoFallbackSvg() {
  return Buffer.from(`
<svg
  width="170"
  height="58"
  viewBox="0 0 170 58"
  xmlns="http://www.w3.org/2000/svg"
>

  <rect
    x="0"
    y="7"
    width="44"
    height="44"
    rx="14"
    fill="${BRAND_RED}"
  />

  <path
    d="M12 29C12 21 17 16 23 16C30 16 33 22 36 29C33 36 30 42 23 42C17 42 12 37 12 29ZM32 29C35 22 38 16 45 16C51 16 56 21 56 29C56 37 51 42 45 42C38 42 35 36 32 29Z"
    transform="scale(0.73) translate(4 10)"
    fill="none"
    stroke="#FFFFFF"
    stroke-width="5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />

  <text
    x="55"
    y="39"
    font-family="Arial, Helvetica, sans-serif"
    font-size="31"
    font-weight="900"
    letter-spacing="-1"
    fill="${TEXT_DARK}"
  >
    Contriba
  </text>

</svg>
`);
}

/*
|--------------------------------------------------------------------------
| Build the photo-side overlay
|--------------------------------------------------------------------------
|
| This gives the image:
| - a soft dark gradient
| - a clean border between photo and information panel
| - a small secure contribution badge
|
*/

function createPhotoOverlaySvg() {
  return Buffer.from(`
<svg
  width="${PHOTO_PANEL_WIDTH}"
  height="${CARD_HEIGHT}"
  viewBox="0 0 ${PHOTO_PANEL_WIDTH} ${CARD_HEIGHT}"
  xmlns="http://www.w3.org/2000/svg"
>

  <defs>

    <linearGradient
      id="photoDarkOverlay"
      x1="0"
      y1="0"
      x2="0"
      y2="1"
    >
      <stop
        offset="0%"
        stop-color="#000000"
        stop-opacity="0.05"
      />

      <stop
        offset="55%"
        stop-color="#000000"
        stop-opacity="0.02"
      />

      <stop
        offset="100%"
        stop-color="#000000"
        stop-opacity="0.55"
      />
    </linearGradient>

    <linearGradient
      id="photoLeftFade"
      x1="0"
      y1="0"
      x2="1"
      y2="0"
    >
      <stop
        offset="0%"
        stop-color="#000000"
        stop-opacity="0.18"
      />

      <stop
        offset="28%"
        stop-color="#000000"
        stop-opacity="0"
      />
    </linearGradient>

  </defs>

  <rect
    width="${PHOTO_PANEL_WIDTH}"
    height="${CARD_HEIGHT}"
    fill="url(#photoDarkOverlay)"
  />

  <rect
    width="${PHOTO_PANEL_WIDTH}"
    height="${CARD_HEIGHT}"
    fill="url(#photoLeftFade)"
  />

  <line
    x1="1"
    y1="0"
    x2="1"
    y2="${CARD_HEIGHT}"
    stroke="#FFFFFF"
    stroke-opacity="0.28"
    stroke-width="2"
  />

  <g
    transform="translate(34 536)"
  >

    <rect
      x="0"
      y="0"
      width="242"
      height="54"
      rx="27"
      fill="#FFFFFF"
      fill-opacity="0.94"
    />

    <circle
      cx="28"
      cy="27"
      r="16"
      fill="${BRAND_RED_SOFT}"
    />

    <path
      d="M22 27L26 31L34 22"
      fill="none"
      stroke="${BRAND_RED}"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />

    <text
      x="54"
      y="34"
      font-family="Arial, Helvetica, sans-serif"
      font-size="17"
      font-weight="800"
      fill="${TEXT_DARK}"
    >
      Secure contribution
    </text>

  </g>

</svg>
`);
}

/*
|--------------------------------------------------------------------------
| Build the main information panel
|--------------------------------------------------------------------------
*/

function createInformationPanelSvg(
  data
) {
  const {
    title,
    organizer,
    description,
    category,
    raised,
    goal,
    progress,
    dateLabel,
    location,
  } = data;

  const titleLines =
    splitTitle(title);

  const titleLineOne =
    escapeXml(
      titleLines[0] || ""
    );

  const titleLineTwo =
    escapeXml(
      titleLines[1] || ""
    );

  const titleLineThree =
    escapeXml(
      titleLines[2] || ""
    );

  const raisedLabel =
    escapeXml(
      formatMoney(raised)
    );

  const goalLabel =
    escapeXml(
      goal > 0
        ? formatMoney(goal)
        : "Open Goal"
    );

  const progressLabel =
    escapeXml(
      formatProgress(progress)
    );

  const progressTrackWidth =
    526;

  const progressFillWidth =
    progress <= 0
      ? 0
      : Math.max(
          12,
          Math.round(
            (
              clamp(
                progress,
                0,
                100
              ) /
              100
            ) *
              progressTrackWidth
          )
        );

  const categoryText =
    escapeXml(
      category
    ).toUpperCase();

  const categoryWidth =
    Math.max(
      130,
      Math.min(
        240,
        cleanText(
          category
        ).length *
          12 +
          44
      )
    );

  const hasThreeTitleLines =
    Boolean(
      titleLineThree
    );

  const hasTwoTitleLines =
    Boolean(
      titleLineTwo
    );

  const titleFontSize =
    hasThreeTitleLines
      ? 48
      : hasTwoTitleLines
        ? 53
        : 58;

  const titleStartY =
    156;

  const titleLineGap =
    hasThreeTitleLines
      ? 53
      : 58;

  const organizerY =
    titleStartY +
    (
      titleLines.length - 1
    ) *
      titleLineGap +
    48;

  const descriptionY =
    organizerY + 42;

  return Buffer.from(`
<svg
  width="${INFO_PANEL_WIDTH}"
  height="${CARD_HEIGHT}"
  viewBox="0 0 ${INFO_PANEL_WIDTH} ${CARD_HEIGHT}"
  xmlns="http://www.w3.org/2000/svg"
>

  <defs>

    <linearGradient
      id="panelBackground"
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
        stop-color="#FAFAFB"
      />
    </linearGradient>

    <linearGradient
      id="progressGradient"
      x1="0"
      y1="0"
      x2="1"
      y2="0"
    >
      <stop
        offset="0%"
        stop-color="#FF3A45"
      />

      <stop
        offset="100%"
        stop-color="${BRAND_RED_DARK}"
      />
    </linearGradient>

    <radialGradient
      id="panelGlow"
      cx="0%"
      cy="0%"
      r="100%"
    >
      <stop
        offset="0%"
        stop-color="${BRAND_RED}"
        stop-opacity="0.055"
      />

      <stop
        offset="100%"
        stop-color="${BRAND_RED}"
        stop-opacity="0"
      />
    </radialGradient>

  </defs>

  <rect
    width="${INFO_PANEL_WIDTH}"
    height="${CARD_HEIGHT}"
    fill="url(#panelBackground)"
  />

  <rect
    width="${INFO_PANEL_WIDTH}"
    height="${CARD_HEIGHT}"
    fill="url(#panelGlow)"
  />

  <rect
    x="52"
    y="46"
    width="${categoryWidth}"
    height="42"
    rx="21"
    fill="${BRAND_RED_SOFT}"
  />

  <circle
    cx="75"
    cy="67"
    r="6"
    fill="${BRAND_RED}"
  />

  <text
    x="92"
    y="73"
    font-family="Arial, Helvetica, sans-serif"
    font-size="16"
    font-weight="900"
    letter-spacing="1.1"
    fill="${BRAND_RED}"
  >
    ${categoryText}
  </text>

  <text
    x="52"
    y="${titleStartY}"
    font-family="Arial, Helvetica, sans-serif"
    font-size="${titleFontSize}"
    font-weight="900"
    letter-spacing="-2"
    fill="${TEXT_DARK}"
  >
    ${titleLineOne}
  </text>

  ${
    titleLineTwo
      ? `
  <text
    x="52"
    y="${
      titleStartY +
      titleLineGap
    }"
    font-family="Arial, Helvetica, sans-serif"
    font-size="${titleFontSize}"
    font-weight="900"
    letter-spacing="-2"
    fill="${TEXT_DARK}"
  >
    ${titleLineTwo}
  </text>
  `
      : ""
  }

  ${
    titleLineThree
      ? `
  <text
    x="52"
    y="${
      titleStartY +
      titleLineGap * 2
    }"
    font-family="Arial, Helvetica, sans-serif"
    font-size="${titleFontSize}"
    font-weight="900"
    letter-spacing="-2"
    fill="${TEXT_DARK}"
  >
    ${titleLineThree}
  </text>
  `
      : ""
  }

  <text
    x="52"
    y="${organizerY}"
    font-family="Arial, Helvetica, sans-serif"
    font-size="19"
    font-weight="700"
    fill="${TEXT_MUTED}"
  >
    Organized by ${escapeXml(
      truncate(
        organizer,
        38
      )
    )}
  </text>

  <text
    x="52"
    y="${descriptionY}"
    font-family="Arial, Helvetica, sans-serif"
    font-size="17"
    font-weight="500"
    fill="${TEXT_MUTED}"
  >
    ${escapeXml(
      truncate(
        description,
        68
      )
    )}
  </text>

  <line
    x1="52"
    y1="390"
    x2="608"
    y2="390"
    stroke="${BORDER}"
    stroke-width="2"
  />

  <text
    x="52"
    y="428"
    font-family="Arial, Helvetica, sans-serif"
    font-size="14"
    font-weight="900"
    letter-spacing="1.2"
    fill="${TEXT_LIGHT}"
  >
    AMOUNT RAISED
  </text>

  <text
    x="52"
    y="472"
    font-family="Arial, Helvetica, sans-serif"
    font-size="35"
    font-weight="900"
    letter-spacing="-1"
    fill="${TEXT_DARK}"
  >
    ${raisedLabel}
  </text>

  <text
    x="608"
    y="430"
    text-anchor="end"
    font-family="Arial, Helvetica, sans-serif"
    font-size="14"
    font-weight="900"
    letter-spacing="1.1"
    fill="${TEXT_LIGHT}"
  >
    PROGRESS
  </text>

  <text
    x="608"
    y="472"
    text-anchor="end"
    font-family="Arial, Helvetica, sans-serif"
    font-size="34"
    font-weight="900"
    fill="${BRAND_RED}"
  >
    ${progressLabel}
  </text>

  <rect
    x="52"
    y="497"
    width="${progressTrackWidth}"
    height="12"
    rx="6"
    fill="${PROGRESS_BACKGROUND}"
  />

  ${
    progressFillWidth > 0
      ? `
  <rect
    x="52"
    y="497"
    width="${progressFillWidth}"
    height="12"
    rx="6"
    fill="url(#progressGradient)"
  />
  `
      : ""
  }

  <text
    x="52"
    y="539"
    font-family="Arial, Helvetica, sans-serif"
    font-size="16"
    font-weight="700"
    fill="${TEXT_MUTED}"
  >
    Goal: ${goalLabel}
  </text>

  <circle
    cx="58"
    cy="580"
    r="7"
    fill="${BRAND_RED}"
  />

  <text
    x="76"
    y="586"
    font-family="Arial, Helvetica, sans-serif"
    font-size="16"
    font-weight="700"
    fill="${TEXT_DARK}"
  >
    ${escapeXml(
      dateLabel
    )}
  </text>

  <path
    d="M308 570C301 570 296 575 296 582C296 591 308 603 308 603C308 603 320 591 320 582C320 575 315 570 308 570ZM308 586C305 586 303 584 303 581C303 578 305 576 308 576C311 576 313 578 313 581C313 584 311 586 308 586Z"
    fill="${BRAND_RED}"
  />

  <text
    x="330"
    y="586"
    font-family="Arial, Helvetica, sans-serif"
    font-size="16"
    font-weight="700"
    fill="${TEXT_DARK}"
  >
    ${escapeXml(
      truncate(
        location,
        27
      )
    )}
  </text>

</svg>
`);
}/*
|--------------------------------------------------------------------------
| Generate final Contriba event share image
|--------------------------------------------------------------------------
*/

async function generateEventShareImage(
  event
) {
  if (
    !event ||
    !event.id
  ) {
    throw new Error(
      "A valid event is required to generate a share image."
    );
  }

  const title = cleanText(
    event.title ||
      event.name,
    "Contriba Event"
  );

  const organizer =
    getOrganizerName(
      event
    );

  const description =
    getDescription(
      event,
      organizer
    );

  const category =
    formatCategory(
      event.type ||
        event.category ||
        event.event_type ||
        "Event"
    );

  const raised =
    getRaisedAmount(
      event
    );

  const goal =
    getGoalAmount(
      event
    );

  const progress =
    getProgress(
      raised,
      goal
    );

  const dateLabel =
    formatDate(
      event.date ||
        event.event_date ||
        event.start_date ||
        event.starts_at
    );

  const location =
    getLocation(
      event
    );

  const coverUrl =
    getCoverUrl(
      event
    );

  /*
  |--------------------------------------------------------------------------
  | Load the photo and logo together
  |--------------------------------------------------------------------------
  */

  const [
    coverSourceBuffer,
    logoBuffer,
  ] = await Promise.all([
    downloadImage(
      coverUrl
    ),
    prepareLogoBuffer(),
  ]);

  /*
  |--------------------------------------------------------------------------
  | Prepare the right-side event photo
  |--------------------------------------------------------------------------
  */

  const preparedCoverBuffer =
    await prepareCoverBuffer(
      coverSourceBuffer
    );

  const finalPhotoBuffer =
    preparedCoverBuffer ||
    createFallbackPhoto();

  /*
  |--------------------------------------------------------------------------
  | Prepare the information and image overlays
  |--------------------------------------------------------------------------
  */

  const informationPanelBuffer =
    createInformationPanelSvg({
      title,
      organizer,
      description,
      category,
      raised,
      goal,
      progress,
      dateLabel,
      location,
    });

  const photoOverlayBuffer =
    createPhotoOverlaySvg();

  const finalLogoBuffer =
    logoBuffer ||
    createLogoFallbackSvg();

  /*
  |--------------------------------------------------------------------------
  | Create final 1200 × 630 Open Graph image
  |--------------------------------------------------------------------------
  */

  try {
    return await sharp({
      create: {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        channels: 4,
        background: WHITE,
      },
    })
      .composite([
        /*
        |--------------------------------------------------------------------------
        | Left information panel
        |--------------------------------------------------------------------------
        */

        {
          input:
            informationPanelBuffer,
          left: 0,
          top: 0,
        },

        /*
        |--------------------------------------------------------------------------
        | Right event photo
        |--------------------------------------------------------------------------
        */

        {
          input:
            finalPhotoBuffer,
          left:
            INFO_PANEL_WIDTH,
          top: 0,
        },

        /*
        |--------------------------------------------------------------------------
        | Photo dark overlay and badge
        |--------------------------------------------------------------------------
        */

        {
          input:
            photoOverlayBuffer,
          left:
            INFO_PANEL_WIDTH,
          top: 0,
        },

        /*
        |--------------------------------------------------------------------------
        | Contriba logo
        |--------------------------------------------------------------------------
        |
        | The logo sits in the upper-right corner over the event image.
        |
        */

        {
          input:
            finalLogoBuffer,
          left:
            CARD_WIDTH - 204,
          top: 34,
        },
      ])
      .png({
        compressionLevel: 9,
        adaptiveFiltering:
          true,
        palette: false,
      })
      .toBuffer();
  } catch (error) {
    console.error(
      "Contriba share image generation failed:",
      error
    );

    throw new Error(
      `Failed to generate the event share image: ${error.message}`
    );
  }
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
  CARD_WIDTH,
  CARD_HEIGHT,
  generateEventShareImage,
};