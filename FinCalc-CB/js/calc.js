/* =========================================================================
   FinCalc CB — Calculation Engine
   All formulas verified independently (see build notes) before UI wiring.
   Pure functions only — no DOM access in this file.
   ========================================================================= */

const FinCalc = (() => {

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  // ---------------------------------------------------------------------
  // LOAN / EMI  (reducing balance method — standard Indian amortization)
  // ---------------------------------------------------------------------

  /** Monthly EMI for a reducing-balance loan. rate = annual % */
  function emi(principal, annualRatePct, months) {
    const r = annualRatePct / 12 / 100;
    if (months <= 0 || principal <= 0) return 0;
    if (r === 0) return principal / months;
    const pow = Math.pow(1 + r, months);
    return principal * r * pow / (pow - 1);
  }

  /**
   * Full amortization schedule. Supports mid-tenure rate changes for
   * floating-rate loans via `rateChanges`: [{atMonth, newAnnualRate}]
   * (rate applies from that month onward; EMI is recalculated on the
   * remaining balance/tenure at that point, standard "same tenure,
   * revised EMI" floating-rate behaviour).
   */
  function amortizationSchedule(principal, annualRatePct, months, rateChanges = []) {
    let balance = principal;
    let currentRate = annualRatePct;
    let remainingMonths = months;
    let currentEmi = emi(balance, currentRate, remainingMonths);
    const changesByMonth = new Map(rateChanges.map(c => [c.atMonth, c.newAnnualRate]));

    const rows = [];
    let totalInterest = 0;
    let m = 1;
    while (m <= months && balance > 0.005) {
      if (changesByMonth.has(m)) {
        currentRate = changesByMonth.get(m);
        remainingMonths = months - m + 1;
        currentEmi = emi(balance, currentRate, remainingMonths);
      }
      const r = currentRate / 12 / 100;
      let interest = balance * r;
      let principalPaid = currentEmi - interest;
      if (principalPaid > balance) { // last installment rounding
        principalPaid = balance;
        currentEmi = principalPaid + interest;
      }
      balance = Math.max(0, balance - principalPaid);
      totalInterest += interest;
      rows.push({
        month: m,
        emi: round2(currentEmi),
        principal: round2(principalPaid),
        interest: round2(interest),
        balance: round2(balance),
        rate: currentRate
      });
      m++;
    }
    return {
      rows,
      totalInterest: round2(totalInterest),
      totalPayment: round2(principal + totalInterest),
      firstEmi: rows.length ? rows[0].emi : 0
    };
  }

  /** Flat-rate loan (simple interest on original principal, common for
   *  vehicle/consumer loans) — for comparison against reducing balance. */
  function flatRateEmi(principal, annualRatePct, years) {
    const totalInterest = principal * annualRatePct / 100 * years;
    const totalPayment = principal + totalInterest;
    const months = years * 12;
    return {
      emi: round2(totalPayment / months),
      totalInterest: round2(totalInterest),
      totalPayment: round2(totalPayment)
    };
  }

  /** Effective annual rate implied by a flat rate (roughly ~1.8-1.9x flat rate) */
  function flatToReducingApprox(flatRatePct) {
    // Common approximation: reducing rate ≈ flat rate * 1.9 (rough guide only)
    return round2(flatRatePct * 1.9);
  }

  // ---------------------------------------------------------------------
  // INCOME TAX — FY 2026-27 (AY 2027-28), New Regime (default) & Old Regime
  // Slabs sourced from Union Budget 2025 provisions, unchanged in Budget 2026.
  // ---------------------------------------------------------------------

  const NEW_REGIME_SLABS = [
    { upTo: 400000, rate: 0 },
    { upTo: 800000, rate: 0.05 },
    { upTo: 1200000, rate: 0.10 },
    { upTo: 1600000, rate: 0.15 },
    { upTo: 2000000, rate: 0.20 },
    { upTo: 2400000, rate: 0.25 },
    { upTo: Infinity, rate: 0.30 }
  ];

  function oldRegimeSlabs(ageBand) {
    // ageBand: 'below60' | 'senior60to80' | 'superSenior80plus'
    if (ageBand === 'senior60to80') {
      return [
        { upTo: 300000, rate: 0 },
        { upTo: 500000, rate: 0.05 },
        { upTo: 1000000, rate: 0.20 },
        { upTo: Infinity, rate: 0.30 }
      ];
    }
    if (ageBand === 'superSenior80plus') {
      return [
        { upTo: 500000, rate: 0 },
        { upTo: 1000000, rate: 0.20 },
        { upTo: Infinity, rate: 0.30 }
      ];
    }
    return [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.20 },
      { upTo: Infinity, rate: 0.30 }
    ];
  }

  function taxFromSlabs(taxableIncome, slabs) {
    let tax = 0, lower = 0;
    for (const slab of slabs) {
      if (taxableIncome > lower) {
        const chunk = Math.min(taxableIncome, slab.upTo) - lower;
        tax += chunk * slab.rate;
        lower = slab.upTo;
      } else break;
    }
    return tax;
  }

  function surcharge(totalIncome, taxBeforeCess, regime) {
    // Standard individual surcharge slabs; new regime capped at 25% (no 37% band)
    let rate = 0;
    if (totalIncome > 20000000) rate = (regime === 'new') ? 0.25 : 0.37;
    else if (totalIncome > 10000000) rate = 0.25;
    else if (totalIncome > 10000000 * 0) {} // no-op placeholder
    if (totalIncome > 10000000 && totalIncome <= 20000000) rate = 0.15;
    if (totalIncome > 5000000 && totalIncome <= 10000000) rate = 0.10;
    if (totalIncome <= 5000000) rate = 0;
    return round2(taxBeforeCess * rate);
  }

  /**
   * New regime tax computation with Section 87A rebate (full rebate up to
   * ₹12,00,000 taxable income, max ₹60,000) and marginal relief just above it.
   */
  function newRegimeTax(grossIncome, standardDeduction = 75000) {
    const taxable = Math.max(0, grossIncome - standardDeduction);
    let tax = taxFromSlabs(taxable, NEW_REGIME_SLABS);
    let rebate = 0;
    if (taxable <= 1200000) {
      rebate = Math.min(tax, 60000);
    }
    let taxAfterRebate = tax - rebate;
    // Marginal relief: tax payable just above 12L cannot exceed income above 12L
    if (taxable > 1200000) {
      const excessOverLimit = taxable - 1200000;
      if (tax > excessOverLimit && excessOverLimit < 100000) { // relief zone
        taxAfterRebate = excessOverLimit;
      }
    }
    const sur = surcharge(grossIncome, taxAfterRebate, 'new');
    const cess = round2((taxAfterRebate + sur) * 0.04);
    return {
      regime: 'new',
      standardDeduction,
      taxableIncome: round2(taxable),
      taxBeforeRebate: round2(tax),
      rebate87A: round2(rebate),
      surcharge: sur,
      cess,
      totalTax: round2(taxAfterRebate + sur + cess),
      effectiveRate: grossIncome > 0 ? round2((taxAfterRebate + sur + cess) / grossIncome * 100) : 0
    };
  }

  /**
   * Old regime tax computation. `deductions` = sum of 80C/80D/HRA/etc,
   * standardDeduction fixed at ₹50,000 for salaried/pensioners.
   */
  function oldRegimeTax(grossIncome, deductions = 0, ageBand = 'below60', standardDeduction = 50000) {
    const taxable = Math.max(0, grossIncome - standardDeduction - deductions);
    const slabs = oldRegimeSlabs(ageBand);
    let tax = taxFromSlabs(taxable, slabs);
    let rebate = 0;
    if (taxable <= 500000) {
      rebate = Math.min(tax, 12500);
    }
    const taxAfterRebate = tax - rebate;
    const sur = surcharge(grossIncome, taxAfterRebate, 'old');
    const cess = round2((taxAfterRebate + sur) * 0.04);
    return {
      regime: 'old',
      standardDeduction,
      deductionsClaimed: deductions,
      taxableIncome: round2(taxable),
      taxBeforeRebate: round2(tax),
      rebate87A: round2(rebate),
      surcharge: sur,
      cess,
      totalTax: round2(taxAfterRebate + sur + cess),
      effectiveRate: grossIncome > 0 ? round2((taxAfterRebate + sur + cess) / grossIncome * 100) : 0
    };
  }

  function compareRegimes(grossIncome, oldDeductions, ageBand) {
    const nw = newRegimeTax(grossIncome);
    const old = oldRegimeTax(grossIncome, oldDeductions, ageBand);
    const betterRegime = nw.totalTax <= old.totalTax ? 'new' : 'old';
    const savings = Math.abs(nw.totalTax - old.totalTax);
    return { new: nw, old, betterRegime, savings: round2(savings) };
  }

  // ---------------------------------------------------------------------
  // GST / VAT
  // ---------------------------------------------------------------------

  function gstAdd(baseAmount, ratePct) {
    const gst = baseAmount * ratePct / 100;
    return {
      base: round2(baseAmount),
      gstAmount: round2(gst),
      cgst: round2(gst / 2),
      sgst: round2(gst / 2),
      igst: round2(gst),
      total: round2(baseAmount + gst)
    };
  }

  function gstRemove(inclusiveAmount, ratePct) {
    const base = inclusiveAmount * 100 / (100 + ratePct);
    const gst = inclusiveAmount - base;
    return {
      base: round2(base),
      gstAmount: round2(gst),
      cgst: round2(gst / 2),
      sgst: round2(gst / 2),
      igst: round2(gst),
      total: round2(inclusiveAmount)
    };
  }

  function vatCalc(baseAmount, ratePct, mode = 'add') {
    if (mode === 'add') {
      const vat = baseAmount * ratePct / 100;
      return { base: round2(baseAmount), vatAmount: round2(vat), total: round2(baseAmount + vat) };
    }
    const base = baseAmount * 100 / (100 + ratePct);
    const vat = baseAmount - base;
    return { base: round2(base), vatAmount: round2(vat), total: round2(baseAmount) };
  }

  // ---------------------------------------------------------------------
  // SAVINGS / COMPOUND INTEREST / FD / RD
  // ---------------------------------------------------------------------

  function compoundInterest(principal, annualRatePct, years, compoundsPerYear = 1) {
    const n = compoundsPerYear;
    const amount = principal * Math.pow(1 + (annualRatePct / 100) / n, n * years);
    return { maturityAmount: round2(amount), interestEarned: round2(amount - principal) };
  }

  function fdCalc(principal, annualRatePct, years, compoundingFreq = 4) {
    // compoundingFreq: 1 annual, 4 quarterly (typical bank FD), 12 monthly
    return compoundInterest(principal, annualRatePct, years, compoundingFreq);
  }

  /** RD maturity: monthly deposit, compounded quarterly (standard bank RD convention) */
  function rdCalc(monthlyDeposit, annualRatePct, months) {
    const n = 4; // quarterly compounding
    const r = annualRatePct / 100;
    let maturity = 0;
    // Standard RD formula: sum of each installment compounded for its remaining tenure
    for (let i = 1; i <= months; i++) {
      const remainingMonths = months - i + 1;
      const t = remainingMonths / 12;
      maturity += monthlyDeposit * Math.pow(1 + r / n, n * t);
    }
    const invested = monthlyDeposit * months;
    return { maturityAmount: round2(maturity), invested: round2(invested), interestEarned: round2(maturity - invested) };
  }

  // ---------------------------------------------------------------------
  // MUTUAL FUNDS — SIP & Lumpsum
  // ---------------------------------------------------------------------

  /** SIP future value — monthly investment, annuity-due convention (industry standard) */
  function sipFutureValue(monthlyAmount, annualRatePct, years) {
    const i = annualRatePct / 12 / 100;
    const n = years * 12;
    let fv;
    if (i === 0) fv = monthlyAmount * n;
    else fv = monthlyAmount * ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
    const invested = monthlyAmount * n;
    return { maturityAmount: round2(fv), invested: round2(invested), gains: round2(fv - invested) };
  }

  function lumpsumFutureValue(principal, annualRatePct, years) {
    const fv = principal * Math.pow(1 + annualRatePct / 100, years);
    return { maturityAmount: round2(fv), invested: round2(principal), gains: round2(fv - principal) };
  }

  /** Required monthly SIP to reach a target corpus */
  function sipRequiredForTarget(targetAmount, annualRatePct, years) {
    const i = annualRatePct / 12 / 100;
    const n = years * 12;
    if (i === 0) return round2(targetAmount / n);
    const factor = ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
    return round2(targetAmount / factor);
  }

  // ---------------------------------------------------------------------
  // GOVERNMENT SAVINGS SCHEMES
  // Rates below are the officially notified rates for Jul–Sep 2026 (Q2 FY26-27).
  // Oct–Dec 2026 rates are due around 30 Sep 2026 — editable in the UI.
  // ---------------------------------------------------------------------

  const CURRENT_SCHEME_RATES = {
    ppf: 7.1,
    nsc: 7.7,
    kvp: 7.5,        // matures in 115 months at this rate
    kvpMonths: 115,
    ssy: 8.2,
    scss: 8.2,
    pomis: 7.4,
    rateQuarter: 'Jul–Sep 2026',
    repoRate: 5.25,   // RBI repo rate, as of Aug 2026 MPC (held; next review Oct 2026)
    repoAsOf: 'August 2026 MPC'
  };

  /** PPF — annual contribution at start of financial year, compounded annually */
  function ppfCalc(annualContribution, ratePct, years) {
    let balance = 0;
    const rows = [];
    for (let y = 1; y <= years; y++) {
      balance += annualContribution;
      const interest = balance * ratePct / 100;
      balance += interest;
      rows.push({ year: y, contribution: annualContribution, interest: round2(interest), balance: round2(balance) });
    }
    const invested = annualContribution * years;
    return { rows, invested, maturityAmount: round2(balance), interestEarned: round2(balance - invested) };
  }

  /** NSC — 5-year lock-in, compounded annually, interest reinvested */
  function nscCalc(principal, ratePct, years = 5) {
    const maturity = principal * Math.pow(1 + ratePct / 100, years);
    return { invested: round2(principal), maturityAmount: round2(maturity), interestEarned: round2(maturity - principal) };
  }

  /** KVP — doubles in ~115 months at the notified rate; compounded annually */
  function kvpCalc(principal, ratePct, months) {
    const years = months / 12;
    const maturity = principal * Math.pow(1 + ratePct / 100, years);
    return {
      invested: round2(principal),
      maturityAmount: round2(maturity),
      interestEarned: round2(maturity - principal),
      maturityMonths: months
    };
  }

  /** Sukanya Samriddhi Yojana — deposits up to 15 years from account opening,
   *  compounded annually, matures 21 years from account opening. */
  function ssyCalc(annualContribution, ratePct, depositYears = 15, maturityYears = 21) {
    let balance = 0;
    const rows = [];
    for (let y = 1; y <= maturityYears; y++) {
      if (y <= depositYears) balance += annualContribution;
      const interest = balance * ratePct / 100;
      balance += interest;
      rows.push({ year: y, contribution: y <= depositYears ? annualContribution : 0, interest: round2(interest), balance: round2(balance) });
    }
    const invested = annualContribution * depositYears;
    return { rows, invested, maturityAmount: round2(balance), interestEarned: round2(balance - invested) };
  }

  /** SCSS — 5-year tenure (extendable +3y), simple interest paid quarterly, not compounded */
  function scssCalc(principal, ratePct, years = 5) {
    const quarterlyPayout = round2(principal * ratePct / 100 / 4);
    const totalInterest = round2(principal * ratePct / 100 * years);
    return {
      invested: round2(principal),
      quarterlyPayout,
      totalInterestOverTenure: totalInterest,
      totalReceived: round2(principal + totalInterest)
    };
  }

  return {
    round2,
    emi, amortizationSchedule, flatRateEmi, flatToReducingApprox,
    newRegimeTax, oldRegimeTax, compareRegimes,
    gstAdd, gstRemove, vatCalc,
    compoundInterest, fdCalc, rdCalc,
    sipFutureValue, lumpsumFutureValue, sipRequiredForTarget,
    ppfCalc, nscCalc, kvpCalc, ssyCalc, scssCalc,
    CURRENT_SCHEME_RATES
  };
})();

// UMD-style export guard — harmless in the browser, lets Node test scripts require() this file.
if (typeof module !== 'undefined' && module.exports) module.exports = FinCalc;
