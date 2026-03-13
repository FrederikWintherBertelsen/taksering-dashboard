// v11b
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
const BASE      = 'https://restapi.e-conomic.com';
const BASE_NEW  = 'https://apis.e-conomic.com/journalsapi/v14.0.1';

const PL_MAP = {
  revenue:      { from: 1004, to: 1030 },
  directPay:    { from: 1100, to: 1112 },
  cogs:         { from: 1310, to: 1330 },
  salaries:     { from: 2210, to: 2285 },
  salesCosts:   { from: 2740, to: 2811 },
  rent:         { from: 3410, to: 3450 },
  adminCosts:   { from: 3600, to: 3790 },
  financial:    { from: 4310, to: 4481 },
};

const BANK_ACCOUNT = 5830;

app.post('/api/login', (req, res) => {
  if (req.body.password === PASSWORD) res.json({ ok: true });
  else res.status(401).json({ error: 'Forkert adgangskode' });
});

function draftAmountDKK(e) {
  const rate = (e.exchangeRate || 100) / 100;
  if (e.entryTypeNumber === 3) {
    const dkk = Math.abs(e.amount || 0) * rate;
    const hasVat = e.contraVatCode || e.vatCode;
    return hasVat ? dkk / 1.25 : dkk;
  } else {
    const dkk = (e.amount || 0) * rate;
    const hasVat = e.contraVatCode || e.vatCode;
    return hasVat ? dkk / 1.25 : dkk;
  }
}

async function fetchAllDraftEntries(year) {
  let drafts = [];
  let url = `${BASE_NEW}/draft-entries`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    const items = (d.items || []).filter(e => {
      if (!e.date) return false;
      return new Date(e.date).getFullYear() === year;
    });
    drafts = drafts.concat(items);
    url = d.cursor ? `${BASE_NEW}/draft-entries?cursor=${d.cursor}` : null;
  }
  return drafts;
}

// Hent alle posteringer for ét år med fuld paginering
async function fetchEntriesForYear(year) {
  let all = [];
  let page = 0;
  while (true) {
    const r = await fetch(`${BASE}/accounting-years/${year}/entries?pagesize=1000&skippages=${page}`, { headers: HEADERS });
    if (!r.ok) break;
    const d = await r.json();
    all = all.concat(d.collection || []);
    if (!d.pagination?.nextPage) break;
    page++;
  }
  return all;
}

async function fetchAllEntries(year) {
  const entries = await fetchEntriesForYear(year);
  const drafts  = await fetchAllDraftEntries(year);
  return entries.concat(drafts);
}

async function fetchAllInvoices(year) {
  let all = [];
  let url = `${BASE}/invoices/booked?filter=date$gte:${year}-01-01$and:date$lte:${year}-12-31&pagesize=1000&skippages=0`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    all = all.concat(d.collection || []);
    url = d.pagination?.nextPage || null;
  }
  return all;
}

function inRange(acc, range) { return acc >= range.from && acc <= range.to; }

function sumCat(entries, range, month) {
  return entries
    .filter(e => {
      const date = new Date(e.date);
      const acc = e.entryTypeNumber === 3
        ? (e.contraAccountNumber || 0)
        : (e.account?.accountNumber || e.accountNumber || 0);
      return date.getMonth() + 1 === month && inRange(acc, range);
    })
    .reduce((s, e) => {
      if (e.account) return s + (e.amount || 0);
      return s + draftAmountDKK(e);
    }, 0);
}

app.get('/api/revenue', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const [entries, invoices] = await Promise.all([
      fetchAllEntries(year),
      fetchAllInvoices(year)
    ]);

    const seen = new Set();
    const months = Array.from({length: 12}, (_, i) => {
      const m = i + 1;
      const revenue    = -(sumCat(entries, PL_MAP.revenue, m) + sumCat(entries, PL_MAP.directPay, m));
      const cogs       = sumCat(entries, PL_MAP.cogs, m);
      const salaries   = sumCat(entries, PL_MAP.salaries, m);
      const salesCosts = sumCat(entries, PL_MAP.salesCosts, m);
      const rent       = sumCat(entries, PL_MAP.rent, m);
      const adminCosts = sumCat(entries, PL_MAP.adminCosts, m);
      const financial  = sumCat(entries, PL_MAP.financial, m);
      const monthInv   = invoices.filter(inv => new Date(inv.date).getMonth() + 1 === m);
      const cids       = [...new Set(monthInv.map(inv => inv.customer?.customerNumber).filter(Boolean))];
      const newCustomers = cids.filter(c => !seen.has(c)).length;
      cids.forEach(c => seen.add(c));
      return { month: m, revenue, cogs, salaries, salesCosts, rent, adminCosts, financial, customers: cids.length, newCustomers };
    });

    res.json({ year, months });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/liquidity', async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    const endDate = new Date(year, month, 0);
    const today   = new Date();
    const toDate  = endDate < today ? endDate : today;
    const toStr   = toDate.toISOString().split('T')[0];

    const currentYear = toDate.getFullYear();

    // Hent alle posteringer fra 2025 og frem med fuld paginering
    const fetchYears = [2025, 2026, 2027].filter(y => y <= currentYear);
    let all = [];
    for (const y of fetchYears) {
      const entries = await fetchEntriesForYear(y);
      all = all.concat(entries);
    }

    // Tilføj kladder for indeværende år
    const drafts = await fetchAllDraftEntries(currentYear);
    all = all.concat(drafts);

    // Filtrer kun konto 5830, op til toStr, sorter kronologisk + entryNumber
    const bankEntries = all
      .filter(e => {
        const acc = e.account?.accountNumber || e.accountNumber || 0;
        const dateStr = (e.date || '').split('T')[0];
        return acc === BANK_ACCOUNT && dateStr <= toStr;
      })
      .sort((a, b) => {
        const dateDiff = new Date(a.date) - new Date(b.date);
        if (dateDiff !== 0) return dateDiff;
        return (a.entryNumber || 0) - (b.entryNumber || 0);
      });

    // Byg daglig delta-map
    const deltaMap = {};
    bankEntries.forEach(e => {
      const day = e.date.split('T')[0];
      deltaMap[day] = (deltaMap[day] || 0) + (e.amount || 0);
    });

    // Akkumuler til løbende saldo (startsaldo = 0, konto 5830 åbner 01.01.2025)
    let running = 0;
    const dailyMap = {};
    Object.keys(deltaMap).sort().forEach(d => {
      running += deltaMap[d];
      dailyMap[d] = Math.round(running * 100) / 100;
    });

    // Byg 90-dages serie med forward-fill
    const cutoff = new Date(toDate);
    cutoff.setDate(toDate.getDate() - 90);

    const allDates = Object.keys(dailyMap).sort();
    let lastKnown = 0;
    allDates.forEach(d => { if (new Date(d) <= cutoff) lastKnown = dailyMap[d]; });

    const days = [];
    for (let d = new Date(cutoff); d <= toDate; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().split('T')[0];
      if (dailyMap[ds] !== undefined) lastKnown = dailyMap[ds];
      days.push({ date: ds, balance: lastKnown });
    }

    res.json({ days });
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
    const r = await fetch(`${BASE}/invoices/drafts?pagesize=100`, { headers: HEADERS });
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
    const r = await fetch(`${BASE}/orders/drafts?pagesize=100`, { headers: HEADERS });
    const d = await r.json();
    res.json({ orders: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug endpoint — viser akkumuleret daglig saldo for konto 5830
app.get('/api/debug/bank', async (req, res) => {
  try {
    let all = [];
    for (const y of [2025, 2026]) {
      const entries = await fetchEntriesForYear(y);
      all = all.concat(entries);
    }
    const bankEntries = all
      .filter(e => (e.account?.accountNumber || e.accountNumber) === BANK_ACCOUNT)
      .sort((a, b) => {
        const dateDiff = new Date(a.date) - new Date(b.date);
        if (dateDiff !== 0) return dateDiff;
        return (a.entryNumber || 0) - (b.entryNumber || 0);
      });

    const deltaMap = {};
    bankEntries.forEach(e => {
      const day = e.date.split('T')[0];
      deltaMap[day] = (deltaMap[day] || 0) + (e.amount || 0);
    });

    let running = 0;
    const dailyBalances = Object.keys(deltaMap).sort().map(d => {
      running += deltaMap[d];
      return { date: d, balance: Math.round(running * 100) / 100 };
    });

    res.json({
      totalEntries: bankEntries.length,
      dailyBalances
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kører på port ${PORT}`));
