const express = require("express");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const { randomUUID } = require("crypto");

const supabase = require("../config/database");

const router = express.Router();

const KYC_BUCKET = "kyc-documents";
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 2,
  },

  fileFilter: (req, file, callback) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return callback(
        new Error(
          "Only JPG, PNG, and WEBP identity images are allowed."
        )
      );
    }

    callback(null, true);
  },
});

function verifyToken(req, res, next) {
  const authorization =
    req.headers.authorization || "";

  const [scheme, token] =
    authorization.split(" ");

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
      message:
        "Session expired. Please log in again.",
    });
  }
}

function normalizeIdNumber(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function isValidIdNumber(value) {
  return /^[A-Z0-9-]{6,30}$/.test(value);
}

function isValidDateOfBirth(value) {
  const normalized = String(value || "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return false;
  }

  const date = new Date(
    `${normalized}T00:00:00.000Z`
  );

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const today = new Date();

  const oldestAllowed = new Date(
    Date.UTC(
      today.getUTCFullYear() - 120,
      today.getUTCMonth(),
      today.getUTCDate()
    )
  );

  const youngestAllowed = new Date(
    Date.UTC(
      today.getUTCFullYear() - 13,
      today.getUTCMonth(),
      today.getUTCDate()
    )
  );

  return (
    date >= oldestAllowed &&
    date <= youngestAllowed
  );
}

function maskIdNumber(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value);

  if (normalized.length <= 4) {
    return "*".repeat(normalized.length);
  }

  const hiddenLength = Math.max(
    normalized.length - 4,
    4
  );

  return (
    "*".repeat(hiddenLength) +
    normalized.slice(-4)
  );
}

async function normalizeIdentityImage(file) {
  try {
    return await sharp(file.buffer, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({
        width: 1800,
        height: 1800,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 88,
        mozjpeg: true,
      })
      .toBuffer();
  } catch {
    const error = new Error(
      "One of the selected files is not a valid image."
    );

    error.statusCode = 400;

    throw error;
  }
}

async function uploadPrivateDocument({
  userId,
  side,
  buffer,
}) {
  const filePath =
    `users/${userId}/${Date.now()}-` +
    `${randomUUID()}-${side}.jpg`;

  const { error } = await supabase.storage
    .from(KYC_BUCKET)
    .upload(filePath, buffer, {
      contentType: "image/jpeg",
      cacheControl: "3600",
      upsert: false,
    });

  if (error) {
    throw error;
  }

  return filePath;
}

async function removePrivateDocuments(paths) {
  const validPaths = paths.filter(Boolean);

  if (validPaths.length === 0) {
    return;
  }

  const { error } = await supabase.storage
    .from(KYC_BUCKET)
    .remove(validPaths);

  if (error) {
    console.error(
      "KYC document cleanup error:",
      error.message
    );
  }
}

async function getCurrentUser(userId) {
  const { data, error } = await supabase
    .from("users")
    .select(
      [
        "id",
        "name",
        "email",
        "phone",
        "kyc_status",
        "kyc_submitted_at",
        "kyc_verified_at",
        "kyc_rejection_reason",
        "deleted_at",
      ].join(", ")
    )
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

/* =========================================================
   GET /api/kyc/status
========================================================= */

router.get(
  "/status",
  verifyToken,
  async (req, res) => {
    try {
      const user = await getCurrentUser(
        req.user.userId
      );

      if (!user || user.deleted_at) {
        return res.status(404).json({
          success: false,
          message: "User account not found.",
        });
      }

      const {
        data: latestSubmission,
        error,
      } = await supabase
        .from("kyc_submissions")
        .select(
          [
            "id",
            "national_id_number",
            "date_of_birth",
            "nationality",
            "status",
            "rejection_reason",
            "created_at",
            "reviewed_at",
          ].join(", ")
        )
        .eq("user_id", user.id)
        .order("created_at", {
          ascending: false,
        })
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      const status =
        user.kyc_status ||
        "not_submitted";

      return res.json({
        success: true,

        kyc: {
          status,

          submitted_at:
            user.kyc_submitted_at ||
            latestSubmission?.created_at ||
            null,

          verified_at:
            user.kyc_verified_at ||
            latestSubmission?.reviewed_at ||
            null,

          rejection_reason:
            status === "rejected"
              ? user.kyc_rejection_reason ||
                latestSubmission?.rejection_reason ||
                null
              : null,

          national_id_number_masked:
            maskIdNumber(
              latestSubmission?.national_id_number
            ),

          date_of_birth:
            latestSubmission?.date_of_birth ||
            null,

          nationality:
            latestSubmission?.nationality ||
            null,
        },

        account: {
          name: user.name,
          email: user.email,
          phone: user.phone,
        },
      });
    } catch (error) {
      console.error(
        "Get KYC status error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not load identity verification status.",
      });
    }
  }
);

/* =========================================================
   POST /api/kyc/submit

   multipart/form-data fields:
   national_id_number
   date_of_birth
   nationality
   id_front
   id_back
========================================================= */

router.post(
  "/submit",
  verifyToken,

  upload.fields([
    {
      name: "id_front",
      maxCount: 1,
    },
    {
      name: "id_back",
      maxCount: 1,
    },
  ]),

  async (req, res) => {
    const uploadedPaths = [];

    try {
      const user = await getCurrentUser(
        req.user.userId
      );

      if (!user || user.deleted_at) {
        return res.status(404).json({
          success: false,
          message: "User account not found.",
        });
      }

      if (
        !user.name ||
        !user.email ||
        !user.phone
      ) {
        return res.status(400).json({
          success: false,
          code: "PROFILE_INCOMPLETE",
          message:
            "Complete your full name, email, and phone number before submitting identity verification.",
        });
      }

      if (user.kyc_status === "pending") {
        return res.status(409).json({
          success: false,
          code: "KYC_ALREADY_PENDING",
          message:
            "Your identity verification is already under review.",
        });
      }

      if (user.kyc_status === "verified") {
        return res.status(409).json({
          success: false,
          code: "KYC_ALREADY_VERIFIED",
          message:
            "Your identity is already verified.",
        });
      }

      const nationalIdNumber =
        normalizeIdNumber(
          req.body.national_id_number
        );

      const dateOfBirth = String(
        req.body.date_of_birth || ""
      ).trim();

      const nationality =
        String(
          req.body.nationality ||
            "Rwanda"
        ).trim() || "Rwanda";

      if (!isValidIdNumber(nationalIdNumber)) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid National ID number.",
        });
      }

      if (!isValidDateOfBirth(dateOfBirth)) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid date of birth. Users must be at least 13 years old.",
        });
      }

      if (nationality.length > 80) {
        return res.status(400).json({
          success: false,
          message:
            "Nationality is too long.",
        });
      }

      const frontFile =
        req.files?.id_front?.[0];

      const backFile =
        req.files?.id_back?.[0];

      if (!frontFile || !backFile) {
        return res.status(400).json({
          success: false,
          message:
            "Upload both the front and back of your National ID.",
        });
      }

      const {
        data: existingIdSubmission,
        error: existingIdError,
      } = await supabase
        .from("kyc_submissions")
        .select("id, user_id, status")
        .eq(
          "national_id_number",
          nationalIdNumber
        )
        .neq("user_id", user.id)
        .in("status", [
          "pending",
          "verified",
        ])
        .limit(1)
        .maybeSingle();

      if (existingIdError) {
        throw existingIdError;
      }

      if (existingIdSubmission) {
        return res.status(409).json({
          success: false,
          code: "ID_ALREADY_USED",
          message:
            "This National ID is already linked to another Contriba account.",
        });
      }

      const [
        frontBuffer,
        backBuffer,
      ] = await Promise.all([
        normalizeIdentityImage(frontFile),
        normalizeIdentityImage(backFile),
      ]);

      const frontPath =
        await uploadPrivateDocument({
          userId: user.id,
          side: "front",
          buffer: frontBuffer,
        });

      uploadedPaths.push(frontPath);

      const backPath =
        await uploadPrivateDocument({
          userId: user.id,
          side: "back",
          buffer: backBuffer,
        });

      uploadedPaths.push(backPath);

      const now =
        new Date().toISOString();

      const {
        data: submission,
        error: insertError,
      } = await supabase
        .from("kyc_submissions")
        .insert({
          user_id: user.id,

          full_name: user.name,
          email: user.email,
          phone: user.phone,

          national_id_number:
            nationalIdNumber,

          date_of_birth:
            dateOfBirth,

          nationality,

          id_front_path:
            frontPath,

          id_back_path:
            backPath,

          status: "pending",

          rejection_reason: null,
          reviewed_by: null,
          reviewed_at: null,

          updated_at: now,
        })
        .select(
          "id, status, created_at"
        )
        .single();

      if (insertError) {
        throw insertError;
      }

      const {
        error: updateError,
      } = await supabase
        .from("users")
        .update({
          kyc_status: "pending",
          kyc_submitted_at: now,
          kyc_verified_at: null,
          kyc_rejection_reason: null,
        })
        .eq("id", user.id);

      if (updateError) {
        await supabase
          .from("kyc_submissions")
          .delete()
          .eq("id", submission.id);

        throw updateError;
      }

      return res.status(201).json({
        success: true,

        message:
          "Identity verification submitted successfully. Your documents are now under review.",

        kyc: {
          submission_id:
            submission.id,

          status:
            submission.status,

          submitted_at:
            submission.created_at,

          national_id_number_masked:
            maskIdNumber(
              nationalIdNumber
            ),
        },
      });
    } catch (error) {
      await removePrivateDocuments(
        uploadedPaths
      );

      console.error(
        "Submit KYC error:",
        error.message
      );

      return res
        .status(
          error.statusCode || 500
        )
        .json({
          success: false,

          message:
            error.statusCode === 400
              ? error.message
              : "Could not submit identity verification. Please try again.",
        });
    }
  }
);

/* =========================================================
   MULTER ERROR HANDLER
========================================================= */

router.use((error, req, res, next) => {
  if (
    error instanceof
    multer.MulterError
  ) {
    if (
      error.code ===
      "LIMIT_FILE_SIZE"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Each identity image must be 5 MB or smaller.",
      });
    }

    return res.status(400).json({
      success: false,
      message:
        "Could not process the selected identity images.",
    });
  }

  if (error) {
    return res.status(400).json({
      success: false,
      message:
        error.message ||
        "Invalid identity verification request.",
    });
  }

  next();
});

module.exports = router;