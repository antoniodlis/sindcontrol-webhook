// Vercel Serverless Function: GET /api/health
module.exports = (req, res) => {
  res.status(200).json({ ok: true });
};
