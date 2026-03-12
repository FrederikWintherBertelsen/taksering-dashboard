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

// ─── TEST: se rå entries for regnskabsåret ────────────────
app.get('/api/test-journal', async (req, res) => {
  try {
    // Først hent accounting years
    const ayRes = await fetch(`${BASE}/accounting-years`, { headers: HEADERS });
    const ayData = await ayRes.json();
    const years = ayData.collection || [];

    // Find det år der matcher 2026 (eller seneste)
    const target = years.find(y => y.year === '2026') || years[years.length - 1];
    if (!target) return res.json({ error: 'Ingen regnskabsår fundet', years });

    // Hent 5 entries fra det år
    const eRes = await fetch(`${target.entries}?pagesize=5`, { headers: HEADERS });
    const eData = await eRes.json();
    res.json({ accountingYear: target.year, entries: eData.collection || [], raw: eData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HENT ALLE BOGFØRTE POSTERINGER FOR ET ÅR ────────────
async function fetchEntriesForYear(year) {
  // Find accounting year der matcher
  const ayRes = await fetch(`${BASE}/accounting-years`, { headers: HEADERS });
  const ayData = await ayRes.json();
  const years = ayData.collection || [];
  const target = years.find(y => y.year === String(year)) || years.find(y => y.year.startsWith(String(year)));
  if (!target) return [];

  let all = [];
  let url = `${target.entries}?pagesize=1000`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    all = all.concat(d.collection || []);
    url = d.pagination?.nextPage || null;
  }
  return all;
}

// Hent entries på tværs af år (til likviditet)
async function fetchEntriesForPeriod(fromDate, toDate) {
  const ayRes = await fetch(`${BASE}/accounting-years`, { headers: HEADERS });
  const ayData = await ayRes.json();
  const years = ayData.collection || [];

  // Find relevante regnskabsår der overlapper perioden
  const relevant = years.filter(y => {
    return new Date(y.toDate) >= new Date(fromDate) && new Date(y.fromDate) <= new Date(toDate);
  });

  let all = [];
  for (const ay of relevant) {
    let url = `${ay.entries}?pagesize=1000&filter=date$gte:${fromDate}$and:date$lte:${toDate}`;
    while (url) {
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      all = all.concat(d.collection || []);
      url = d.pagination?.nextPage || null;
    }
  }
  return all;
}

async function fetchAllInvoices(year) {
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;
  let all = [];
  let url = `${BASE}/invoices/booked?filter=date$gte:${from}$and:date$lte:${to}&pagesize=1000`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    all = all.concat(d.collection || []);
    url = d.pagination?.nextPage || null;
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
      const acc = e.account?.accountNumber || 0;
      return m === month && inRange(acc, range);
    })
    .reduce((sum, e) => sum + (e.amount || 0), 0);
}

// ─── DAGLIG BANKSALDO ─────────────────────────────────────
app.get('/api/liquidity', async (req, res) => {
  try {
    const today = new Date();
    const from = new Date(today);
    from.setDate(today.getDate() - 180); // hent 180 dage bagud for at have primo
    const fromStr = from.toISOString().split('T')[0];
    const toStr   = today.toISOString().split('T')[0];

    const all = await fetchEntriesForPeriod(fromStr, toStr);

    // Filtrer kun bankkonto 6750
    const bankEntries = all.filter(e => (e.account?.accountNumber || 0) === BANK_ACCOUNT);
    bankEntries.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Byg daglig akkumuleret saldo
    const dailyMap = {};
    bankEntries.forEach(e => {
      const day = e.date.split('T')[0];
      dailyMap[day] = (dailyMap[day] || 0) + (e.amount || 0);
    });

    // Lav kumulativ saldo
    const allDates = Object.keys(dailyMap).sort();
    let running = 0;
    const cumulMap = {};
    allDates.forEach(d => {
      running += dailyMap[d];
      cumulMap[d] = running;
    });

    // Generer 90 dage bagud
    const cutoff = new Date(today);
    cutoff.setDate(today.getDate() - 90);

    // Find primo saldo (seneste kendte saldo inden cutoff)
    let primoBalance = 0;
    allDates.forEach(d => {
      if (new Date(d) <= cutoff) primoBalance = cumulMap[d];
    });

    const days = [];
    let lastKnown = primoBalance;
    for (let d = new Date(cutoff); d <= today; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      if (cumulMap[dateStr] !== undefined) lastKnown = cumulMap[dateStr];
      days.push({ date: dateStr, balance: lastKnown });
    }

    res.json({ days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REVENUE + P/L ────────────────────────────────────────
app.get('/api/revenue', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const [entries, invoices] = await Promise.all([
      fetchEntriesForYear(year),
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
      const interest     = sumCategory(entries, PL_MAP.interestCosts, m) - sumCategory(entries, PL_MAP.interestIncome, m);
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
