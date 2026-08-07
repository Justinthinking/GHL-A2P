import { workflow, node, trigger, sticky, newCredential, ifElse, expr, placeholder } from '@n8n/workflow-sdk';

const UNDERWRITE_JS = `// ==== SYNC-START (mirror of src/underwrite.mjs — keep in sync) ====
const ASSIGNMENT_FEE = 10000;

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
    'OFFER — ' + address + '\\n' +
    'NEW MAO: ' + usd(newMao) +
    '   (ARV ' + usd(arv) + ' − Repairs ' + usd(repairs) + ' = ' + usd(net) +
    ' × ' + factor + ' − ' + usd(ASSIGNMENT_FEE) + ')\\n' +
    'Type: ' + propertyType +
    ' | Spread: ' + (uwSpread !== null ? usd(uwSpread) : 'pending') +
    ' | Ratio: ' + (uwRatio !== null ? pct(uwRatio) : 'pending') + '\\n' +
    'Confidence: ' + (confidence || 'n/a') + ' | ' + uwReason;

  const firstName = String(row.decision_makers || '').trim().split(/[\\s,]+/)[0] || 'there';
  const sellerDraft =
    'Hey ' + firstName + " — ran your numbers on " + address +
    " and I've got a real figure ready. " +
    'Can my partner call you today at 1 PM or 4 PM to walk through it? Which works better?';

  const telegramSummary =
    '🏠 UNDERWRITTEN — ' + address + '\\n' +
    'ARV ' + usd(arv) + ' | Repairs ' + usd(repairs) + '\\n' +
    'NEW MAO: ' + usd(newMao) + '\\n' +
    'Spread: ' + (uwSpread !== null ? usd(uwSpread) : 'pending') +
    ' | Ratio: ' + (uwRatio !== null ? pct(uwRatio) : 'pending') + '\\n' +
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

const row = $input.first().json;
const result = underwrite(row);

const ghl_custom_fields = [
  ['new_mao', result.new_mao],
  ['arvrepairs', result.arv_minus_repairs],
  ['repairs', result.repairs],
  ['contract_price', result.contract_price],
  ['uwspread', result.uw_spread],
  ['uwratio', result.uw_ratio],
  ['uw_reason', result.uw_reason],
  ['property_types', result.property_type],
  ['unit_count', toNumber(row.unit_count)],
  ['unit_rent_monthly', toNumber(row.unit_rent_monthly)],
  ['hoa_monthly', toNumber(row.hoa_monthly)],
  ['jv_opportunity_value', result.jv_opportunity_value],
]
  .filter(([, v]) => v !== null && v !== undefined)
  .map(([key, field_value]) => ({ key, field_value }));

const baserow_update = {
  arv_minus_repairs: result.arv_minus_repairs,
  factor_used: result.factor_used,
  new_mao: result.new_mao,
  uw_spread: result.uw_spread,
  uw_ratio: result.uw_ratio,
  jv_opportunity_value: result.jv_opportunity_value,
  uw_reason: result.uw_reason,
  offer_note: result.offer_note,
  seller_draft: result.seller_draft,
  computed_at: result.computed_at,
  status: 'Underwritten',
};

return [{
  json: {
    row_id: row.id,
    ghl_contact_id: row.ghl_contact_id,
    ghl_opportunity_id: row.ghl_opportunity_id,
    property_address: row.property_address || '(no address)',
    ...result,
    ghl_custom_fields,
    baserow_update,
  },
}];`;

const BASEROW_TABLE_ID = '764';
const GHL_LOCATION_ID = 'fPnzZjzdvxzEGdkhdQ0e';
const GHL_PIPELINE_ID = 'MXHfKwSzSiKSSDfkajSO';

const RESOLVE_STAGE_JS = `const PIPELINE_ID = '${GHL_PIPELINE_ID}';
const STAGE_NAME_PATTERN = /pre[\\s_-]*loi/i;

const pipelines = $input.first().json.pipelines || [];
const pipeline = pipelines.find((p) => p.id === PIPELINE_ID);
if (!pipeline) {
  throw new Error('GHL pipeline ' + PIPELINE_ID + ' not found for this location');
}

const stages = pipeline.stages || [];
const stage = stages.find((s) => STAGE_NAME_PATTERN.test(s.name || ''));
if (!stage) {
  throw new Error(
    'No Pre-LOI stage in pipeline "' + pipeline.name + '". Stages present: ' +
    stages.map((s) => s.name).join(', ')
  );
}

return [{ json: { pipeline_id: pipeline.id, stage_id: stage.id, stage_name: stage.name } }];`;

const sampleRow = {
  id: 42,
  ghl_contact_id: 'ghl-contact-123',
  ghl_opportunity_id: 'ghl-opp-456',
  property_address: '456 Mid Ave, Baton Rouge LA',
  property_type: { id: 1, value: 'SFR', color: 'blue' },
  arv: '180000.00',
  repairs: '30000.00',
  contract_price: '95000.00',
  confidence: { id: 2, value: 'High', color: 'green' },
  status: { id: 3, value: 'Ready', color: 'yellow' },
  decision_makers: 'Marie Boudreaux',
  transcript_text: 'pasted transcript',
};

const baserowWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Baserow Webhook (rows.updated)',
    parameters: {
      httpMethod: 'POST',
      path: 'offer-engine-sfr',
      responseMode: 'onReceived',
      options: {},
    },
    position: [-816, 0],
  },
  output: [{ body: { table_id: 100, event_type: 'rows.updated', items: [{ id: 42 }] } }],
});

const getWorksheetRow = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Get Worksheet Row',
    parameters: {
      method: 'GET',
      url: expr('https://baserow.dfn8n.xyz/api/database/rows/table/' + BASEROW_TABLE_ID + '/{{ $json.body.items[0].id }}/?user_field_names=true'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {},
    },
    credentials: { httpHeaderAuth: newCredential('Baserow Database Token') },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    position: [-592, 0],
  },
  output: [sampleRow],
});

const checkStatusReady = ifElse({
  version: 2.3,
  config: {
    name: 'Status Is Ready?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        combinator: 'and',
        conditions: [
          {
            id: 'status-is-ready',
            leftValue: expr('{{ $json.status && $json.status.value ? $json.status.value : $json.status }}'),
            rightValue: 'Ready',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
      },
      options: {},
    },
    position: [-368, 0],
  },
});

const guardInputs = ifElse({
  version: 2.3,
  config: {
    name: 'Guard: ARV, Repairs, GHL IDs',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        combinator: 'and',
        conditions: [
          {
            id: 'arv-positive',
            leftValue: expr('{{ Number($json.arv) || 0 }}'),
            rightValue: 0,
            operator: { type: 'number', operation: 'gt' },
          },
          {
            id: 'repairs-positive',
            leftValue: expr('{{ Number($json.repairs) || 0 }}'),
            rightValue: 0,
            operator: { type: 'number', operation: 'gt' },
          },
          {
            id: 'contact-id-present',
            leftValue: expr('{{ $json.ghl_contact_id }}'),
            rightValue: '',
            operator: { type: 'string', operation: 'notEmpty', singleValue: true },
          },
          {
            id: 'opportunity-id-present',
            leftValue: expr('{{ $json.ghl_opportunity_id }}'),
            rightValue: '',
            operator: { type: 'string', operation: 'notEmpty', singleValue: true },
          },
        ],
      },
      options: {},
    },
    position: [-144, 0],
  },
});

const telegramHaltAlert = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Telegram: Halt Alert',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: placeholder('Team Telegram chat ID (ask @get_id_bot)'),
      text: expr(
        '⛔ OFFER ENGINE HALT — worksheet row {{ $json.id }}\n' +
        'Address: {{ $json.property_address || "(none)" }}\n' +
        'ARV: {{ $json.arv || "MISSING" }} | Repairs: {{ $json.repairs || "MISSING" }}\n' +
        'GHL contact: {{ $json.ghl_contact_id || "MISSING" }} | GHL opportunity: {{ $json.ghl_opportunity_id || "MISSING" }}\n' +
        'No offer was computed or written. Fix the worksheet row and set status back to Ready.'
      ),
      additionalFields: { appendAttribution: false },
    },
    credentials: { telegramApi: newCredential('Jarvis772 Telegram Bot') },
    position: [80, 208],
  },
  output: [{ ok: true, result: { message_id: 1001 } }],
});

const underwriteCode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Underwrite',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: UNDERWRITE_JS },
    position: [80, -96],
  },
  output: [{
    row_id: 42,
    ghl_contact_id: 'ghl-contact-123',
    ghl_opportunity_id: 'ghl-opp-456',
    property_address: '456 Mid Ave, Baton Rouge LA',
    arv: 180000,
    repairs: 30000,
    contract_price: 95000,
    property_type: 'SFR',
    arv_minus_repairs: 150000,
    factor_used: 0.78,
    new_mao: 107000,
    uw_spread: 12000,
    uw_ratio: 0.5278,
    jv_opportunity_value: null,
    confidence: 'High',
    uw_reason: 'NEW MAO $107,000 = (ARV $180,000 − Repairs $30,000 = $150,000) × 0.78 − $10,000 fee | type SFR | spread $12,000 / ratio 52.8%',
    offer_note: 'OFFER — 456 Mid Ave, Baton Rouge LA ...',
    seller_draft: 'Hey Marie — ran your numbers on 456 Mid Ave ...',
    telegram_summary: '🏠 UNDERWRITTEN — 456 Mid Ave ...',
    computed_at: '2026-08-07T12:00:00.000Z',
    ghl_custom_fields: [{ key: 'new_mao', field_value: 107000 }],
    baserow_update: { new_mao: 107000, status: 'Underwritten' },
  }],
});

const ghlUpdateOpportunity = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GHL: Update Opportunity Fields',
    parameters: {
      method: 'PUT',
      url: expr('https://services.leadconnectorhq.com/opportunities/{{ $json.ghl_opportunity_id }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-07-28' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ customFields: $json.ghl_custom_fields }) }}'),
      options: {},
    },
    credentials: { httpHeaderAuth: newCredential('GHL API (LeadConnector)') },
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 5000,
    position: [304, -96],
  },
  output: [{ succeeded: true }],
});

const ghlCreateNote = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GHL: Create Offer Note',
    parameters: {
      method: 'POST',
      url: expr("https://services.leadconnectorhq.com/contacts/{{ $('Underwrite').item.json.ghl_contact_id }}/notes"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-07-28' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr("{{ JSON.stringify({ body: $('Underwrite').item.json.offer_note }) }}"),
      options: {},
    },
    credentials: { httpHeaderAuth: newCredential('GHL API (LeadConnector)') },
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 5000,
    position: [528, -96],
  },
  output: [{ id: 'note-1' }],
});

const baserowWriteback = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Baserow: Write Audit + Underwritten',
    parameters: {
      method: 'PATCH',
      url: expr("https://baserow.dfn8n.xyz/api/database/rows/table/" + BASEROW_TABLE_ID + "/{{ $('Underwrite').item.json.row_id }}/?user_field_names=true"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr("{{ JSON.stringify($('Underwrite').item.json.baserow_update) }}"),
      options: {},
    },
    credentials: { httpHeaderAuth: newCredential('Baserow Database Token') },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    position: [752, -96],
  },
  output: [{ id: 42, status: { value: 'Underwritten' } }],
});

const ghlFetchPipelines = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GHL: Fetch Pipeline Stages',
    parameters: {
      method: 'GET',
      url: 'https://services.leadconnectorhq.com/opportunities/pipelines',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-07-28' }] },
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'locationId', value: GHL_LOCATION_ID }] },
      options: {},
    },
    credentials: { httpHeaderAuth: newCredential('GHL API (LeadConnector)') },
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 5000,
    position: [976, -96],
  },
  output: [{ pipelines: [{ id: 'MXHfKwSzSiKSSDfkajSO', name: 'Wholesale', stages: [{ id: 'stage-1', name: 'Pre-LOI Ready' }] }] }],
});

const resolvePreLoiStage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Pre-LOI Stage',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: RESOLVE_STAGE_JS },
    position: [1200, -96],
  },
  output: [{ pipeline_id: 'MXHfKwSzSiKSSDfkajSO', stage_id: 'stage-1', stage_name: 'Pre-LOI Ready' }],
});

const ghlUpdateStage = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GHL: Stage → Pre-LOI Ready',
    parameters: {
      method: 'PUT',
      url: expr("https://services.leadconnectorhq.com/opportunities/{{ $('Underwrite').item.json.ghl_opportunity_id }}"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Version', value: '2021-07-28' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ pipelineId: $json.pipeline_id, pipelineStageId: $json.stage_id }) }}'),
      options: {},
    },
    credentials: { httpHeaderAuth: newCredential('GHL API (LeadConnector)') },
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 5000,
    position: [1424, -96],
  },
  output: [{ succeeded: true }],
});

const telegramTeamSummary = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Telegram: Team Summary',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: placeholder('Team Telegram chat ID (ask @get_id_bot)'),
      text: expr("{{ $('Underwrite').item.json.telegram_summary }}"),
      additionalFields: { appendAttribution: false },
    },
    credentials: { telegramApi: newCredential('Jarvis772 Telegram Bot') },
    position: [1648, -96],
  },
  output: [{ ok: true, result: { message_id: 1002 } }],
});

const overviewSticky = sticky(
  '## WF-OFFER-ENGINE-SFR\n' +
  'Baserow worksheet (status=Ready) → deterministic MAO → GHL + Baserow writeback → Telegram.\n\n' +
  '**Code computes the offer. No LLM anywhere in this workflow.**\n\n' +
  'Wired: Baserow table 764 | GHL location fPnzZjzdvxzEGdkhdQ0e | pipeline MXHfKwSzSiKSSDfkajSO.\n' +
  'The Pre-LOI stage ID is resolved by name at run time, so no stage ID to paste.\n\n' +
  'Still to do (see repo docs/setup-notes.md):\n' +
  '1. Set the chat ID on both Telegram nodes.\n' +
  '2. Wire credentials: Baserow database token + GHL bearer (HTTP Header Auth).\n' +
  '3. Fix the Baserow webhook: method POST, event "Rows are updated",\n' +
  '   URL https://dfn8n.xyz/webhook/offer-engine-sfr\n\n' +
  'seller_draft is written to a review field — NEVER auto-sent to the seller.',
  [baserowWebhook, getWorksheetRow],
);

export default workflow('wf-offer-engine-sfr', 'WF-OFFER-ENGINE-SFR')
  .add(baserowWebhook)
  .to(getWorksheetRow)
  .to(checkStatusReady
    .onTrue(guardInputs
      .onTrue(underwriteCode
        .to(ghlUpdateOpportunity
          .to(ghlCreateNote
            .to(baserowWriteback
              .to(ghlFetchPipelines
                .to(resolvePreLoiStage
                  .to(ghlUpdateStage
                    .to(telegramTeamSummary))))))))
      .onFalse(telegramHaltAlert)))
  .add(overviewSticky);
