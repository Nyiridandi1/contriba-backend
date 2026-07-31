const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const supabase = require("../config/database");

const router = express.Router();

/* =========================================================
   DEEP IMAGE EMBEDDING PROTECTION

   Transformers.js is ESM-only, while this backend uses CommonJS.
   We load it lazily with import() and keep one model instance
   in memory for all later uploads.

   The first protected upload after a fresh deployment can take
   longer because Railway may need to download/cache the model.
========================================================= */

const EMBEDDING_MODEL = "Xenova/clip-vit-base-patch32";
const EMBEDDING_FULL_THRESHOLD = 0.94;
const EMBEDDING_REGION_THRESHOLD = 0.93;
const EMBEDDING_VERY_STRONG_THRESHOLD = 0.965;

let embeddingPipelinePromise = null;

async function getEmbeddingPipeline() {
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");

      console.log(
        `Loading Contriba image-security model: ${EMBEDDING_MODEL}`
      );

      const extractor = await pipeline(
        "image-feature-extraction",
        EMBEDDING_MODEL,
        {
          dtype: "q8",
        }
      );

      console.log("Contriba image-security model ready.");

      return extractor;
    })().catch((error) => {
      embeddingPipelinePromise = null;
      throw error;
    });
  }

  return embeddingPipelinePromise;
}

function l2Normalize(values) {
  const array = Array.from(values || [], Number);

  let sumSquares = 0;

  for (const value of array) {
    sumSquares += value * value;
  }

  const magnitude = Math.sqrt(sumSquares);

  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return [];
  }

  return array.map((value) => value / magnitude);
}

function cosineSimilarity(vectorA, vectorB) {
  if (
    !Array.isArray(vectorA) ||
    !Array.isArray(vectorB) ||
    vectorA.length === 0 ||
    vectorA.length !== vectorB.length
  ) {
    return -1;
  }

  let dot = 0;

  for (let i = 0; i < vectorA.length; i += 1) {
    dot += Number(vectorA[i]) * Number(vectorB[i]);
  }

  return dot;
}

async function bufferToRawImage(buffer) {
  const { RawImage } = await import(
    "@huggingface/transformers"
  );

  const blob = new Blob(
    [buffer],
    { type: "image/jpeg" }
  );

  return RawImage.fromBlob(blob);
}

async function createDeepEmbedding(buffer) {
  const extractor = await getEmbeddingPipeline();
  const rawImage = await bufferToRawImage(buffer);

  const output = await extractor(rawImage);

  return l2Normalize(output.data);
}

/*
  Build meaningful multi-scale crops for the deep model.

  We intentionally do not create dozens of CLIP embeddings per image:
  that would make every upload extremely slow and expensive.

  These regions provide strong coverage for screenshots and crops:
  - full image
  - center 75%
  - four overlapping 62.5% quadrants
  - nine overlapping 50% tiles
*/
async function buildEmbeddingRegions(normalizedBuffer) {
  const regions = [
    {
      name: "center_384",
      left: 64,
      top: 64,
      width: 384,
      height: 384,
    },

    {
      name: "q1_320",
      left: 0,
      top: 0,
      width: 320,
      height: 320,
    },
    {
      name: "q2_320",
      left: 192,
      top: 0,
      width: 320,
      height: 320,
    },
    {
      name: "q3_320",
      left: 0,
      top: 192,
      width: 320,
      height: 320,
    },
    {
      name: "q4_320",
      left: 192,
      top: 192,
      width: 320,
      height: 320,
    },
  ];

  const tilePositions = [0, 128, 256];

  for (const top of tilePositions) {
    for (const left of tilePositions) {
      regions.push({
        name: `tile_256_${left}_${top}`,
        left,
        top,
        width: 256,
        height: 256,
      });
    }
  }

  const output = [];

  for (const region of regions) {
    const regionBuffer = await sharp(normalizedBuffer)
      .extract({
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
      })
      .jpeg({
        quality: 90,
        chromaSubsampling: "4:4:4",
      })
      .toBuffer();

    const embedding = await createDeepEmbedding(
      regionBuffer
    );

    output.push({
      name: region.name,
      embedding,
    });
  }

  return output;
}

async function createDeepImageFingerprint(
  normalizedBuffer
) {
  const full = await createDeepEmbedding(
    normalizedBuffer
  );

  const regions = await buildEmbeddingRegions(
    normalizedBuffer
  );

  return {
    model: EMBEDDING_MODEL,
    full,
    regions,
  };
}

function normalizeStoredEmbedding(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    return value;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  return null;
}

function findDeepEmbeddingMatch(
  newEmbedding,
  storedEmbedding
) {
  if (
    !newEmbedding ||
    !storedEmbedding ||
    newEmbedding.model !== storedEmbedding.model
  ) {
    return {
      matched: false,
      score: -1,
      reason: null,
    };
  }

  const fullScore = cosineSimilarity(
    newEmbedding.full,
    storedEmbedding.full
  );

  if (fullScore >= EMBEDDING_FULL_THRESHOLD) {
    return {
      matched: true,
      score: fullScore,
      reason: "deep_full",
    };
  }

  const newRegions = Array.isArray(
    newEmbedding.regions
  )
    ? newEmbedding.regions
    : [];

  const storedRegions = Array.isArray(
    storedEmbedding.regions
  )
    ? storedEmbedding.regions
    : [];

  let bestScore = fullScore;
  let strongRegionMatches = 0;

  /*
    A crop uploaded as a complete new image can closely resemble
    one stored region, so compare full <-> region in both directions.
  */
  for (const storedRegion of storedRegions) {
    const score = cosineSimilarity(
      newEmbedding.full,
      storedRegion.embedding
    );

    bestScore = Math.max(bestScore, score);

    if (score >= EMBEDDING_VERY_STRONG_THRESHOLD) {
      return {
        matched: true,
        score,
        reason: "deep_crop",
      };
    }

    if (score >= EMBEDDING_REGION_THRESHOLD) {
      strongRegionMatches += 1;
    }
  }

  for (const newRegion of newRegions) {
    const score = cosineSimilarity(
      newRegion.embedding,
      storedEmbedding.full
    );

    bestScore = Math.max(bestScore, score);

    if (score >= EMBEDDING_VERY_STRONG_THRESHOLD) {
      return {
        matched: true,
        score,
        reason: "deep_crop",
      };
    }

    if (score >= EMBEDDING_REGION_THRESHOLD) {
      strongRegionMatches += 1;
    }
  }

  /*
    Region-to-region comparison catches screenshots and arbitrary crops.

    One extremely strong match blocks immediately.
    Otherwise we require at least two strong matches to reduce
    false positives between merely similar-looking photos.
  */
  for (const newRegion of newRegions) {
    for (const storedRegion of storedRegions) {
      const score = cosineSimilarity(
        newRegion.embedding,
        storedRegion.embedding
      );

      bestScore = Math.max(bestScore, score);

      if (score >= EMBEDDING_VERY_STRONG_THRESHOLD) {
        return {
          matched: true,
          score,
          reason: "deep_partial",
        };
      }

      if (score >= EMBEDDING_REGION_THRESHOLD) {
        strongRegionMatches += 1;

        if (strongRegionMatches >= 2) {
          return {
            matched: true,
            score: bestScore,
            reason: "deep_partial",
          };
        }
      }
    }
  }

  return {
    matched: false,
    score: bestScore,
    reason: null,
  };
}


/* =========================================================
   MULTER
========================================================= */

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/jpg",
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(
        new Error("Only JPG, PNG and WEBP images are allowed.")
      );
    }

    cb(null, true);
  },
});

/* =========================================================
   AUTH
========================================================= */

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Please login again.",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Session expired. Please login again.",
    });
  }
}

/* =========================================================
   FILE HELPERS
========================================================= */

function getSafeExtension(fileName) {
  const ext =
    path.extname(fileName || "") || ".jpg";

  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
  ].includes(ext.toLowerCase())
    ? ext.toLowerCase()
    : ".jpg";
}

async function uploadToStorage(
  file,
  fileName
) {
  const { error: uploadError } =
    await supabase.storage
      .from("event-photos")
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

  if (uploadError) {
    throw uploadError;
  }

  const { data } = supabase.storage
    .from("event-photos")
    .getPublicUrl(fileName);

  return data.publicUrl;
}

async function removeUploadedFile(fileName) {
  try {
    const { error } =
      await supabase.storage
        .from("event-photos")
        .remove([fileName]);

    if (error) {
      console.error(
        "Photo cleanup error:",
        error.message
      );
    }
  } catch (error) {
    console.error(
      "Photo cleanup error:",
      error.message
    );
  }
}

/* =========================================================
   EXACT IMAGE HASH
========================================================= */

function sha256(buffer) {
  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");
}

/* =========================================================
   HASH UTILITIES
========================================================= */

function bitsToHex(bits) {
  let hex = "";

  for (
    let i = 0;
    i < bits.length;
    i += 4
  ) {
    const chunk = bits
      .slice(i, i + 4)
      .padEnd(4, "0");

    hex += parseInt(chunk, 2)
      .toString(16);
  }

  return hex;
}

/* =========================================================
   PERCEPTUAL AVERAGE HASH
========================================================= */

async function averageHash(buffer) {
  const pixels = await sharp(buffer)
    .rotate()
    .resize(8, 8, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .grayscale()
    .raw()
    .toBuffer();

  const values = Array.from(pixels);

  const average =
    values.reduce(
      (sum, value) => sum + value,
      0
    ) / values.length;

  const bits = values
    .map((value) =>
      value >= average ? "1" : "0"
    )
    .join("");

  return bitsToHex(bits);
}

/* =========================================================
   DIFFERENCE HASH
========================================================= */

async function differenceHash(buffer) {
  const pixels = await sharp(buffer)
    .rotate()
    .resize(9, 8, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .grayscale()
    .raw()
    .toBuffer();

  const values = Array.from(pixels);

  let bits = "";

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left =
        values[y * 9 + x];

      const right =
        values[y * 9 + x + 1];

      bits +=
        left > right ? "1" : "0";
    }
  }

  return bitsToHex(bits);
}

/* =========================================================
   NORMALIZE IMAGE

   This helps make the comparison resistant to:
   - resizing
   - recompression
   - JPEG quality changes
   - PNG/JPEG conversion
========================================================= */

async function createNormalizedImage(
  buffer
) {
  return sharp(buffer)
    .rotate()
    .resize(512, 512, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .jpeg({
      quality: 90,
      chromaSubsampling: "4:4:4",
    })
    .toBuffer();
}

/* =========================================================
   CREATE PERCEPTUAL HASH PAIR
========================================================= */

async function buildPerceptualPair(
  buffer
) {
  const [ahash, dhash] =
    await Promise.all([
      averageHash(buffer),
      differenceHash(buffer),
    ]);

  return {
    ahash,
    dhash,
  };
}

/* =========================================================
   REGIONAL / CROP HASHES

   We fingerprint multiple sections of the photo.

   This helps detect cases where someone:
   - crops the photo
   - removes the borders
   - zooms into the photo
   - slightly changes framing
========================================================= */

async function buildRegionHashes(
  normalizedBuffer
) {
  /*
    Dense multi-scale overlapping crop fingerprints.

    This is stronger than the old five-region system because it
    fingerprints many overlapping windows across the whole image.
  */

  const windowSizes = [384, 320, 256, 192, 160];
  const hashes = [];

  for (const size of windowSizes) {
    const step = Math.max(64, Math.floor(size / 2));
    const positions = [];

    for (let pos = 0; pos <= 512 - size; pos += step) {
      positions.push(pos);
    }

    const last = 512 - size;

    if (!positions.includes(last)) {
      positions.push(last);
    }

    for (const top of positions) {
      for (const left of positions) {
        const regionBuffer = await sharp(normalizedBuffer)
          .extract({
            left,
            top,
            width: size,
            height: size,
          })
          .toBuffer();

        const pair = await buildPerceptualPair(regionBuffer);

        hashes.push({
          name: `tile_${size}_${left}_${top}`,
          size,
          left,
          top,
          ...pair,
        });
      }
    }
  }

  return hashes;
}

/* =========================================================
   COMPLETE IMAGE FINGERPRINT
========================================================= */

async function createImageFingerprint(
  buffer
) {
  const normalizedBuffer =
    await createNormalizedImage(buffer);

  /*
    Run the cheap classical fingerprints first, while the deep
    embedding system performs its stronger visual analysis.

    The deep fingerprint contains:
    - full-image CLIP embedding
    - multiple crop-region CLIP embeddings
  */
  const [
    fullPair,
    regionHashes,
    imageEmbedding,
  ] = await Promise.all([
    buildPerceptualPair(
      normalizedBuffer
    ),

    buildRegionHashes(
      normalizedBuffer
    ),

    createDeepImageFingerprint(
      normalizedBuffer
    ),
  ]);

  return {
    sha256_hash: sha256(buffer),

    visual_hash:
      JSON.stringify(fullPair),

    region_hashes:
      regionHashes,

    image_embedding:
      imageEmbedding,

    fullPair,
  };
}

/* =========================================================
   READ STORED HASH
========================================================= */

function safeParseVisualHash(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeStoredRegions(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed =
        JSON.parse(value);

      return Array.isArray(parsed)
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

/* =========================================================
   HAMMING DISTANCE
========================================================= */

const BIT_COUNTS = [
  0, 1, 1, 2,
  1, 2, 2, 3,
  1, 2, 2, 3,
  2, 3, 3, 4,
];

function hammingDistanceHex(
  hashA,
  hashB
) {
  if (
    !hashA ||
    !hashB ||
    typeof hashA !== "string" ||
    typeof hashB !== "string" ||
    hashA.length !== hashB.length
  ) {
    return Number.POSITIVE_INFINITY;
  }

  let distance = 0;

  for (
    let i = 0;
    i < hashA.length;
    i += 1
  ) {
    const valueA =
      parseInt(hashA[i], 16);

    const valueB =
      parseInt(hashB[i], 16);

    if (
      Number.isNaN(valueA) ||
      Number.isNaN(valueB)
    ) {
      return Number.POSITIVE_INFINITY;
    }

    distance +=
      BIT_COUNTS[valueA ^ valueB];
  }

  return distance;
}

/* =========================================================
   SIMILARITY RULES
========================================================= */

function isStrongFullMatch(
  pairA,
  pairB
) {
  if (!pairA || !pairB) {
    return false;
  }

  const aDistance =
    hammingDistanceHex(
      pairA.ahash,
      pairB.ahash
    );

  const dDistance =
    hammingDistanceHex(
      pairA.dhash,
      pairB.dhash
    );

  /*
    Both hashes must agree.

    Lower distance = more similar.

    We deliberately keep automatic
    blocking conservative to reduce
    false positives.
  */

  return (
    aDistance <= 6 &&
    dDistance <= 8
  );
}

function isStrongRegionMatch(
  pairA,
  pairB
) {
  if (!pairA || !pairB) {
    return false;
  }

  const aDistance =
    hammingDistanceHex(
      pairA.ahash,
      pairB.ahash
    );

  const dDistance =
    hammingDistanceHex(
      pairA.dhash,
      pairB.dhash
    );

  return (
    aDistance <= 3 &&
    dDistance <= 5
  );
}

/* =========================================================
   LOAD OTHER ORGANIZERS' FINGERPRINTS

   IMPORTANT:
   We exclude the current organizer.

   This means an organizer can reuse
   their own event image.

   Another organizer cannot reuse a
   strongly matching protected image.
========================================================= */

async function getFingerprintsFromOtherOwners(
  ownerId
) {
  const pageSize = 500;

  let from = 0;

  const fingerprints = [];

  while (true) {
    const { data, error } =
      await supabase
        .from(
          "event_image_fingerprints"
        )
        .select(`
          id,
          owner_id,
          event_id,
          image_url,
          sha256_hash,
          visual_hash,
          region_hashes,
          image_embedding,
          created_at
        `)
        .neq(
          "owner_id",
          ownerId
        )
        .range(
          from,
          from + pageSize - 1
        );

    if (error) {
      throw error;
    }

    fingerprints.push(
      ...(data || [])
    );

    if (
      !data ||
      data.length < pageSize
    ) {
      break;
    }

    from += pageSize;
  }

  return fingerprints;
}

function countRegionMatches(
  newRegions,
  storedRegions
) {
  let matches = 0;

  for (const newRegion of newRegions) {
    for (const storedRegion of storedRegions) {
      if (
        isStrongRegionMatch(
          newRegion,
          storedRegion
        )
      ) {
        matches += 1;

        if (matches >= 2) {
          return matches;
        }
      }
    }
  }

  return matches;
}

/* =========================================================
   FIND MATCH
========================================================= */

function findProtectedImageMatch(
  newFingerprint,
  existingFingerprints
) {
  for (
    const existing
    of existingFingerprints
  ) {
    /* ---------------------------------
       1. EXACT FILE MATCH
    --------------------------------- */

    if (
      existing.sha256_hash &&
      existing.sha256_hash ===
        newFingerprint.sha256_hash
    ) {
      return {
        matched: true,
        reason: "exact",
        fingerprintId:
          existing.id,
      };
    }

    const storedFull =
      safeParseVisualHash(
        existing.visual_hash
      );

    /* ---------------------------------
       2. FULL IMAGE PERCEPTUAL MATCH
    --------------------------------- */

    if (
      isStrongFullMatch(
        newFingerprint.fullPair,
        storedFull
      )
    ) {
      return {
        matched: true,
        reason: "perceptual",
        fingerprintId:
          existing.id,
      };
    }

    /* ---------------------------------
       3. DEEP VISUAL EMBEDDING MATCH

       This layer is designed for:
       - screenshots
       - arbitrary crops
       - resize/recompression
       - mild visual edits

       Older fingerprint records created before this feature may
       not have image_embedding yet. Those safely fall back to
       the classical protection below.
    --------------------------------- */

    const storedDeepEmbedding =
      normalizeStoredEmbedding(
        existing.image_embedding
      );

    if (
      newFingerprint.image_embedding &&
      storedDeepEmbedding
    ) {
      const deepMatch =
        findDeepEmbeddingMatch(
          newFingerprint.image_embedding,
          storedDeepEmbedding
        );

      if (deepMatch.matched) {
        return {
          matched: true,
          reason: deepMatch.reason,
          similarity:
            deepMatch.score,
          fingerprintId:
            existing.id,
        };
      }
    }

    const storedRegions =
      normalizeStoredRegions(
        existing.region_hashes
      );

    const newRegions =
      newFingerprint.region_hashes ||
      [];

    /* ---------------------------------
       3. NEW PHOTO MAY BE A CROP
          OF EXISTING PHOTO
    --------------------------------- */

    for (
      const storedRegion
      of storedRegions
    ) {
      if (
        isStrongRegionMatch(
          newFingerprint.fullPair,
          storedRegion
        )
      ) {
        return {
          matched: true,
          reason: "cropped",
          fingerprintId:
            existing.id,
        };
      }
    }

    /* ---------------------------------
       4. EXISTING PHOTO MAY BE A CROP
          OF NEW PHOTO
    --------------------------------- */

    for (
      const newRegion
      of newRegions
    ) {
      if (
        isStrongRegionMatch(
          newRegion,
          storedFull
        )
      ) {
        return {
          matched: true,
          reason: "cropped",
          fingerprintId:
            existing.id,
        };
      }
    }

    /* ---------------------------------
       5. DENSE REGION-TO-REGION MATCH
    --------------------------------- */

    const corroboratingMatches =
      countRegionMatches(
        newRegions,
        storedRegions
      );

    if (corroboratingMatches >= 2) {
      return {
        matched: true,
        reason: "cropped_partial",
        fingerprintId:
          existing.id,
      };
    }
  }

  return {
    matched: false,
    reason: null,
    fingerprintId: null,
  };
}

/* =========================================================
   EVENT PHOTO PROTECTION
========================================================= */

async function protectEventPhoto(
  ownerId,
  buffer
) {
  const fingerprint =
    await createImageFingerprint(
      buffer
    );

  const otherOwnerFingerprints =
    await getFingerprintsFromOtherOwners(
      ownerId
    );

  const match =
    findProtectedImageMatch(
      fingerprint,
      otherOwnerFingerprints
    );

  return {
    fingerprint,
    match,
  };
}

/* =========================================================
   SAVE FINGERPRINT
========================================================= */

async function saveImageFingerprint({
  ownerId,
  imageUrl,
  fingerprint,
}) {
  const { error } =
    await supabase
      .from(
        "event_image_fingerprints"
      )
      .insert({
        owner_id: ownerId,

        /*
          Event does not necessarily
          exist yet during photo upload.

          We can connect event_id later
          when the event is created.
        */

        event_id: null,

        image_url: imageUrl,

        sha256_hash:
          fingerprint.sha256_hash,

        visual_hash:
          fingerprint.visual_hash,

        region_hashes:
          fingerprint.region_hashes,

        image_embedding:
          fingerprint.image_embedding,
      });

  if (error) {
    throw error;
  }
}

/* =========================================================
   PROFILE AVATAR UPLOAD

   We intentionally DO NOT run event
   impersonation protection here.
========================================================= */

router.post(
  "/avatar",
  verifyToken,
  upload.single("avatar"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please choose a photo.",
        });
      }

      const safeExt =
        getSafeExtension(
          req.file.originalname
        );

      const fileName =
        `avatars/user-${req.user.userId}-${Date.now()}${safeExt}`;

      const avatarUrl =
        await uploadToStorage(
          req.file,
          fileName
        );

      const {
        data: updatedUser,
        error: updateError,
      } = await supabase
        .from("users")
        .update({
          avatar_url: avatarUrl,
        })
        .eq(
          "id",
          req.user.userId
        )
        .select(
          "id, phone, name, email, avatar_url"
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      return res.json({
        success: true,
        message:
          "Profile photo updated.",
        avatar_url: avatarUrl,
        user: updatedUser,
      });
    } catch (error) {
      console.error(
        "Avatar upload error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not upload photo. Please try again.",
      });
    }
  }
);

/* =========================================================
   PROTECTED EVENT PHOTO UPLOAD
========================================================= */

router.post(
  "/event-photo",
  verifyToken,
  upload.single("event_photo"),
  async (req, res) => {
    let uploadedFileName = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please choose an event photo.",
        });
      }

      /* ===============================================
         STEP 1

         Calculate exact + perceptual +
         regional fingerprints.

         Then compare them against photos
         belonging to OTHER organizers.
      =============================================== */

      const protection =
        await protectEventPhoto(
          req.user.userId,
          req.file.buffer
        );

      /* ===============================================
         STEP 2

         BLOCK if this strongly matches
         another organizer's protected image.
      =============================================== */

      if (
        protection.match.matched
      ) {
        const similarityText =
          typeof protection.match.similarity === "number"
            ? ` | similarity=${protection.match.similarity.toFixed(4)}`
            : "";

        console.warn(
          `Blocked protected event photo for user ${req.user.userId}. Match type: ${protection.match.reason}${similarityText}`
        );

        return res
          .status(409)
          .json({
            success: false,

            code:
              "EVENT_PHOTO_ALREADY_USED",

            message:
              "This photo, screenshot, or cropped version appears to already be associated with another Contriba organizer. Please use an original event photo.",
          });
      }

      /* ===============================================
         STEP 3

         The photo passed protection.

         NOW it is allowed into storage.
      =============================================== */

      const safeExt =
        getSafeExtension(
          req.file.originalname
        );

      uploadedFileName =
        `events/user-${req.user.userId}/event-${Date.now()}-${crypto
          .randomBytes(5)
          .toString(
            "hex"
          )}${safeExt}`;

      const photoUrl =
        await uploadToStorage(
          req.file,
          uploadedFileName
        );

      /* ===============================================
         STEP 4

         Save fingerprint ownership.

         If this fails, remove the uploaded
         image so we don't create an
         unprotected event photo.
      =============================================== */

      try {
        await saveImageFingerprint({
          ownerId:
            req.user.userId,

          imageUrl:
            photoUrl,

          fingerprint:
            protection.fingerprint,
        });
      } catch (
        fingerprintError
      ) {
        await removeUploadedFile(
          uploadedFileName
        );

        throw fingerprintError;
      }

      /* ===============================================
         SUCCESS
      =============================================== */

      return res.json({
        success: true,

        message:
          "Event photo uploaded and protected.",

        photo_url:
          photoUrl,

        photo_protected:
          true,
      });
    } catch (error) {
      console.error(
        "Event photo upload error:",
        error.message
      );

      return res.status(500).json({
        success: false,

        message:
          "Could not verify and upload this event photo. Please try again.",
      });
    }
  }
);

module.exports = router;