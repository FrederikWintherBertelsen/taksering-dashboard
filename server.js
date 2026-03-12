app.get('/api/test-journal', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/accounting-years`, { headers: HEADERS });
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
