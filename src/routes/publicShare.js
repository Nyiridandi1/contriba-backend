const express = require("express");
const router = express.Router();

const {
  getPublicSharePage,
} = require("../controllers/publicShareController");

router.get("/events/:eventId", getPublicSharePage);

module.exports = router;