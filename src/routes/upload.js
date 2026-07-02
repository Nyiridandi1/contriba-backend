const express = require("express");
const multer = require("multer");
const path = require("path");
const jwt = require("jsonwebtoken");
const supabase = require("../config/database");

const router = express.Router();

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG and WEBP images are allowed."));
    }

    cb(null, true);
  },
});

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Please login again.",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Session expired. Please login again.",
    });
  }
}

function getSafeExtension(fileName) {
  const ext = path.extname(fileName || "") || ".jpg";

  return [".jpg", ".jpeg", ".png", ".webp"].includes(ext.toLowerCase())
    ? ext.toLowerCase()
    : ".jpg";
}

async function uploadToStorage(file, fileName) {
  const { error: uploadError } = await supabase.storage
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

/* =========================
   PROFILE AVATAR UPLOAD
========================= */

router.post("/avatar", verifyToken, upload.single("avatar"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please choose a photo.",
      });
    }

    const safeExt = getSafeExtension(req.file.originalname);
    const fileName = `avatars/user-${req.user.userId}-${Date.now()}${safeExt}`;

    const avatarUrl = await uploadToStorage(req.file, fileName);

    const { data: updatedUser, error: updateError } = await supabase
      .from("users")
      .update({ avatar_url: avatarUrl })
      .eq("id", req.user.userId)
      .select("id, phone, name, email, avatar_url")
      .single();

    if (updateError) {
      throw updateError;
    }

    return res.json({
      success: true,
      message: "Profile photo updated.",
      avatar_url: avatarUrl,
      user: updatedUser,
    });
  } catch (error) {
    console.error("Avatar upload error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not upload photo. Please try again.",
    });
  }
});

/* =========================
   EVENT PHOTO UPLOAD
========================= */

router.post(
  "/event-photo",
  verifyToken,
  upload.single("event_photo"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please choose an event photo.",
        });
      }

      const safeExt = getSafeExtension(req.file.originalname);
      const fileName = `events/user-${req.user.userId}/event-${Date.now()}${safeExt}`;

      const photoUrl = await uploadToStorage(req.file, fileName);

      return res.json({
        success: true,
        message: "Event photo uploaded.",
        photo_url: photoUrl,
      });
    } catch (error) {
      console.error("Event photo upload error:", error.message);

      return res.status(500).json({
        success: false,
        message: "Could not upload event photo. Please try again.",
      });
    }
  }
);

module.exports = router;