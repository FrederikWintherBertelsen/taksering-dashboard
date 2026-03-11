const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ────────────────────────────────────────────────────────────────
// Set these as environment variables in Vercel/Netlify:
// ECONOMIC_APP_SECRET_TOKEN
// ECONOMIC_GRANT_TOKEN
// DASHBOARD_PASSWORD
const APP_SECRET  = process.env.ECONOMIC_APP_SECRET_TOKEN || 'YOUR_APP_SECRET';
const GRANT_TOKEN = process.env.ECONOMIC_GRANT_TOKEN      || 'YOUR_GRANT_TOKEN';
const DASH_PASS   = process.env.DASHBOARD_PASSWORD         || 'taksering2024';
const BASE_URL    = 'https://restapi.e-conomic.com';

// ─── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-dashboard-token'];
  if (token === DASH_PASS) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── E-CONOMIC HELPER ───────────────────────────────────────────────────────
async function economicFetch(endpoint, params = '') {
  const url = `${BASE_URL}${endpoint}${params}`;
  const resp = await fetch(url, {
    headers: {
      'X-AppSecretToken': APP_SECRET,
      'X-AgreementGrantToken': GRANT_TOKEN,
      'Content-Type': 'application/json'
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`E-conomic API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ─── LOGIN ENDPOINT ─────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === DASH_PASS) {
    res.json({ success: true, token: DASH_PASS });
  } else {
    res.status(401).json({ success: false, error: 'Forkert adgangskode' });
  }
});

// ─── DASHBOARD SUMMARY ──────────────────────────────────────────────────────
app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const [invoices, draftInvoices, customers, products] = await Promise.allSettled([
      economicFetch('/invoices/booked', '?skippages=0&pagesize=1'),
      economicFetch('/invoices/drafts', '?skippages=0&pagesize=1'),
      economicFetch('/customers',       '?skippages=0&pagesize=1'),
      economicFetch('/products',        '?skippages=0&pagesize=1'),
    ]);

    res.json({
      bookedInvoices: invoices.status === 'fulfilled'      ? invoices.value?.pagination?.results      || 0 : 0,
      draftInvoices:  draftInvoices.status === 'fulfilled' ? draftInvoices.value?.pagination?.results || 0 : 0,
      customers:      customers.status === 'fulfilled'     ? customers.value?.pagination?.results     || 0 : 0,
      products:       products.status === 'fulfilled'      ? products.value?.pagination?.results      || 0 : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── BOOKED INVOICES ────────────────────────────────────────────────────────
app.get('/api/invoices/booked', requireAuth, async (req, res) => {
  try {
    const page = req.query.page || 0;
    const data = await economicFetch('/invoices/booked', `?skippages=${page}&pagesize=50`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DRAFT INVOICES ─────────────────────────────────────────────────────────
app.get('/api/invoices/drafts', requireAuth, async (req, res) => {
  try {
    const page = req.query.page || 0;
    const data = await economicFetch('/invoices/drafts', `?skippages=${page}&pagesize=50`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── UNPAID / OVERDUE INVOICES ──────────────────────────────────────────────
app.get('/api/invoices/unpaid', requireAuth, async (req, res) => {
  try {
    const data = await economicFetch('/invoices/booked', '?skippages=0&pagesize=100&filter=remainder$gt:0');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CUSTOMERS ──────────────────────────────────────────────────────────────
app.get('/api/customers', requireAuth, async (req, res) => {
  try {
    const page = req.query.page || 0;
    const data = await economicFetch('/customers', `?skippages=${page}&pagesize=50`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SINGLE CUSTOMER ────────────────────────────────────────────────────────
app.get('/api/customers/:id', requireAuth, async (req, res) => {
  try {
    const data = await economicFetch(`/customers/${req.params.id}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PRODUCTS ───────────────────────────────────────────────────────────────
app.get('/api/products', requireAuth, async (req, res) => {
  try {
    const page = req.query.page || 0;
    const data = await economicFetch('/products', `?skippages=${page}&pagesize=50`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ACCOUNTS (CHART OF ACCOUNTS) ───────────────────────────────────────────
app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const data = await economicFetch('/accounts', '?skippages=0&pagesize=100');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REVENUE (from booked invoices, last 12 months) ─────────────────────────
app.get('/api/revenue', requireAuth, async (req, res) => {
  try {
    const today = new Date();
    const from  = new Date(today.getFullYear(), today.getMonth() - 11, 1).toISOString().split('T')[0];
    const data  = await economicFetch('/invoices/booked', `?skippages=0&pagesize=200&filter=date$gte:${from}`);
    
    // Group by month
    const monthly = {};
    (data.collection || []).forEach(inv => {
      const month = inv.date?.substring(0, 7);
      if (month) {
        monthly[month] = (monthly[month] || 0) + (inv.grossAmount || 0);
      }
    });

    const sorted = Object.entries(monthly).sort((a, b) => a[0].localeCompare(b[0]));
    res.json({ monthly: sorted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ORDERS ─────────────────────────────────────────────────────────────────
app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const page = req.query.page || 0;
    const data = await economicFetch('/orders/drafts', `?skippages=${page}&pagesize=50`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FALLBACK ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
