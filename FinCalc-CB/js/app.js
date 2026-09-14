/* FinCalc CB — app.js: DOM wiring only. All math lives in calc.js (tested separately). */

const AppState = {
  lang: localStorage_safe_get('fincalc_lang', 'en'),
  view: 'basic'
};

// ---- localStorage is unreliable inside some embedded/webview contexts; guard every call ----
function localStorage_safe_get(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
}
function localStorage_safe_set(key, val) {
  try { localStorage.setItem(key, val); } catch (e) { /* ignore */ }
}

const fmt = (n) => {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
};
const fmtPlain = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function t(key, vars) {
  const dict = I18N[AppState.lang] || I18N.en;
  let str = dict[key] || I18N.en[key] || key;
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '{' + k + '}'));
  }
  return str;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  // A few elements need a runtime value substituted into their translation
  // rather than the plain static string — reapplied here after the
  // generic pass above, and again whenever language or live-rates status changes.
  const rateNoteEl = document.getElementById('schemesRateNote');
  if (rateNoteEl) rateNoteEl.textContent = t('schemes_rate_note', { quarter: FinCalc.CURRENT_SCHEME_RATES.rateQuarter });
  renderLiveRatesStatus();
  document.documentElement.lang = AppState.lang;
  document.querySelectorAll('.lang-switch button').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === AppState.lang);
  });
}

function setLang(lang) {
  AppState.lang = lang;
  localStorage_safe_set('fincalc_lang', lang);
  applyTranslations();
}

// ---------------------------------------------------------------------
// LIVE RATES — best-effort fetch of rates.json (see scraper/ + the
// included GitHub Actions workflow). Always falls back to the
// hardcoded FinCalc.CURRENT_SCHEME_RATES defaults if unavailable.
// ---------------------------------------------------------------------
const LiveRates = {
  status: 'checking', // 'checking' | 'ok' | 'unavailable'
  repoLastVerified: null,
  schemesLastVerified: null
};

// Same sanity bounds as scraper/scrape_rates.py — defense in depth in case
// rates.json is ever corrupted, stale in a weird way, or hand-edited badly.
const RATE_BOUNDS = {
  repoRate: [2, 12], ppf: [4, 12], nsc: [4, 12], kvp: [4, 12],
  ssy: [4, 12], scss: [4, 12], pomis: [4, 12]
};
function inBounds(key, val) {
  const b = RATE_BOUNDS[key];
  return typeof val === 'number' && !isNaN(val) && b && val >= b[0] && val <= b[1];
}

/** Pushes FinCalc.CURRENT_SCHEME_RATES into every input field that uses it
 * as a default. Called at startup, after a live-rates fetch succeeds, and
 * after the user clicks "Save rates" in Settings — one place instead of
 * three copies of the same field list. */
function populateRateDefaults() {
  const r = FinCalc.CURRENT_SCHEME_RATES;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('loanRepoRate', r.repoRate);
  set('ppfRate', r.ppf);
  set('nscRate', r.nsc);
  set('kvpRate', r.kvp);
  set('kvpMonths', r.kvpMonths);
  set('ssyRate', r.ssy);
  set('scssRate', r.scss);
  set('rateRepo', r.repoRate);
  set('ratePpf', r.ppf);
  set('rateNsc', r.nsc);
  set('rateKvp', r.kvp);
  set('rateSsy', r.ssy);
  set('rateScss', r.scss);
  updateEffectiveFloatingRate();
}

function daysSince(isoString) {
  if (!isoString) return null;
  const then = new Date(isoString).getTime();
  if (isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

function renderLiveRatesStatus() {
  const statusEl = document.getElementById('liveRatesStatusText');
  if (!statusEl) return; // settings view not in DOM yet on first call — fine, re-called later
  const warnEl = document.getElementById('liveRatesStaleWarning');
  const repoEl = document.getElementById('liveRatesRepoVerified');
  const schemesEl = document.getElementById('liveRatesSchemesVerified');

  if (LiveRates.status === 'checking') {
    statusEl.textContent = t('settings_live_checking');
  } else if (LiveRates.status === 'ok') {
    statusEl.textContent = t('settings_live_ok');
  } else {
    statusEl.textContent = t('settings_live_unavailable');
  }

  const repoDays = daysSince(LiveRates.repoLastVerified);
  const schemesDays = daysSince(LiveRates.schemesLastVerified);
  if (repoEl) repoEl.textContent = LiveRates.repoLastVerified
    ? new Date(LiveRates.repoLastVerified).toLocaleDateString()
    : t('settings_live_never');
  if (schemesEl) schemesEl.textContent = LiveRates.schemesLastVerified
    ? new Date(LiveRates.schemesLastVerified).toLocaleDateString()
    : t('settings_live_never');

  const staleThresholdDays = 10;
  const isStale = LiveRates.status === 'ok' &&
    ((repoDays !== null && repoDays > staleThresholdDays) || (schemesDays !== null && schemesDays > staleThresholdDays));
  if (warnEl) {
    warnEl.style.display = isStale ? '' : 'none';
    if (isStale) {
      const worst = Math.max(repoDays || 0, schemesDays || 0);
      warnEl.textContent = t('settings_live_stale', { days: worst });
    }
  }
}

async function fetchLiveRates() {
  try {
    const res = await fetch('./rates.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('rates.json not reachable (HTTP ' + res.status + ')');
    const data = await res.json();

    let appliedAny = false;
    if (inBounds('repoRate', data.repoRate)) {
      FinCalc.CURRENT_SCHEME_RATES.repoRate = data.repoRate;
      LiveRates.repoLastVerified = data.repoLastVerified || data.generatedAt || null;
      appliedAny = true;
    }
    ['ppf', 'nsc', 'kvp', 'ssy', 'scss', 'pomis'].forEach((k) => {
      if (inBounds(k, data[k])) {
        FinCalc.CURRENT_SCHEME_RATES[k] = data[k];
        appliedAny = true;
      }
    });
    if (typeof data.kvpMonths === 'number' && data.kvpMonths >= 80 && data.kvpMonths <= 140) {
      FinCalc.CURRENT_SCHEME_RATES.kvpMonths = data.kvpMonths;
    }
    if (data.schemesLastVerified) LiveRates.schemesLastVerified = data.schemesLastVerified;

    LiveRates.status = appliedAny ? 'ok' : 'unavailable';
    if (appliedAny) populateRateDefaults();
  } catch (e) {
    // Expected and harmless: opened via bare file://, offline, not yet
    // hosted, or the scheduled workflow hasn't produced rates.json yet.
    LiveRates.status = 'unavailable';
  }
  renderLiveRatesStatus();
}


function showView(view) {
  AppState.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('appNav').classList.remove('open');
  document.getElementById('navScrim').classList.remove('show');
  window.scrollTo(0, 0);
}

function wireNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  document.getElementById('navToggle').addEventListener('click', () => {
    document.getElementById('appNav').classList.add('open');
    document.getElementById('navScrim').classList.add('show');
  });
  document.getElementById('navScrim').addEventListener('click', () => {
    document.getElementById('appNav').classList.remove('open');
    document.getElementById('navScrim').classList.remove('show');
  });
  document.querySelectorAll('.lang-switch button').forEach(b => {
    b.addEventListener('click', () => setLang(b.dataset.lang));
  });
}

// ---------------------------------------------------------------------
// BASIC / SCIENTIFIC CALCULATOR — accumulator-based, no eval()
// ---------------------------------------------------------------------
const BasicCalc = {
  display: '0',
  expr: '',
  first: null,
  operator: null,
  waitingForSecond: false,

  render() {
    document.getElementById('calcDisplay').textContent = this.display;
    document.getElementById('calcExpr').textContent = this.expr;
  },
  inputDigit(d) {
    if (this.waitingForSecond) {
      this.display = d;
      this.waitingForSecond = false;
    } else {
      this.display = (this.display === '0') ? d : this.display + d;
    }
    if (this.display.replace('-', '').replace('.', '').length > 15) this.display = this.display.slice(0, 15);
    this.render();
  },
  inputDecimal() {
    if (this.waitingForSecond) { this.display = '0.'; this.waitingForSecond = false; this.render(); return; }
    if (!this.display.includes('.')) this.display += '.';
    this.render();
  },
  clear() {
    this.display = '0'; this.expr = ''; this.first = null; this.operator = null; this.waitingForSecond = false;
    this.render();
  },
  backspace() {
    if (this.waitingForSecond) return;
    this.display = this.display.length > 1 ? this.display.slice(0, -1) : '0';
    this.render();
  },
  toggleSign() {
    if (this.display === '0') return;
    this.display = this.display.startsWith('-') ? this.display.slice(1) : '-' + this.display;
    this.render();
  },
  percent() {
    this.display = String(parseFloat(this.display) / 100);
    this.render();
  },
  applyOperator(op) {
    const val = parseFloat(this.display);
    if (this.operator && this.waitingForSecond) {
      this.operator = op;
      this.expr = fmtPlain(this.first) + ' ' + op;
      this.render();
      return;
    }
    if (this.first === null) {
      this.first = val;
    } else if (this.operator) {
      this.first = this._compute(this.first, val, this.operator);
      this.display = trimNum(this.first);
    }
    this.operator = op;
    this.waitingForSecond = true;
    this.expr = fmtPlain(this.first) + ' ' + op;
    this.render();
  },
  _compute(a, b, op) {
    switch (op) {
      case '+': return a + b;
      case '−': return a - b;
      case '×': return a * b;
      case '÷': return b === 0 ? NaN : a / b;
      default: return b;
    }
  },
  equals() {
    if (this.operator === null || this.first === null) return;
    const val = parseFloat(this.display);
    const result = this._compute(this.first, val, this.operator);
    this.expr = fmtPlain(this.first) + ' ' + this.operator + ' ' + fmtPlain(val) + ' =';
    this.display = trimNum(result);
    this.first = null;
    this.operator = null;
    this.waitingForSecond = false;
    this.render();
  },
  unary(fn) {
    const v = parseFloat(this.display);
    let r;
    switch (fn) {
      case 'sqrt': r = Math.sqrt(v); break;
      case 'sq': r = v * v; break;
      case 'inv': r = v === 0 ? NaN : 1 / v; break;
      case 'sin': r = Math.sin(v * Math.PI / 180); break;
      case 'cos': r = Math.cos(v * Math.PI / 180); break;
      case 'tan': r = Math.tan(v * Math.PI / 180); break;
      case 'log': r = Math.log10(v); break;
      case 'ln': r = Math.log(v); break;
      default: r = v;
    }
    this.display = trimNum(r);
    this.waitingForSecond = true;
    this.render();
  }
};
function trimNum(n) {
  if (!isFinite(n)) return 'Error';
  let s = Number(n.toFixed(10)).toString();
  if (s.replace('-', '').replace('.', '').length > 15) s = Number(n).toExponential(6);
  return s;
}

function wireBasicCalc() {
  document.querySelectorAll('#calcPad [data-digit]').forEach(b =>
    b.addEventListener('click', () => BasicCalc.inputDigit(b.dataset.digit)));
  document.getElementById('calcDot').addEventListener('click', () => BasicCalc.inputDecimal());
  document.getElementById('calcClear').addEventListener('click', () => BasicCalc.clear());
  document.getElementById('calcBack').addEventListener('click', () => BasicCalc.backspace());
  document.getElementById('calcSign').addEventListener('click', () => BasicCalc.toggleSign());
  document.getElementById('calcPercent').addEventListener('click', () => BasicCalc.percent());
  document.getElementById('calcEquals').addEventListener('click', () => BasicCalc.equals());
  document.querySelectorAll('#calcPad [data-op]').forEach(b =>
    b.addEventListener('click', () => BasicCalc.applyOperator(b.dataset.op)));
  document.querySelectorAll('#calcPad [data-fn]').forEach(b =>
    b.addEventListener('click', () => BasicCalc.unary(b.dataset.fn)));
  BasicCalc.render();
}

// ---------------------------------------------------------------------
// LOAN / EMI CALCULATOR
// ---------------------------------------------------------------------
let loanRateChanges = [];

function wireLoanCalc() {
  document.getElementById('loanMethod').addEventListener('change', updateLoanFieldVisibility);
  updateLoanFieldVisibility();

  document.getElementById('loanAddRateChange').addEventListener('click', () => {
    loanRateChanges.push({ atMonth: 13, newAnnualRate: parseFloat(document.getElementById('loanRepoRate').value || 5.25) + parseFloat(document.getElementById('loanSpread').value || 2) });
    renderRateChangeRows();
  });

  document.getElementById('loanCalcBtn').addEventListener('click', calculateLoan);
  document.getElementById('loanExportCsv').addEventListener('click', () => {
    if (!lastLoanSchedule) return;
    const rows = lastLoanSchedule.rows.map(r => [r.month, r.emi, r.principal, r.interest, r.balance, r.rate]);
    exportRowsAsCsv('FinCalcCB_Loan_Amortization.csv',
      ['Month', 'EMI', 'Principal', 'Interest', 'Balance', 'Rate(%)'], rows);
  });
  document.getElementById('loanExportPdf').addEventListener('click', printCurrentView);

  // repo rate / spread live-update effective rate display
  ['loanRepoRate', 'loanSpread'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateEffectiveFloatingRate);
  });
}

function updateEffectiveFloatingRate() {
  const repo = parseFloat(document.getElementById('loanRepoRate').value || 0);
  const spread = parseFloat(document.getElementById('loanSpread').value || 0);
  document.getElementById('loanEffectiveRateDisplay').textContent = (repo + spread).toFixed(2) + '%';
}

function updateLoanFieldVisibility() {
  const method = document.getElementById('loanMethod').value;
  document.getElementById('loanFloatingFields').style.display = (method === 'floating') ? '' : 'none';
  document.getElementById('loanFixedRateField').style.display = (method === 'floating') ? 'none' : '';
  document.getElementById('loanFlatNote').style.display = (method === 'flat') ? '' : 'none';
  if (method !== 'floating') { loanRateChanges = []; renderRateChangeRows(); }
}

function renderRateChangeRows() {
  const wrap = document.getElementById('loanRateChangeList');
  wrap.innerHTML = '';
  loanRateChanges.forEach((rc, idx) => {
    const row = document.createElement('div');
    row.className = 'field-grid';
    row.style.marginTop = '8px';
    row.innerHTML = `
      <div class="field"><label>${t('loan_rate_change_month')}</label>
        <input type="number" min="2" value="${rc.atMonth}" data-idx="${idx}" data-k="atMonth"></div>
      <div class="field"><label>${t('loan_rate_change_rate')}</label>
        <input type="number" step="0.01" value="${rc.newAnnualRate}" data-idx="${idx}" data-k="newAnnualRate"></div>
      <div class="field" style="justify-content:flex-end;">
        <button class="btn ghost small" data-remove="${idx}">✕</button></div>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const idx = +e.target.dataset.idx, k = e.target.dataset.k;
      loanRateChanges[idx][k] = parseFloat(e.target.value) || 0;
    });
  });
  wrap.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      loanRateChanges.splice(+btn.dataset.remove, 1);
      renderRateChangeRows();
    });
  });
}

let lastLoanSchedule = null;

function calculateLoan() {
  const method = document.getElementById('loanMethod').value;
  const principal = parseFloat(document.getElementById('loanPrincipal').value) || 0;
  const years = parseFloat(document.getElementById('loanTenureYears').value) || 0;
  const months = Math.round(years * 12);

  let annualRate;
  let rateChanges = [];
  if (method === 'floating') {
    const repo = parseFloat(document.getElementById('loanRepoRate').value) || 0;
    const spread = parseFloat(document.getElementById('loanSpread').value) || 0;
    annualRate = repo + spread;
    rateChanges = loanRateChanges;
  } else {
    annualRate = parseFloat(document.getElementById('loanRate').value) || 0;
  }

  document.getElementById('loanFlatCompare').style.display = 'none';

  if (method === 'flat') {
    const flat = FinCalc.flatRateEmi(principal, annualRate, years);
    lastLoanSchedule = FinCalc.amortizationSchedule(principal, annualRate, months); // for reference/export baseline
    document.getElementById('loanResultEmi').textContent = fmt(flat.emi);
    document.getElementById('loanResultTotalInterest').textContent = fmt(flat.totalInterest);
    document.getElementById('loanResultTotalPayment').textContent = fmt(flat.totalPayment);
    const approxReducing = FinCalc.flatToReducingApprox(annualRate);
    document.getElementById('loanFlatCompare').style.display = '';
    document.getElementById('loanFlatCompareText').textContent = `${t('loan_flat_vs_reducing')} ~${approxReducing}% p.a.`;
    renderLoanSchedule({ rows: [], totalInterest: flat.totalInterest, totalPayment: flat.totalPayment });
    return;
  }

  const schedule = FinCalc.amortizationSchedule(principal, annualRate, months, rateChanges);
  lastLoanSchedule = schedule;
  document.getElementById('loanResultEmi').textContent = fmt(schedule.firstEmi);
  document.getElementById('loanResultTotalInterest').textContent = fmt(schedule.totalInterest);
  document.getElementById('loanResultTotalPayment').textContent = fmt(schedule.totalPayment);
  renderLoanSchedule(schedule);
}

function renderLoanSchedule(schedule) {
  const tbody = document.getElementById('loanScheduleBody');
  tbody.innerHTML = '';
  const rows = schedule.rows || [];
  const showRows = rows.length > 360 ? rows.filter((r, i) => i % 12 === 0 || i === rows.length - 1) : rows;
  for (const r of showRows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.month}</td><td>${fmtPlain(r.emi)}</td><td>${fmtPlain(r.principal)}</td><td>${fmtPlain(r.interest)}</td><td>${fmtPlain(r.balance)}</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('loanScheduleWrap').style.display = rows.length ? '' : 'none';
}

// ---------------------------------------------------------------------
// INCOME TAX CALCULATOR
// ---------------------------------------------------------------------
function wireTaxCalc() {
  document.getElementById('taxCalcBtn').addEventListener('click', calculateTax);
  document.getElementById('taxExportPdf').addEventListener('click', printCurrentView);
}

function calculateTax() {
  const gross = parseFloat(document.getElementById('taxGrossIncome').value) || 0;
  const ageBand = document.getElementById('taxAgeBand').value;
  const deductions = parseFloat(document.getElementById('taxDeductions').value) || 0;

  const result = FinCalc.compareRegimes(gross, deductions, ageBand);
  renderTaxRegimeCard('new', result.new, result.betterRegime === 'new');
  renderTaxRegimeCard('old', result.old, result.betterRegime === 'old');

  const banner = document.getElementById('taxVerdictBanner');
  banner.style.display = '';
  const regimeLabel = result.betterRegime === 'new' ? t('tax_new_regime') : t('tax_old_regime');
  banner.innerHTML = `<span>${t('tax_better_regime')}: <b>${regimeLabel}</b></span><span>${t('tax_you_save')} <b>${fmt(result.savings)}</b> ${t('tax_by_choosing')}</span>`;
}

function renderTaxRegimeCard(which, data, isWinner) {
  const card = document.getElementById('taxCard_' + which);
  card.classList.toggle('winner', isWinner);
  const badge = card.querySelector('.badge');
  badge.style.display = isWinner ? '' : 'none';
  card.querySelector('[data-f="taxableIncome"]').textContent = fmt(data.taxableIncome);
  card.querySelector('[data-f="taxBeforeRebate"]').textContent = fmt(data.taxBeforeRebate);
  card.querySelector('[data-f="rebate87A"]').textContent = fmt(data.rebate87A);
  card.querySelector('[data-f="surcharge"]').textContent = fmt(data.surcharge);
  card.querySelector('[data-f="cess"]').textContent = fmt(data.cess);
  card.querySelector('[data-f="totalTax"]').textContent = fmt(data.totalTax);
  card.querySelector('[data-f="effectiveRate"]').textContent = data.effectiveRate + '%';
}

// ---------------------------------------------------------------------
// GST / VAT CALCULATOR
// ---------------------------------------------------------------------
function wireGstCalc() {
  document.getElementById('gstCalcBtn').addEventListener('click', () => {
    const mode = document.getElementById('gstMode').value;
    const amount = parseFloat(document.getElementById('gstAmount').value) || 0;
    const rate = parseFloat(document.getElementById('gstRate').value) || 0;
    const r = mode === 'add' ? FinCalc.gstAdd(amount, rate) : FinCalc.gstRemove(amount, rate);
    document.getElementById('gstResultBase').textContent = fmt(r.base);
    document.getElementById('gstResultGst').textContent = fmt(r.gstAmount);
    document.getElementById('gstResultCgst').textContent = fmt(r.cgst);
    document.getElementById('gstResultSgst').textContent = fmt(r.sgst);
    document.getElementById('gstResultIgst').textContent = fmt(r.igst);
    document.getElementById('gstResultTotal').textContent = fmt(r.total);
    document.getElementById('gstResults').style.display = '';
  });

  document.getElementById('vatCalcBtn').addEventListener('click', () => {
    const mode = document.getElementById('vatMode').value;
    const amount = parseFloat(document.getElementById('vatAmount').value) || 0;
    const rate = parseFloat(document.getElementById('vatRate').value) || 0;
    const r = FinCalc.vatCalc(amount, rate, mode);
    document.getElementById('vatResultBase').textContent = fmt(r.base);
    document.getElementById('vatResultAmount').textContent = fmt(r.vatAmount);
    document.getElementById('vatResultTotal').textContent = fmt(r.total);
    document.getElementById('vatResults').style.display = '';
  });
}

// ---------------------------------------------------------------------
// SAVINGS / FD / RD CALCULATOR
// ---------------------------------------------------------------------
function wireSavingsCalc() {
  document.getElementById('savingsType').addEventListener('change', updateSavingsFieldVisibility);
  updateSavingsFieldVisibility();
  document.getElementById('savingsCalcBtn').addEventListener('click', calculateSavings);
}

function updateSavingsFieldVisibility() {
  const type = document.getElementById('savingsType').value;
  document.getElementById('savingsPrincipalField').style.display = (type === 'rd') ? 'none' : '';
  document.getElementById('savingsMonthlyField').style.display = (type === 'rd') ? '' : 'none';
  document.getElementById('savingsCompoundingField').style.display = (type === 'rd') ? 'none' : '';
}

function calculateSavings() {
  const type = document.getElementById('savingsType').value;
  const rate = parseFloat(document.getElementById('savingsRate').value) || 0;
  const years = parseFloat(document.getElementById('savingsYears').value) || 0;

  let result;
  if (type === 'rd') {
    const monthly = parseFloat(document.getElementById('savingsMonthly').value) || 0;
    result = FinCalc.rdCalc(monthly, rate, Math.round(years * 12));
  } else {
    const principal = parseFloat(document.getElementById('savingsPrincipal').value) || 0;
    const freqMap = { annual: 1, quarterly: 4, monthly: 12 };
    const freq = freqMap[document.getElementById('savingsCompounding').value] || 4;
    if (type === 'fd') {
      result = FinCalc.fdCalc(principal, rate, years, freq);
      result.invested = principal;
    } else {
      result = FinCalc.compoundInterest(principal, rate, years, freq);
      result.invested = principal;
    }
  }
  document.getElementById('savingsResultMaturity').textContent = fmt(result.maturityAmount);
  document.getElementById('savingsResultInvested').textContent = fmt(result.invested !== undefined ? result.invested : (result.maturityAmount - result.interestEarned));
  document.getElementById('savingsResultInterest').textContent = fmt(result.interestEarned);
  document.getElementById('savingsResults').style.display = '';
}

// ---------------------------------------------------------------------
// MUTUAL FUND SIP / LUMPSUM
// ---------------------------------------------------------------------
function wireMfCalc() {
  document.getElementById('mfMode').addEventListener('change', updateMfFieldVisibility);
  updateMfFieldVisibility();
  document.getElementById('mfCalcBtn').addEventListener('click', calculateMf);
}

function updateMfFieldVisibility() {
  const mode = document.getElementById('mfMode').value;
  document.getElementById('mfMonthlyField').style.display = (mode === 'sip') ? '' : 'none';
  document.getElementById('mfLumpsumField').style.display = (mode === 'lumpsum') ? '' : 'none';
  document.getElementById('mfTargetField').style.display = (mode === 'target') ? '' : 'none';
}

function calculateMf() {
  const mode = document.getElementById('mfMode').value;
  const rate = parseFloat(document.getElementById('mfExpectedReturn').value) || 0;
  const years = parseFloat(document.getElementById('mfYears').value) || 0;
  document.getElementById('mfRequiredSipRow').style.display = 'none';

  let result;
  if (mode === 'sip') {
    const monthly = parseFloat(document.getElementById('mfMonthlyAmount').value) || 0;
    result = FinCalc.sipFutureValue(monthly, rate, years);
  } else if (mode === 'lumpsum') {
    const amt = parseFloat(document.getElementById('mfLumpsumAmount').value) || 0;
    result = FinCalc.lumpsumFutureValue(amt, rate, years);
  } else {
    const target = parseFloat(document.getElementById('mfTargetAmount').value) || 0;
    const requiredSip = FinCalc.sipRequiredForTarget(target, rate, years);
    result = FinCalc.sipFutureValue(requiredSip, rate, years);
    document.getElementById('mfRequiredSipRow').style.display = '';
    document.getElementById('mfResultRequiredSip').textContent = fmt(requiredSip);
  }
  document.getElementById('mfResultMaturity').textContent = fmt(result.maturityAmount);
  document.getElementById('mfResultInvested').textContent = fmt(result.invested);
  document.getElementById('mfResultGains').textContent = fmt(result.gains);
  document.getElementById('mfResults').style.display = '';
}

// ---------------------------------------------------------------------
// GOVERNMENT SCHEMES
// ---------------------------------------------------------------------
function wireSchemesCalc() {
  let lastPpfRows = [], lastSsyRows = [];

  document.getElementById('ppfCalcBtn').addEventListener('click', () => {
    const contribution = parseFloat(document.getElementById('ppfContribution').value) || 0;
    const rate = parseFloat(document.getElementById('ppfRate').value) || 0;
    const years = parseInt(document.getElementById('ppfYears').value) || 15;
    const r = FinCalc.ppfCalc(contribution, rate, years);
    lastPpfRows = r.rows;
    document.getElementById('ppfResultMaturity').textContent = fmt(r.maturityAmount);
    document.getElementById('ppfResultInvested').textContent = fmt(r.invested);
    document.getElementById('ppfResultInterest').textContent = fmt(r.interestEarned);
    document.getElementById('ppfResults').style.display = '';
  });
  document.getElementById('ppfExportCsv').addEventListener('click', () => {
    exportRowsAsCsv('FinCalcCB_PPF.csv', ['Year', 'Contribution', 'Interest', 'Balance'],
      lastPpfRows.map(r => [r.year, r.contribution, r.interest, r.balance]));
  });

  document.getElementById('nscCalcBtn').addEventListener('click', () => {
    const amt = parseFloat(document.getElementById('nscAmount').value) || 0;
    const rate = parseFloat(document.getElementById('nscRate').value) || 0;
    const r = FinCalc.nscCalc(amt, rate, 5);
    document.getElementById('nscResultMaturity').textContent = fmt(r.maturityAmount);
    document.getElementById('nscResultInvested').textContent = fmt(r.invested);
    document.getElementById('nscResultInterest').textContent = fmt(r.interestEarned);
    document.getElementById('nscResults').style.display = '';
  });

  document.getElementById('kvpCalcBtn').addEventListener('click', () => {
    const amt = parseFloat(document.getElementById('kvpAmount').value) || 0;
    const rate = parseFloat(document.getElementById('kvpRate').value) || 0;
    const months = parseFloat(document.getElementById('kvpMonths').value) || 115;
    const r = FinCalc.kvpCalc(amt, rate, months);
    document.getElementById('kvpResultMaturity').textContent = fmt(r.maturityAmount);
    document.getElementById('kvpResultInvested').textContent = fmt(r.invested);
    document.getElementById('kvpResultInterest').textContent = fmt(r.interestEarned);
    document.getElementById('kvpResults').style.display = '';
  });

  document.getElementById('ssyCalcBtn').addEventListener('click', () => {
    const contribution = parseFloat(document.getElementById('ssyContribution').value) || 0;
    const rate = parseFloat(document.getElementById('ssyRate').value) || 0;
    const r = FinCalc.ssyCalc(contribution, rate, 15, 21);
    lastSsyRows = r.rows;
    document.getElementById('ssyResultMaturity').textContent = fmt(r.maturityAmount);
    document.getElementById('ssyResultInvested').textContent = fmt(r.invested);
    document.getElementById('ssyResultInterest').textContent = fmt(r.interestEarned);
    document.getElementById('ssyResults').style.display = '';
  });
  document.getElementById('ssyExportCsv').addEventListener('click', () => {
    exportRowsAsCsv('FinCalcCB_SSY.csv', ['Year', 'Contribution', 'Interest', 'Balance'],
      lastSsyRows.map(r => [r.year, r.contribution, r.interest, r.balance]));
  });

  document.getElementById('scssCalcBtn').addEventListener('click', () => {
    const amt = parseFloat(document.getElementById('scssAmount').value) || 0;
    const rate = parseFloat(document.getElementById('scssRate').value) || 0;
    const r = FinCalc.scssCalc(amt, rate, 5);
    document.getElementById('scssResultInvested').textContent = fmt(r.invested);
    document.getElementById('scssResultQuarterly').textContent = fmt(r.quarterlyPayout);
    document.getElementById('scssResultInterest').textContent = fmt(r.totalInterestOverTenure);
    document.getElementById('scssResultTotal').textContent = fmt(r.totalReceived);
    document.getElementById('scssResults').style.display = '';
  });
}

// ---------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------
function wireSettings() {
  document.getElementById('settingsSaveBtn').addEventListener('click', () => {
    FinCalc.CURRENT_SCHEME_RATES.repoRate = parseFloat(document.getElementById('rateRepo').value) || FinCalc.CURRENT_SCHEME_RATES.repoRate;
    FinCalc.CURRENT_SCHEME_RATES.ppf = parseFloat(document.getElementById('ratePpf').value) || FinCalc.CURRENT_SCHEME_RATES.ppf;
    FinCalc.CURRENT_SCHEME_RATES.nsc = parseFloat(document.getElementById('rateNsc').value) || FinCalc.CURRENT_SCHEME_RATES.nsc;
    FinCalc.CURRENT_SCHEME_RATES.kvp = parseFloat(document.getElementById('rateKvp').value) || FinCalc.CURRENT_SCHEME_RATES.kvp;
    FinCalc.CURRENT_SCHEME_RATES.ssy = parseFloat(document.getElementById('rateSsy').value) || FinCalc.CURRENT_SCHEME_RATES.ssy;
    FinCalc.CURRENT_SCHEME_RATES.scss = parseFloat(document.getElementById('rateScss').value) || FinCalc.CURRENT_SCHEME_RATES.scss;
    populateRateDefaults();

    const msg = document.getElementById('settingsSavedMsg');
    msg.style.display = '';
    setTimeout(() => msg.style.display = 'none', 2500);
  });
}

// ---------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  applyTranslations();
  wireNav();
  wireBasicCalc();
  wireLoanCalc();
  wireTaxCalc();
  wireGstCalc();
  wireSavingsCalc();
  wireMfCalc();
  wireSchemesCalc();
  wireSettings();
  populateRateDefaults();
  renderLiveRatesStatus();
  showView('basic');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline install optional, ignore failures */ });
  }

  fetchLiveRates(); // best-effort, async — falls back silently if unreachable
});
