const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const APP_SECRET = process.env.ECONOMIC_APP_SECRET_TOKEN;
const GRANT      = process.env.ECONOMIC_GRANT_TOKEN;
const PASSWORD   = process.env.DASHBOARD_PASSWORD;

const HEADERS = {
  'X-AppSecretToken': APP_SECRET,
  'X-AgreementGrantToken': GRANT,
  'Content-Type': 'application/json'
};
const BASE = 'https://restapi.e-conomic.com';

// ─── LOGIN ────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  if (req.body.password === PASSWORD) res.json({ ok: true });
  else res.status(401).json({ error: 'Forkert adgangskode' });
});

// ─── SUMMARY ──────────────────────────────────────────────
app.get('/api/summary', async (req, res) => {
  try {
    const [inv, cust, prod] = await Promise.all([
      fetch(`${BASE}/invoices/booked?pagesize=1`, { headers: HEADERS }),
      fetch(`${BASE}/customers?pagesize=1`, { headers: HEADERS }),
      fetch(`${BASE}/products?pagesize=1`, { headers: HEADERS })
    ]);
    const [id, cd, pd] = await Promise.all([inv.json(), cust.json(), prod.json()]);
    res.json({
      invoiceCount:  id.pagination?.results || 0,
      customerCount: cd.pagination?.results || 0,
      productCount:  pd.pagination?.results || 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REVENUE + P/L PER MÅNED ──────────────────────────────
app.get('/api/revenue', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const from = `${year}-01-01`;
    const to   = `${year}-12-31`;

    let allInvoices = [];
    let page = 1;
    while (true) {
      const r = await fetch(
        `${BASE}/invoices/booked?filter=date$gte:${from}$and:date$lte:${to}&pagesize=200&skippages=${page-1}`,
        { headers: HEADERS }
      );
      const d = await r.json();
      const items = d.collection || [];
      allInvoices = allInvoices.concat(items);
      if (items.length < 200) break;
      page++;
    }

    const months = Array.from({length:12}, (_, i) => ({
      month: i + 1,
      revenue: 0,
      customers: new Set(),
      cashflow: 0
    }));

    allInvoices.forEach(inv => {
      const d = new Date(inv.date);
      if (d.getFullYear() !== year) return;
      const m = d.getMonth();
      const amount = inv.grossAmount || 0;
      months[m].revenue += amount;
      if (inv.customer?.customerNumber) months[m].customers.add(inv.customer.customerNumber);
      if ((inv.remainder || 0) === 0) months[m].cashflow += amount;
    });

    const seenCustomers = new Set();
    months.forEach(m => {
      const newOnes = [...m.customers].filter(c => !seenCustomers.has(c)).length;
      m.newCustomers = newOnes;
      m.customers.forEach(c => seenCustomers.add(c));
      m.customers = m.customers.size;
    });

    res.json({ year, months });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BOGFØRTE FAKTURAER ───────────────────────────────────
app.get('/api/invoices/booked', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const r = await fetch(
      `${BASE}/invoices/booked?pagesize=50&skippages=${page-1}&sort=bookedInvoiceNumber$desc`,
      { headers: HEADERS }
    );
    const d = await r.json();
    res.json({
      invoices:  d.collection || [],
      pageCount: Math.ceil((d.pagination?.results || 0) / 50)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── KLADDER ──────────────────────────────────────────────
app.get('/api/invoices/drafts', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/invoices/drafts?pagesize=100&sort=draftInvoiceNumber$desc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ invoices: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── UBETALTE ─────────────────────────────────────────────
app.get('/api/invoices/unpaid', async (req, res) => {
  try {
    const r = await fetch(
      `${BASE}/invoices/booked?filter=remainder$gt:0&pagesize=100&sort=dueDate$asc`,
      { headers: HEADERS }
    );
    const d = await r.json();
    res.json({ invoices: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── KUNDER ───────────────────────────────────────────────
app.get('/api/customers', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const r = await fetch(
      `${BASE}/customers?pagesize=50&skippages=${page-1}&sort=name$asc`,
      { headers: HEADERS }
    );
    const d = await r.json();
    res.json({
      customers: d.collection || [],
      pageCount: Math.ceil((d.pagination?.results || 0) / 50)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PRODUKTER ────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/products?pagesize=100`, { headers: HEADERS });
    const d = await r.json();
    res.json({ products: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ORDRER ───────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/orders/drafts?pagesize=100&sort=orderNumber$desc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ orders: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kører på port ${PORT}`));
