const path = require("path");
const express = require("express");

const router = express.Router();

// Public marketing site (public/marketing/) — plain HTML/CSS/JS, no build
// step. This is what "/" serves; the JSON health check lives at /health.
router.use("/marketing", express.static(path.join(__dirname, "..", "..", "public", "marketing")));
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "marketing", "index.html"));
});
router.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "marketing", "signup.html"));
});
router.get("/plan-selection", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "marketing", "plan-selection.html"));
});

module.exports = { router };
