// Deterministic extraction of a Privy PDF's Public Records section.
// This file is the single source of truth for the n8n "Parse Privy PDF" Code node.
// If you change anything between the SYNC markers, re-paste that block into the
// workflow (see docs/setup-notes.md).
//
// Scope note: everything here is regex over labelled `Key: Value` lines, which
// Privy emits reliably. The comps table is NOT parsed here — PDF extraction
// interleaves its columns and splits addresses into a separate ordinal block, so
// that half is handed to Ollama and validated against the counts this file
// returns. Nothing in this file estimates ARV or repairs.

// ==== SYNC-START (mirrored inside the n8n Code node) ====

// Privy writes the subject line as "$0<number> <street><City>, ST <zip>" with no
// space before the city, e.g. "$02116 Hope StNew Orleans, LA 70119".
const ADDRESS_RE = /\$0?(\d+\s+[A-Za-z0-9.'#\- ]+?)([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*([A-Z]{2})\s*(\d{5})/;

function labelled(text, name) {
  const m = text.match(new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.+)$', 'm'));
  return m ? m[1].trim() : null;
}

function labelledInt(text, name) {
  const raw = labelled(text, name);
  if (raw === null) return null;
  const digits = raw.replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

// Normalized form used to match a PDF against a Baserow row's property_address.
// Collapses the missing-space quirk, punctuation and casing so
// "2116 Hope StNew Orleans, LA 70119" and "2116 Hope St, New Orleans, LA 70119"
// compare equal.
function normalizeAddress(addr) {
  if (!addr) return '';
  return String(addr)
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// House number + street name + zip is enough to identify a parcel and is stable
// across the formatting differences between Privy, GHL and hand-typed entries.
function addressKey(addr) {
  const n = normalizeAddress(addr);
  const house = (n.match(/^(\d+)/) || [])[1] || '';
  const zip = (n.match(/(\d{5})(?!.*\d{5})/) || [])[1] || '';
  const street = (n.replace(/^\d+\s*/, '').match(/^([A-Z0-9'\- ]+?)(?=\s(?:APT|UNIT|STE|#)|$)/) || [])[1] || '';
  const streetCore = street.split(' ').slice(0, 3).join(' ').trim();
  return [house, streetCore, zip].filter(Boolean).join('|');
}

// The "Tax & Assessment" page prints all labels, then all values, so the two
// lists are matched by position rather than by proximity.
const TAX_LABELS = [
  'Total Assessed Value',
  'Assessed Land Value',
  'Assessed Improvement Value',
  'Market Total Value',
  'Market Land Value',
  'Market Improved Value',
  'Property Tax',
];

function parseTaxBlock(text) {
  const start = text.indexOf('Total Assessed Value');
  if (start === -1) return {};
  const block = text.slice(start);
  const amounts = (block.match(/\$[\d,]+/g) || []).map((s) => parseInt(s.replace(/[^0-9]/g, ''), 10));
  const out = {};
  TAX_LABELS.forEach((label, i) => {
    if (amounts[i] !== undefined) out[label] = amounts[i];
  });
  return out;
}

function sectionCount(text, word) {
  const m = text.match(new RegExp('(\\d+)\\s*' + word, 'i'));
  return m ? parseInt(m[1], 10) : 0;
}

// Returns the raw comps region so Ollama sees only that, not the whole document.
function compsBlock(text) {
  const start = text.search(/\bCOMPARABLES\b/);
  const end = text.search(/\bPUBLIC RECORDS\b/);
  if (start === -1 || end === -1 || end <= start) return '';
  return text.slice(start, end).trim();
}

function parsePrivy(text) {
  const src = String(text || '');

  const addr = src.match(ADDRESS_RE);
  const street = addr ? addr[1].trim() : null;
  const city = addr ? addr[2].trim() : null;
  const state = addr ? addr[3] : null;
  const zip = addr ? addr[4] : null;
  const property_address = street ? `${street}, ${city}, ${state} ${zip}` : null;

  const tax = parseTaxBlock(src);

  const bathFull = labelledInt(src, 'Bath Full');
  const bathPartial = labelledInt(src, 'Baths Partial');
  const baths = bathFull === null && bathPartial === null
    ? null
    : (bathFull || 0) + (bathPartial || 0) * 0.5;

  const sold_comp_count = sectionCount(src, 'SOLD');
  const under_contract_count = sectionCount(src, 'UNDER-CONTRACT');
  const active_count = sectionCount(src, 'ACTIVE');
  const rental_count = sectionCount(src, 'RENTALS');

  return {
    property_address,
    address_key: addressKey(property_address),
    street,
    city,
    state,
    zip,

    beds: labelledInt(src, 'Bedrooms'),
    baths,
    sqft: labelledInt(src, 'Sum Living Area Sq Ft') ?? labelledInt(src, 'Building Area'),
    lot_sqft: labelledInt(src, 'Lot Size Sq Ft'),
    year_built: labelledInt(src, 'Year Built'),

    // REFERENCE ONLY — this is the assessor's figure, never ARV.
    assessor_market_improved: tax['Market Improved Value'] ?? null,
    assessor_market_total: tax['Market Total Value'] ?? null,
    property_tax_annual: tax['Property Tax'] ?? null,

    building_condition: labelled(src, 'Building Condition'),
    construction_type: labelled(src, 'Construction Type'),
    stories: labelled(src, 'Stories'),
    zoning: labelled(src, 'Zoning'),
    land_use: labelled(src, 'Land Use Code'),
    owner_name: labelled(src, 'Owner 1 Full Name'),
    owner_occupied: /Owner-occupied/i.test(labelled(src, 'Owner Occupied') || ''),
    legal_description: labelled(src, 'Legal Description'),

    sold_comp_count,
    under_contract_count,
    active_count,
    rental_count,
    // True when the document carries no evidence of what the property sells for.
    // The Telegram card warns on this so nobody reads a RentCast estimate as ARV.
    has_sale_evidence: sold_comp_count > 0,

    comps_block: compsBlock(src),
  };
}

// ==== SYNC-END ====

export { parsePrivy, normalizeAddress, addressKey };
