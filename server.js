// v32
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
const BASE     = 'https://restapi.e-conomic.com';
const BASE_NEW = 'https://apis.e-conomic.com/journalsapi/v14.0.1';

const PL_MAP = {
  revenue:    { from: 1004, to: 1030 },
  directPay:  { from: 1100, to: 1112 },
  cogs:       { from: 1310, to: 1330 },
  salaries:   { from: 2210, to: 2285 },
  salesCosts: { from: 2740, to: 2811 },
  rent:       { from: 3410, to: 3450 },
  adminCosts: { from: 3600, to: 3790 },
  financial:  { from: 4310, to: 4481 },
};

const BANK_ACCOUNT = 5830;

const OPENING_BALANCES = {
  2025: 0,
  2026: 1121679.51,
};

app.post('/api/login', (req, res) => {
  if (req.body.password === PASSWORD) res.json({ ok: true });
  else res.status(401).json({ error: 'Forkert adgangskode' });
});

// ─── HJÆLPEFUNKTIONER ────────────────────────────────────────────────────────

function bankAmount(e) {
  const acc    = e.account?.accountNumber || e.accountNumber || 0;
  const contra = e.contraAccountNumber || 0;
  if (acc === BANK_ACCOUNT) return e.amount || 0;
  if (contra === BANK_ACCOUNT && e.entryTypeNumber === 2) return e.amount || 0;
  return -(e.amount || 0);
}

function resolveAccountNumber(e) {
  if (e.account) {
    return e.account.accountNumber || 0;
  }
  if (e.entryTypeNumber === 3) {
    return e.contraAccountNumber || 0;
  }
  return e.accountNumber || 0;
}

function plAmount(e) {
  if (e.account) {
    return e.amount || 0;
  }
  const rate = (e.exchangeRate || 100) / 100;
  if (e.entryTypeNumber === 3) {
    const dkk = Math.abs(e.amount || 0) * rate;
    const hasVat = e.contraVatCode || e.vatCode;
    return hasVat ? dkk / 1.25 : dkk;
  }
  const dkk = (e.amount || 0) * rate;
  const hasVat = e.contraVatCode || e.vatCode;
  return hasVat ? dkk / 1.25 : dkk;
}

function inRange(acc, range) {
  return acc >= range.from && acc <= range.to;
}

function sumCat(entries, range, month) {
  return entries
    .filter(e => {
      if (!e.date) return false;
      const d = new Date(e.date);
      if (d.getMonth() + 1 !== month) return false;
      const acc = resolveAccountNumber(e);
      return inRange(acc, range);
    })
    .reduce((s, e) => s + plAmount(e), 0);
}

// ─── FETCH FUNKTIONER ─────────────────────────────────────────────────────────

async function fetchAllJournals() {
  let journals = [];
  let url = `${BASE_NEW}/journals`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    journals = journals.concat(d.items || []);
    url = d.cursor ? `${BASE_NEW}/journals?cursor=${d.cursor}` : null;
  }
  return journals;
}

async function fetchAllDraftEntries(year) {
  let drafts = [];
  const seen = new Set();
  const journals = await fetchAllJournals();
  for (const journal of journals) {
    let url = `${BASE_NEW}/draft-entries?journalNumber=${journal.number}`;
    while (url) {
      const r = await fetch(url, { headers: HEADERS });
      const d = await r.json();
      const items = (d.items || []).filter(e => {
        if (!e.date) return false;
        if (new Date(e.date).getFullYear() !== year) return false;
        const key = e.entryNumber != null
          ? `${e.journalNumber || journal.number}-${e.entryNumber}`
          : `${e.date}-${e.accountNumber}-${e.amount}-${e.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      drafts = drafts.concat(items);
      url = d.cursor
        ? `${BASE_NEW}/draft-entries?journalNumber=${journal.number}&cursor=${d.cursor}`
        : null;
    }
  }
  return drafts;
}

async function fetchBankDraftEntries(year) {
  let drafts = [];

  let url = `${BASE_NEW}/draft-entries?contraAccountNumber=${BANK_ACCOUNT}`;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    const d = await r.json();
    const items = (d.items || []).filter(e => {
      if (!e.date) return false;
      return new Date(e.date).getFullYear() === year;
    });
    drafts = drafts.concat(items);
    url = d.cursor
      ? `${BASE_NEW}/draft-entries?contraAccountNumber=${BANK_ACCOUNT}&cursor=${d.cursor}`
      : null;
  }

  let url2 = `${BASE_NEW}/draft-entries?accountNumber=${BANK_ACCOUNT}`;
  while (url2) {
    const r = await fetch(url2, { headers: HEADERS });
    const d = await r.json();
    const items = (d.items || []).filter(e => {
      if (!e.date) return false;
      return new Date(e.date).getFullYear() === year;
    });
    drafts = drafts.concat(items);
    url2 = d.cursor
      ? `${BASE_NEW}/draft-entries?accountNumber=${BANK_ACCOUNT}&cursor=${d.cursor}`
      : null;
  }
  return drafts;
}

async function fetchAllCashbookEntries(year) {
  let all = [];
  const seen = new Set();
  try {
    const cbRes = await fetch(`${BASE}/cashbooks`, { headers: HEADERS });
    const cbData = await cbRes.json();
    const cashbooks = cbData.collection || [];
    for (const cb of cashbooks) {
      const entriesRes = await fetch(
        `${BASE}/cashbooks/${cb.cashBookNumber}/entries?pagesize=1000`,
        { headers: HEADERS }
      );
      const entriesData = await entriesRes.json();
      const items = (entriesData.collection || []).filter(e => {
        if (!e.date) return false;
        if (new Date(e.date).getFullYear() !== year) return false;
        const key = e.entryNumber != null
          ? `cb-${e.entryNumber}`
          : `cb-${e.date}-${e.account?.accountNumber || e.accountNumber || 0}-${e.amount}-${e.text || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      all = all.concat(items);
    }
  } catch (e) {}
  return all;
}

async function fetchEntriesForYear(year) {
  let all = [];
  let page = 0;
  while (true) {
    const r = await fetch(
      `${BASE}/accounting-years/${year}/entries?pagesize=1000&skippages=${page}`,
      { headers: HEADERS }
    );
    if (!r.ok) break;
    const d = await r.json();
    all = all.concat(d.collection || []);
    if (!d.pagination?.nextPage) break;
    page++;
  }
  return all;
}

async function fetchAllEntries(year) {
  const entries  = await fetchEntriesForYear(year);
  const drafts   = await fetchAllDraftEntries(year);
  const cashbook = await fetchAllCashbookEntries(year);
  return entries.concat(drafts).concat(cashbook);
}

async function fetchBankEntries(year) {
  const entries = await fetchEntriesForYear(year);
  const drafts  = await fetchBankDraftEntries(year);
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

// ─── P/L ENDPOINT ─────────────────────────────────────────────────────────────

app.get('/api/revenue', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const [entries, invoices] = await Promise.all([
      fetchAllEntries(year),
      fetchAllInvoices(year),
    ]);

    const seen = new Set();
    const months = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const revenue    = -(sumCat(entries, PL_MAP.revenue, m) + sumCat(entries, PL_MAP.directPay, m));
      const cogs       = -(sumCat(entries, PL_MAP.cogs, m));
      const salaries   = -(sumCat(entries, PL_MAP.salaries, m));
      const salesCosts = -(sumCat(entries, PL_MAP.salesCosts, m));
      const rent       = -(sumCat(entries, PL_MAP.rent, m));
      const adminCosts = -(sumCat(entries, PL_MAP.adminCosts, m));
      const financial  = -(sumCat(entries, PL_MAP.financial, m));

      const monthInv = invoices.filter(inv => new Date(inv.date).getMonth() + 1 === m);
      const cids = [...new Set(monthInv.map(inv => inv.customer?.customerNumber).filter(Boolean))];
      const newCustomers = cids.filter(c => !seen.has(c)).length;
      cids.forEach(c => seen.add(c));

      return { month: m, revenue, cogs, salaries, salesCosts, rent, adminCosts, financial, customers: cids.length, newCustomers };
    });

    res.json({ year, months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── LIKVIDITET ───────────────────────────────────────────────────────────────

app.get('/api/liquidity', async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    const endDate = new Date(year, month, 0);
    const today   = new Date();
    const toDate  = endDate < today ? endDate : today;
    const toStr   = toDate.toISOString().split('T')[0];

    const openingBalance = OPENING_BALANCES[year] || 0;
    const all = await fetchBankEntries(year);

    const bankEntries = all
      .filter(e => {
        const acc    = e.account?.accountNumber || e.accountNumber || 0;
        const contra = e.contraAccountNumber || 0;
        const dateStr = (e.date || '').split('T')[0];
        return (acc === BANK_ACCOUNT || contra === BANK_ACCOUNT) && dateStr <= toStr;
      })
      .sort((a, b) => {
        const dateDiff = new Date(a.date) - new Date(b.date);
        if (dateDiff !== 0) return dateDiff;
        return (a.entryNumber || 0) - (b.entryNumber || 0);
      });

    const deltaMap = {};
    bankEntries.forEach(e => {
      const day = e.date.split('T')[0];
      deltaMap[day] = (deltaMap[day] || 0) + bankAmount(e);
    });

    let running = openingBalance;
    const dailyMap = {};
    Object.keys(deltaMap).sort().forEach(d => {
      running += deltaMap[d];
      dailyMap[d] = Math.round(running * 100) / 100;
    });

    const cutoff = new Date(toDate);
    cutoff.setDate(toDate.getDate() - 90);
    const yearStart = new Date(year, 0, 1);
    if (cutoff < yearStart) cutoff.setTime(yearStart.getTime());

    const allDates = Object.keys(dailyMap).sort();
    let lastKnown = openingBalance;
    allDates.forEach(d => { if (new Date(d) <= cutoff) lastKnown = dailyMap[d]; });

    const days = [];
    for (let d = new Date(cutoff); d <= toDate; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().split('T')[0];
      if (dailyMap[ds] !== undefined) lastKnown = dailyMap[ds];
      days.push({ date: ds, balance: lastKnown });
    }

    res.json({ days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FAKTURA / KUNDER / PRODUKTER / ORDRER ────────────────────────────────────

app.get('/api/invoices/booked', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const r = await fetch(
      `${BASE}/invoices/booked?pagesize=50&skippages=${page - 1}&sort=bookedInvoiceNumber$desc`,
      { headers: HEADERS }
    );
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
    const r = await fetch(
      `${BASE}/invoices/booked?filter=remainder$gt:0&pagesize=100&sort=dueDate$asc`,
      { headers: HEADERS }
    );
    const d = await r.json();
    res.json({ invoices: d.collection || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const r = await fetch(
      `${BASE}/customers?pagesize=50&skippages=${page - 1}&sort=name$asc`,
      { headers: HEADERS }
    );
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

// ─── DEBUG ENDPOINTS ──────────────────────────────────────────────────────────

app.get('/api/debug/bank', async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const from  = req.query.from || null;
    const to    = req.query.to   || null;

    const all = await fetchBankEntries(year);
    const bankEntries = all
      .filter(e => {
        const acc    = e.account?.accountNumber || e.accountNumber || 0;
        const contra = e.contraAccountNumber || 0;
        if (!(acc === BANK_ACCOUNT || contra === BANK_ACCOUNT)) return false;
        const ds = (e.date || '').split('T')[0];
        if (from && ds < from) return false;
        if (to   && ds > to)   return false;
        return true;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const openingBalance = OPENING_BALANCES[year] || 0;
    const allForYear = all.filter(e => {
      const acc    = e.account?.accountNumber || e.accountNumber || 0;
      const contra = e.contraAccountNumber || 0;
      return acc === BANK_ACCOUNT || contra === BANK_ACCOUNT;
    });

    const deltaMap = {};
    allForYear.forEach(e => {
      const day = (e.date || '').split('T')[0];
      deltaMap[day] = (deltaMap[day] || 0) + bankAmount(e);
    });
    let running = openingBalance;
    const dailyBalances = Object.keys(deltaMap).sort().map(d => {
      running += deltaMap[d];
      return { date: d, balance: Math.round(running * 100) / 100 };
    });

    const entries = bankEntries.map(e => ({
      date: (e.date || '').split('T')[0],
      text: e.text || e.description || '',
      amount: e.amount,
      bankAmount: Math.round(bankAmount(e) * 100) / 100,
      entryType: e.entryTypeNumber,
      account: e.account?.accountNumber || e.accountNumber || null,
      contra: e.contraAccountNumber || null,
      source: e.account ? 'booked' : 'draft',
      entryNumber: e.entryNumber || null,
      voucherNumber: e.voucherNumber || null,
    }));

    res.json({ year, from, to, openingBalance, totalEntries: allForYear.length, filteredEntries: entries.length, dailyBalances, entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/drafts', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const drafts = await fetchBankDraftEntries(year);
    res.json({ count: drafts.length, entries: drafts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/cashbooks', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const cbRes = await fetch(`${BASE}/cashbooks`, { headers: HEADERS });
    const cbData = await cbRes.json();
    const cashbooks = cbData.collection || [];
    const result = [];
    for (const cb of cashbooks) {
      const entriesRes = await fetch(
        `${BASE}/cashbooks/${cb.cashBookNumber}/entries?pagesize=1000`,
        { headers: HEADERS }
      );
      const entriesData = await entriesRes.json();
      const bank = (entriesData.collection || []).filter(e => {
        const acc    = e.account?.accountNumber || e.accountNumber || 0;
        const contra = e.contraAccountNumber || 0;
        return (acc === BANK_ACCOUNT || contra === BANK_ACCOUNT)
          && new Date(e.date).getFullYear() === year;
      });
      result.push({ cashbook: cb, bankEntries: bank });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/journals', async (req, res) => {
  try {
    const r = await fetch(`${BASE_NEW}/journals`, { headers: HEADERS });
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/journal1', async (req, res) => {
  try {
    const r = await fetch(`${BASE_NEW}/draft-entries?journalNumber=1`, { headers: HEADERS });
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/contrafilter', async (req, res) => {
  try {
    const r = await fetch(
      `${BASE_NEW}/draft-entries?contraAccountNumber=${BANK_ACCOUNT}`,
      { headers: HEADERS }
    );
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/pl', async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const cat   = req.query.cat || 'salaries';
    const range = PL_MAP[cat];
    if (!range) return res.status(400).json({ error: `Ukendt kategori: ${cat}. Brug: ${Object.keys(PL_MAP).join(', ')}` });

    const entries = await fetchAllEntries(year);
    const matched = entries.filter(e => {
      if (!e.date) return false;
      const d = new Date(e.date);
      if (d.getMonth() + 1 !== month) return false;
      const acc = resolveAccountNumber(e);
      return inRange(acc, range);
    }).map(e => ({
      date: e.date,
      account: resolveAccountNumber(e),
      amount: plAmount(e),
      raw_amount: e.amount,
      entryType: e.entryTypeNumber,
      text: e.text || e.description || '',
      source: e.account ? 'booked' : 'draft',
    }));

    const total = matched.reduce((s, e) => s + e.amount, 0);
    res.json({ year, month, cat, range, total: -total, count: matched.length, entries: matched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kører på port ${PORT}`));
