const express = require("express");
const router = express.Router();

const {
  getShareOverview,
  getShareImage,
  trackShare,
  trackVisit,
  trackQrScan,
  getShareAnalytics,
  getSharePromoters,
  getShareInsights,
} = require("../controllers/shareController");

/*
|--------------------------------------------------------------------------
| Share Overview
|--------------------------------------------------------------------------
*/
router.get("/overview/:eventId", getShareOverview);

/*
|--------------------------------------------------------------------------
| NEW: Dynamic Open Graph Share Image
|--------------------------------------------------------------------------
|
| Returns a 1200x630 PNG generated from the event.
|
| Example:
| GET /api/share/events/123/image
|
*/
router.get("/events/:eventId/image", getShareImage);

/*
|--------------------------------------------------------------------------
| Tracking
|--------------------------------------------------------------------------
*/
router.post("/track", trackShare);
router.post("/visit", trackVisit);
router.post("/qr-scan", trackQrScan);

/*
|--------------------------------------------------------------------------
| Analytics
|--------------------------------------------------------------------------
*/
router.get("/analytics/:eventId", getShareAnalytics);
router.get("/promoters/:eventId", getSharePromoters);
router.get("/insights/:eventId", getShareInsights);

module.exports = router;