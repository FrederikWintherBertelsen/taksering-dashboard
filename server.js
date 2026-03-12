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

const BANK_ACCOUNT = 6750;

const PL_MAP = {
  revenue:        { from: 1004, to: 1030 },
  directPay:      { from: 1100, to: 1112 },
  cogs:           { from: 1310, to: 1330 },
  salaries:       { from: 2210, to: 2285 },
  otherPersonnel: { from: 2440, to: 2440 },
  salesCosts:     { from: 2740, to: 2811 },
  carCosts:       { from: 3110, to: 3140 },
  rent:           { from: 3410, to: 3450 },
  adminCosts:     { from: 3600, to: 3790 },
  depreciation:   { from: 3910, to: 3950 },
  interestIncome: { from: 4310, to: 4381 },
  interestCosts:  { from: 4410, to: 4481 },
};

app.post('/api/login', (req, res) => {
  if (req.body.password === PASSWORD) res.json({ ok: true });
  else res.status(401).json({ error: 'Forkert adgangskode' });
});

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

app.get('/api/test-journal', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/journals/entries/booked?pagesize=5`, { headers: HEADERS });
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test-accounts', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/accounts?pagesize=5`, { headers: HEADERS });
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function fetchJournalEntries(year) {
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  let all = [];
  let page = 1;
  while (true) {
    const r = await fetch(
      `${BASE}/journals/entries/booked?filter=date$gte:${from}$and:date$lte:${to}&pagesize=200&skippages=${page-1}`,
      { headers: HEADERS }
    );
    const d = await r.json();
    const items = d.collection || [];
    all = all.concat(items);
    if (items.length < 200) break;
    page++;
  }
  return all;
}

async function fetchAllInvoices(year) {
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  let all = [];
  let page = 1;
  while (true) {
    const r = await fetch(
      `${BASE}/invoices/booked?filter=date$gte:${from}$and:date$lte:${to}&pagesize=200&skippages=${page-1}`,
      { headers: HEADERS }
    );
    const d = await r.json();
    const items = d.collection || [];
    all = all.concat(items);
    if (items.length < 200) break;
    page++;
  }
  return all;
}

function inRange(accountNo, range) {
  return accountNo >= range.from && accountNo <= range.to;
}

function sumCategory(entries, range, month) {
  return entries
    .filter(e => {
      const m = new Date(e.date).getMonth() + 1;
      return m === month && inRange(e.account?.accountNumber || 0, range);
    })
    .reduce((sum, e) => sum + (e.amount || 0), 0);
}

// ─── DAGLIG BANKSALDO ─────────────────────────────────────
app.get('/api/liquidity', async (req, res) => {
  try {
    // Hent alle posteringer på konto 6750 — vi går 1 år tilbage for at få primo
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setFullYear(today.getFullYear() - 1);
    const from = fromDate.toISOString().split('T')[0];
    const to   = today.toISOString().split('T')[0];

    let all = [];
    let page = 1;
    while (true) {
      const r = await fetch(
        `${BASE}/journals/entries/booked?filter=date$gte:${from}$and:date$lte:${to}$and:account.accountNumber$eq:${BANK_ACCOUNT}&pagesize=200&skippages=${page-1}`,
        { headers: HEADERS }
      );
      const d = await r.json();
      const items = d.collection || [];
      all = all.concat(items);
      if (items.length < 200) break;
      page++;
    }

    // Sorter efter dato
    all.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Byg daglig saldo — akkumuleret fra første postering
    const dailyMap = {};
    let running = 0;
    all.forEach(e => {
      const day = e.date.split('T')[0];
      running += e.amount || 0;
      dailyMap[day] = running;
    });

    // Generer alle dage de sidste 90 dage med saldo
    const days = [];
    const cutoff = new Date(today);
    cutoff.setDate(today.getDate() - 90);

    // Find saldo på cutoff-datoen (primo for 90 dage)
    let primoBalance = 0;
    Object.entries(dailyMap).forEach(([date, bal]) => {
      if (new Date(date) <= cutoff) primoBalance = bal;
    });

    // Byg array af de 90 dage
    let lastKnown = primoBalance;
    for (let d = new Date(cutoff); d <= today; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      if (dailyMap[dateStr] !== undefined) lastKnown = dailyMap[dateStr];
      days.push({ date: dateStr, balance: lastKnown });
    }

    res.json({ days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REVENUE + P/L ────────────────────────────────────────
app.get('/api/revenue', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const [entries, invoices] = await Promise.all([
      fetchJournalEntries(year),
      fetchAllInvoices(year)
    ]);

    const months = Array.from({length: 12}, (_, i) => {
      const m = i + 1;
      const monthInvoices = invoices.filter(inv => new Date(inv.date).getMonth() + 1 === m);

      const revenue      = -sumCategory(entries, PL_MAP.revenue, m);
      const directPay    = -sumCategory(entries, PL_MAP.directPay, m);
      const totalRevenue = revenue + directPay;
      const cogs         = sumCategory(entries, PL_MAP.cogs, m);
      const salaries     = sumCategory(entries, PL_MAP.salaries, m) + sumCategory(entries, PL_MAP.otherPersonnel, m);
      const rent         = sumCategory(entries, PL_MAP.rent, m);
      const otherOpex    = sumCategory(entries, PL_MAP.salesCosts, m) + sumCategory(entries, PL_MAP.carCosts, m) + sumCategory(entries, PL_MAP.adminCosts, m);
      const depreciation = sumCategory(entries, PL_MAP.depreciation, m);
      const interest     = sumCategory(entries, PL_MAP.interestCosts, m) + sumCategory(entries, PL_MAP.interestIncome, m);
      const customerSet  = new Set(monthInvoices.map(inv => inv.customer?.customerNumber).filter(Boolean));

      return {
        month: m,
        revenue: totalRevenue,
        cogs, salaries, rent, otherOpex, depreciation, interest,
        customers: customerSet.size,
        _cids: [...customerSet]
      };
    });

    const seen = new Set();
    months.forEach(m => {
      m.newCustomers = m._cids.filter(c => !seen.has(c)).length;
      m._cids.forEach(c => seen.add(c));
      delete m._cids;
    });

    res.json({ year, months });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/booked', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const r = await fetch(`${BASE}/invoices/booked?pagesize=50&skippages=${page-1}&sort=bookedInvoiceNumber$desc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ invoices: d.collection || [], pageCount: Math.ceil((d.pagination?.results || 0) / 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/drafts', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/invoices/drafts?pagesize=100&sort=draftInvoiceNumber$desc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ invoices: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/unpaid', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/invoices/booked?filter=remainder$gt:0&pagesize=100&sort=dueDate$asc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ invoices: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const r = await fetch(`${BASE}/customers?pagesize=50&skippages=${page-1}&sort=name$asc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ customers: d.collection || [], pageCount: Math.ceil((d.pagination?.results || 0) / 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/products?pagesize=100`, { headers: HEADERS });
    const d = await r.json();
    res.json({ products: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/orders/drafts?pagesize=100&sort=orderNumber$desc`, { headers: HEADERS });
    const d = await r.json();
    res.json({ orders: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kører på port ${PORT}`));
