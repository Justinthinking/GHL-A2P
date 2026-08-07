// Deterministic underwriting math for WF-OFFER-ENGINE-SFR.
// This file is the single source of truth for the n8n "Underwrite" Code node.
// If you change anything between the SYNC markers, re-paste that block into
// the workflow's Code node (see docs/setup-notes.md). LLMs never touch this
// math — code computes the offer.

// ==== SYNC-START (mirrored inside the n8n Code node) ====

const ASSIGNMENT_FEE = 10000;

// ARV band -> factor. Confirmed 2026-08-07 to ship with draft breakpoints;
// edit here (and in the Code node) when Justin locks final cutoffs.
const FACTOR_TABLE = [
  { maxArv: 100000, factor: 0.70 },
  { maxArv: 150000, factor: 0.75 },
  { maxArv: 200000, factor: 0.78 },
  { maxArv: 300000, factor: 0.82 },
  { maxArv: Infinity, factor: 0.849 },
];

class UnderwriteHalt extends Error {}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Baserow single-select fields arrive as { id, value, color }.
function sel(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : (v ?? null);
}

function usd(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function pct(dec) {
  return (dec * 100).toFixed(1) + '%';
}

function factorFor(arv) {
  return FACTOR_TABLE.find((band) => arv <= band.maxArv).factor;
}

function underwrite(row, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const arv = toNumber(row.arv);
  const repairs = toNumber(row.repairs);
  const contractPrice = toNumber(row.contract_price);
  const propertyType = sel(row.property_type) || 'SFR';
  const confidence = sel(row.confidence);
  const jv = toNumber(row.jv_opportunity_value);

  if (!(arv > 0)) {
    throw new UnderwriteHalt('arv is missing or zero — refusing to write a $0 offer');
  }
  if (!(repairs > 0)) {
    throw new UnderwriteHalt('repairs is missing or zero — refusing to compute');
  }

  const net = arv - repairs;
  const factor = factorFor(arv);
  const newMao = Math.round(net * factor - ASSIGNMENT_FEE);
  const uwSpread = contractPrice !== null ? newMao - contractPrice : null;
  const uwRatio = contractPrice !== null ? Number((contractPrice / arv).toFixed(4)) : null;

  const spreadRatioText = contractPrice !== null
    ? 'spread ' + usd(uwSpread) + ' / ratio ' + pct(uwRatio)
    : 'contract pending';

  const uwReason =
    'NEW MAO ' + usd(newMao) +
    ' = (ARV ' + usd(arv) + ' − Repairs ' + usd(repairs) + ' = ' + usd(net) + ') × ' + factor +
    ' − ' + usd(ASSIGNMENT_FEE) + ' fee | type ' + propertyType + ' | ' + spreadRatioText;

  const address = row.property_address || '(no address)';

  const offerNote =
    'OFFER — ' + address + '\n' +
    'NEW MAO: ' + usd(newMao) +
    '   (ARV ' + usd(arv) + ' − Repairs ' + usd(repairs) + ' = ' + usd(net) +
    ' × ' + factor + ' − ' + usd(ASSIGNMENT_FEE) + ')\n' +
    'Type: ' + propertyType +
    ' | Spread: ' + (uwSpread !== null ? usd(uwSpread) : 'pending') +
    ' | Ratio: ' + (uwRatio !== null ? pct(uwRatio) : 'pending') + '\n' +
    'Confidence: ' + (confidence || 'n/a') + ' | ' + uwReason;

  const firstName = String(row.decision_makers || '').trim().split(/[\s,]+/)[0] || 'there';
  const sellerDraft =
    'Hey ' + firstName + " — ran your numbers on " + address +
    " and I've got a real figure ready. " +
    'Can my partner call you today at 1 PM or 4 PM to walk through it? Which works better?';

  const telegramSummary =
    '🏠 UNDERWRITTEN — ' + address + '\n' +
    'ARV ' + usd(arv) + ' | Repairs ' + usd(repairs) + '\n' +
    'NEW MAO: ' + usd(newMao) + '\n' +
    'Spread: ' + (uwSpread !== null ? usd(uwSpread) : 'pending') +
    ' | Ratio: ' + (uwRatio !== null ? pct(uwRatio) : 'pending') + '\n' +
    'Confidence: ' + (confidence || 'n/a');

  return {
    arv,
    repairs,
    contract_price: contractPrice,
    property_type: propertyType,
    arv_minus_repairs: net,
    factor_used: factor,
    new_mao: newMao,
    uw_spread: uwSpread,
    uw_ratio: uwRatio,
    jv_opportunity_value: jv,
    confidence: confidence ?? null,
    uw_reason: uwReason,
    offer_note: offerNote,
    seller_draft: sellerDraft,
    telegram_summary: telegramSummary,
    computed_at: now.toISOString(),
  };
}

// ==== SYNC-END ====

export { ASSIGNMENT_FEE, FACTOR_TABLE, UnderwriteHalt, factorFor, underwrite };
