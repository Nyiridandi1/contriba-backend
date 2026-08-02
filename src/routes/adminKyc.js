const express = require("express");
const jwt = require("jsonwebtoken");

const supabase = require("../config/database");

const router = express.Router();

const KYC_BUCKET = "kyc-documents";
const SIGNED_URL_DURATION_SECONDS = 5 * 60;

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

   We do not trust the role inside localStorage or the JWT.
   The role is checked directly from the users table.
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
      "Admin authorization error:",
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

function normalizeStatus(value) {
  const allowedStatuses = new Set([
    "pending",
    "verified",
    "rejected",
    "all",
  ]);

  const normalized = String(value || "pending")
    .trim()
    .toLowerCase();

  return allowedStatuses.has(normalized)
    ? normalized
    : "pending";
}

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

  return Math.min(limit, 50);
}

async function getSubmission(submissionId) {
  const { data, error } = await supabase
    .from("kyc_submissions")
    .select(
      [
        "id",
        "user_id",
        "full_name",
        "email",
        "phone",
        "national_id_number",
        "date_of_birth",
        "nationality",
        "id_front_path",
        "id_back_path",
        "status",
        "reviewed_by",
        "reviewed_at",
        "rejection_reason",
        "created_at",
        "updated_at",
      ].join(", ")
    )
    .eq("id", submissionId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function createSignedDocumentUrl(path) {
  if (!path) {
    return null;
  }

  const { data, error } = await supabase.storage
    .from(KYC_BUCKET)
    .createSignedUrl(
      path,
      SIGNED_URL_DURATION_SECONDS
    );

  if (error) {
    throw error;
  }

  return data?.signedUrl || null;
}

/* =========================================================
   GET /api/admin/kyc/me

   Confirms whether the logged-in account is an admin.
========================================================= */

router.get(
  "/me",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    return res.json({
      success: true,
      admin: {
        id: req.admin.id,
        name: req.admin.name,
        email: req.admin.email,
        phone: req.admin.phone,
        role: req.admin.role,
      },
    });
  }
);

/* =========================================================
   GET /api/admin/kyc/submissions

   Query options:
   ?status=pending
   ?page=1
   ?limit=20
========================================================= */

router.get(
  "/submissions",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      const status = normalizeStatus(req.query.status);
      const page = normalizePage(req.query.page);
      const limit = normalizeLimit(req.query.limit);

      const from = (page - 1) * limit;
      const to = from + limit - 1;

      let query = supabase
        .from("kyc_submissions")
        .select(
          [
            "id",
            "user_id",
            "full_name",
            "email",
            "phone",
            "national_id_number",
            "date_of_birth",
            "nationality",
            "status",
            "reviewed_by",
            "reviewed_at",
            "rejection_reason",
            "created_at",
            "updated_at",
          ].join(", "),
          {
            count: "exact",
          }
        )
        .order("created_at", {
          ascending: false,
        })
        .range(from, to);

      if (status !== "all") {
        query = query.eq("status", status);
      }

      const {
        data: submissions,
        error,
        count,
      } = await query;

      if (error) {
        throw error;
      }

      const userIds = [
        ...new Set(
          (submissions || [])
            .map((submission) => submission.user_id)
            .filter(Boolean)
        ),
      ];

      let usersById = {};

      if (userIds.length > 0) {
        const { data: users, error: usersError } =
          await supabase
            .from("users")
            .select(
              [
                "id",
                "name",
                "email",
                "phone",
                "avatar_url",
                "role",
                "kyc_status",
                "kyc_submitted_at",
                "kyc_verified_at",
              ].join(", ")
            )
            .in("id", userIds);

        if (usersError) {
          throw usersError;
        }

        usersById = Object.fromEntries(
          (users || []).map((user) => [
            user.id,
            user,
          ])
        );
      }

      const records = (submissions || []).map(
        (submission) => ({
          ...submission,
          user:
            usersById[submission.user_id] || null,
          is_own_submission:
            submission.user_id === req.admin.id,
        })
      );

      const total = count || 0;
      const totalPages = Math.max(
        1,
        Math.ceil(total / limit)
      );

      return res.json({
        success: true,
        submissions: records,
        pagination: {
          page,
          limit,
          total,
          total_pages: totalPages,
          has_next_page: page < totalPages,
          has_previous_page: page > 1,
        },
        filters: {
          status,
        },
      });
    } catch (error) {
      console.error(
        "Get admin KYC submissions error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not load identity verification submissions.",
      });
    }
  }
);

/* =========================================================
   GET /api/admin/kyc/submissions/:id
========================================================= */

router.get(
  "/submissions/:id",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      const submission = await getSubmission(
        req.params.id
      );

      if (!submission) {
        return res.status(404).json({
          success: false,
          message: "KYC submission not found.",
        });
      }

      const { data: user, error: userError } =
        await supabase
          .from("users")
          .select(
            [
              "id",
              "name",
              "email",
              "phone",
              "avatar_url",
              "role",
              "kyc_status",
              "kyc_submitted_at",
              "kyc_verified_at",
              "kyc_rejection_reason",
              "created_at",
            ].join(", ")
          )
          .eq("id", submission.user_id)
          .maybeSingle();

      if (userError) {
        throw userError;
      }

      return res.json({
        success: true,
        submission: {
          ...submission,
          user: user || null,
          is_own_submission:
            submission.user_id === req.admin.id,
        },
      });
    } catch (error) {
      console.error(
        "Get admin KYC submission error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not load the identity verification submission.",
      });
    }
  }
);

/* =========================================================
   GET /api/admin/kyc/submissions/:id/documents

   Returns temporary signed URLs valid for five minutes.
========================================================= */

router.get(
  "/submissions/:id/documents",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      const submission = await getSubmission(
        req.params.id
      );

      if (!submission) {
        return res.status(404).json({
          success: false,
          message: "KYC submission not found.",
        });
      }

      const [frontUrl, backUrl] =
        await Promise.all([
          createSignedDocumentUrl(
            submission.id_front_path
          ),
          createSignedDocumentUrl(
            submission.id_back_path
          ),
        ]);

      return res.json({
        success: true,
        documents: {
          front_url: frontUrl,
          back_url: backUrl,
          expires_in:
            SIGNED_URL_DURATION_SECONDS,
        },
      });
    } catch (error) {
      console.error(
        "Get KYC document URLs error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not open the submitted identity documents.",
      });
    }
  }
);

/* =========================================================
   POST /api/admin/kyc/submissions/:id/approve
========================================================= */

router.post(
  "/submissions/:id/approve",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      const submission = await getSubmission(
        req.params.id
      );

      if (!submission) {
        return res.status(404).json({
          success: false,
          message: "KYC submission not found.",
        });
      }

      /*
       * Important security rule:
       * An administrator must not approve their own KYC.
       */
      if (submission.user_id === req.admin.id) {
        return res.status(403).json({
          success: false,
          code: "SELF_REVIEW_NOT_ALLOWED",
          message:
            "You cannot approve your own identity verification. Another administrator must review it.",
        });
      }

      if (submission.status !== "pending") {
        return res.status(409).json({
          success: false,
          message:
            "Only pending submissions can be approved.",
        });
      }

      const now = new Date().toISOString();

      const {
        data: updatedSubmission,
        error: submissionError,
      } = await supabase
        .from("kyc_submissions")
        .update({
          status: "verified",
          reviewed_by: req.admin.id,
          reviewed_at: now,
          rejection_reason: null,
          updated_at: now,
        })
        .eq("id", submission.id)
        .eq("status", "pending")
        .select(
          "id, user_id, status, reviewed_by, reviewed_at"
        )
        .single();

      if (submissionError) {
        throw submissionError;
      }

      const { error: userError } = await supabase
        .from("users")
        .update({
          kyc_status: "verified",
          kyc_verified_at: now,
          kyc_rejection_reason: null,
        })
        .eq("id", submission.user_id);

      if (userError) {
        await supabase
          .from("kyc_submissions")
          .update({
            status: "pending",
            reviewed_by: null,
            reviewed_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", submission.id);

        throw userError;
      }

      return res.json({
        success: true,
        message:
          "Identity verification approved successfully.",
        submission: updatedSubmission,
      });
    } catch (error) {
      console.error(
        "Approve KYC submission error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not approve the identity verification.",
      });
    }
  }
);

/* =========================================================
   POST /api/admin/kyc/submissions/:id/reject

   JSON body:
   {
     "reason": "The front image is blurry."
   }
========================================================= */

router.post(
  "/submissions/:id/reject",
  verifyToken,
  requireAdmin,
  async (req, res) => {
    try {
      const submission = await getSubmission(
        req.params.id
      );

      if (!submission) {
        return res.status(404).json({
          success: false,
          message: "KYC submission not found.",
        });
      }

      if (submission.user_id === req.admin.id) {
        return res.status(403).json({
          success: false,
          code: "SELF_REVIEW_NOT_ALLOWED",
          message:
            "You cannot reject your own identity verification. Another administrator must review it.",
        });
      }

      if (submission.status !== "pending") {
        return res.status(409).json({
          success: false,
          message:
            "Only pending submissions can be rejected.",
        });
      }

      const reason = String(
        req.body?.reason || ""
      ).trim();

      if (reason.length < 5) {
        return res.status(400).json({
          success: false,
          message:
            "Provide a clear rejection reason of at least five characters.",
        });
      }

      if (reason.length > 500) {
        return res.status(400).json({
          success: false,
          message:
            "The rejection reason must not exceed 500 characters.",
        });
      }

      const now = new Date().toISOString();

      const {
        data: updatedSubmission,
        error: submissionError,
      } = await supabase
        .from("kyc_submissions")
        .update({
          status: "rejected",
          reviewed_by: req.admin.id,
          reviewed_at: now,
          rejection_reason: reason,
          updated_at: now,
        })
        .eq("id", submission.id)
        .eq("status", "pending")
        .select(
          [
            "id",
            "user_id",
            "status",
            "reviewed_by",
            "reviewed_at",
            "rejection_reason",
          ].join(", ")
        )
        .single();

      if (submissionError) {
        throw submissionError;
      }

      const { error: userError } = await supabase
        .from("users")
        .update({
          kyc_status: "rejected",
          kyc_verified_at: null,
          kyc_rejection_reason: reason,
        })
        .eq("id", submission.user_id);

      if (userError) {
        await supabase
          .from("kyc_submissions")
          .update({
            status: "pending",
            reviewed_by: null,
            reviewed_at: null,
            rejection_reason: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", submission.id);

        throw userError;
      }

      return res.json({
        success: true,
        message:
          "Identity verification rejected.",
        submission: updatedSubmission,
      });
    } catch (error) {
      console.error(
        "Reject KYC submission error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not reject the identity verification.",
      });
    }
  }
);

module.exports = router;