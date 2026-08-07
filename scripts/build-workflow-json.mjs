// Regenerates workflows/WF-OFFER-ENGINE-SFR.json from src/underwrite.mjs so the
// importable workflow can never drift from the tested math.
//   node scripts/build-workflow-json.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const src = readFileSync(join(root, 'src/underwrite.mjs'), 'utf8');
const syncMatch = src.match(/\/\/ ==== SYNC-START[\s\S]*?\/\/ ==== SYNC-END ====/);
if (!syncMatch) throw new Error('SYNC markers not found in src/underwrite.mjs');

const jsCode = `${syncMatch[0]}

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

const GHL_HEADERS = { parameters: [{ name: 'Version', value: '2021-07-28' }] };

const BASEROW_TABLE_ID = '764';
const GHL_LOCATION_ID = 'fPnzZjzdvxzEGdkhdQ0e';
const GHL_PIPELINE_ID = 'MXHfKwSzSiKSSDfkajSO';
const TELEGRAM_CHAT_ID = '6707585706';

const AUDIT_ROW_JS = `// Emit only the Baserow audit fields so the Baserow node can auto-map
// input keys to columns by name. Any extra key here would be sent as a
// column that does not exist and fail the update.
return [{ json: $('Underwrite').first().json.baserow_update }];`;

// The Pre-LOI stage ID is not exposed in the GHL pipeline URL, so the workflow
// resolves it by name at run time and fails loudly if the stage is missing.
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

const workflow = {
  name: 'WF-OFFER-ENGINE-SFR',
  settings: { executionOrder: 'v1' },
  nodes: [
    {
      id: '8b8e9c63-7f62-4342-956c-242e6e332044',
      name: 'Baserow Webhook (rows.updated)',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: [-816, 0],
      webhookId: 'e55dccc9-aa28-4e06-a08e-fc17a6d465e4',
      parameters: { httpMethod: 'POST', path: 'offer-engine-sfr', responseMode: 'onReceived', options: {} },
    },
    {
      id: 'baa150f9-21b9-4f9b-879a-8cc39bf78760',
      name: 'Get Worksheet Row',
      type: 'n8n-nodes-base.baserow',
      typeVersion: 1.1,
      position: [-592, 0],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      parameters: {
        resource: 'row',
        operation: 'get',
        authentication: 'databaseToken',
        tableId: BASEROW_TABLE_ID,
        rowId: '={{ $json.body.items[0].id }}',
      },
    },
    {
      id: 'b21b1868-a9e0-4224-aeac-47bc7fe7aca7',
      name: 'Status Is Ready?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.3,
      position: [-368, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          combinator: 'and',
          conditions: [
            {
              id: 'status-is-ready',
              leftValue: '={{ $json.status && $json.status.value ? $json.status.value : $json.status }}',
              rightValue: 'Ready',
              operator: { type: 'string', operation: 'equals' },
            },
          ],
        },
        options: {},
      },
    },
    {
      id: '6854d64f-5686-45c0-8ab8-280ad5cd4b26',
      name: 'Guard: ARV, Repairs, GHL IDs',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.3,
      position: [-144, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          combinator: 'and',
          conditions: [
            { id: 'arv-positive', leftValue: '={{ Number($json.arv) || 0 }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } },
            { id: 'repairs-positive', leftValue: '={{ Number($json.repairs) || 0 }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } },
            { id: 'contact-id-present', leftValue: '={{ $json.ghl_contact_id }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
            { id: 'opportunity-id-present', leftValue: '={{ $json.ghl_opportunity_id }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
          ],
        },
        options: {},
      },
    },
    {
      id: 'f250df09-0eb6-4e4e-82a6-4cef47f223cc',
      name: 'Underwrite',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [80, -96],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode },
    },
    {
      id: '6e166df8-187f-42ad-8abb-68df872afb1c',
      name: 'GHL: Update Opportunity Fields',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.4,
      position: [304, -96],
      retryOnFail: true,
      maxTries: 5,
      waitBetweenTries: 5000,
      parameters: {
        method: 'PUT',
        url: '=https://services.leadconnectorhq.com/opportunities/{{ $json.ghl_opportunity_id }}',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendHeaders: true,
        headerParameters: GHL_HEADERS,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ customFields: $json.ghl_custom_fields }) }}',
        options: {},
      },
    },
    {
      id: 'e8537dc0-1f89-4abd-93ef-9d88d16a03e2',
      name: 'GHL: Create Offer Note',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.4,
      position: [528, -96],
      retryOnFail: true,
      maxTries: 5,
      waitBetweenTries: 5000,
      parameters: {
        method: 'POST',
        url: "=https://services.leadconnectorhq.com/contacts/{{ $('Underwrite').item.json.ghl_contact_id }}/notes",
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendHeaders: true,
        headerParameters: GHL_HEADERS,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ body: $('Underwrite').item.json.offer_note }) }}",
        options: {},
      },
    },
    {
      id: 'f81a44c7-9d3e-4b52-8c17-6a2049e3bd11',
      name: 'Build Baserow Audit Row',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [752, -96],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: AUDIT_ROW_JS },
    },
    {
      id: '665337c9-b5b7-4192-a0ff-d1b39dba5c48',
      name: 'Baserow: Write Audit + Underwritten',
      type: 'n8n-nodes-base.baserow',
      typeVersion: 1.1,
      position: [976, -96],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      parameters: {
        resource: 'row',
        operation: 'update',
        authentication: 'databaseToken',
        tableId: BASEROW_TABLE_ID,
        rowId: "={{ $('Underwrite').item.json.row_id }}",
        dataToSend: 'autoMapInputData',
        inputsToIgnore: '',
      },
    },
    {
      id: 'a4c1e2f0-3b77-4a1e-9d2c-7f5b6e8c1a90',
      name: 'GHL: Fetch Pipeline Stages',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.4,
      position: [1200, -96],
      retryOnFail: true,
      maxTries: 5,
      waitBetweenTries: 5000,
      parameters: {
        method: 'GET',
        url: 'https://services.leadconnectorhq.com/opportunities/pipelines',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendHeaders: true,
        headerParameters: GHL_HEADERS,
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'locationId', value: GHL_LOCATION_ID }] },
        options: {},
      },
    },
    {
      id: 'd7f3b9a1-5c48-4e26-b0a3-2e91c4d7f658',
      name: 'Resolve Pre-LOI Stage',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1424, -96],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: RESOLVE_STAGE_JS },
    },
    {
      id: 'c9dde99d-d2c7-4086-a92c-d0fc9ee7ba8b',
      name: 'GHL: Stage → Pre-LOI Ready',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.4,
      position: [1648, -96],
      retryOnFail: true,
      maxTries: 5,
      waitBetweenTries: 5000,
      parameters: {
        method: 'PUT',
        url: "=https://services.leadconnectorhq.com/opportunities/{{ $('Underwrite').item.json.ghl_opportunity_id }}",
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendHeaders: true,
        headerParameters: GHL_HEADERS,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ pipelineId: $json.pipeline_id, pipelineStageId: $json.stage_id }) }}',
        options: {},
      },
    },
    {
      id: '5f290492-d7b4-4add-b9e3-86cf3a0764ea',
      name: 'Telegram: Team Summary',
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [1872, -96],
      webhookId: 'c0f9bdbb-1778-468f-a868-1df275ffbf92',
      parameters: {
        resource: 'message',
        operation: 'sendMessage',
        chatId: TELEGRAM_CHAT_ID,
        text: "={{ $('Underwrite').item.json.telegram_summary }}",
        additionalFields: { appendAttribution: false },
      },
    },
    {
      id: 'b1640dfc-1f16-433c-b324-e25946664eb8',
      name: 'Telegram: Halt Alert',
      type: 'n8n-nodes-base.telegram',
      typeVersion: 1.2,
      position: [80, 208],
      webhookId: 'e6295f39-02c6-42e5-83fb-6e8343c24893',
      parameters: {
        resource: 'message',
        operation: 'sendMessage',
        chatId: TELEGRAM_CHAT_ID,
        text:
          '=⛔ OFFER ENGINE HALT — worksheet row {{ $json.id }}\n' +
          'Address: {{ $json.property_address || "(none)" }}\n' +
          'ARV: {{ $json.arv || "MISSING" }} | Repairs: {{ $json.repairs || "MISSING" }}\n' +
          'GHL contact: {{ $json.ghl_contact_id || "MISSING" }} | GHL opportunity: {{ $json.ghl_opportunity_id || "MISSING" }}\n' +
          'No offer was computed or written. Fix the worksheet row and set status back to Ready.',
        additionalFields: { appendAttribution: false },
      },
    },
    {
      id: '2d51332d-4959-45de-8148-46cc503d2705',
      name: 'Sticky Note',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-866, -50],
      parameters: {
        content:
          '## WF-OFFER-ENGINE-SFR\n' +
          'Baserow worksheet (status=Ready) → deterministic MAO → GHL + Baserow writeback → Telegram.\n\n' +
          '**Code computes the offer. No LLM anywhere in this workflow.**\n\n' +
          'Wired: Baserow table 764 | GHL location fPnzZjzdvxzEGdkhdQ0e | pipeline MXHfKwSzSiKSSDfkajSO.\n' +
          'Telegram chat 6707585706 (@STL_Offer_bot). Pre-LOI stage resolved by name at run time.\n\n' +
          'Still to do (see repo docs/setup-notes.md):\n' +
          '1. Select the GHL Bearer header-auth credential on the four GHL HTTP nodes.\n' +
          '2. Fix the Baserow webhook: method POST, event "Rows are updated",\n' +
          '   URL https://dfn8n.xyz/webhook/offer-engine-sfr\n\n' +
          'seller_draft is written to a review field — NEVER auto-sent to the seller.',
        width: 524,
        height: 200,
      },
    },
  ],
  connections: {
    'Baserow Webhook (rows.updated)': { main: [[{ node: 'Get Worksheet Row', type: 'main', index: 0 }]] },
    'Get Worksheet Row': { main: [[{ node: 'Status Is Ready?', type: 'main', index: 0 }]] },
    'Status Is Ready?': { main: [[{ node: 'Guard: ARV, Repairs, GHL IDs', type: 'main', index: 0 }]] },
    'Guard: ARV, Repairs, GHL IDs': {
      main: [
        [{ node: 'Underwrite', type: 'main', index: 0 }],
        [{ node: 'Telegram: Halt Alert', type: 'main', index: 0 }],
      ],
    },
    'Underwrite': { main: [[{ node: 'GHL: Update Opportunity Fields', type: 'main', index: 0 }]] },
    'GHL: Update Opportunity Fields': { main: [[{ node: 'GHL: Create Offer Note', type: 'main', index: 0 }]] },
    'GHL: Create Offer Note': { main: [[{ node: 'Build Baserow Audit Row', type: 'main', index: 0 }]] },
    'Build Baserow Audit Row': { main: [[{ node: 'Baserow: Write Audit + Underwritten', type: 'main', index: 0 }]] },
    'Baserow: Write Audit + Underwritten': { main: [[{ node: 'GHL: Fetch Pipeline Stages', type: 'main', index: 0 }]] },
    'GHL: Fetch Pipeline Stages': { main: [[{ node: 'Resolve Pre-LOI Stage', type: 'main', index: 0 }]] },
    'Resolve Pre-LOI Stage': { main: [[{ node: 'GHL: Stage → Pre-LOI Ready', type: 'main', index: 0 }]] },
    'GHL: Stage → Pre-LOI Ready': { main: [[{ node: 'Telegram: Team Summary', type: 'main', index: 0 }]] },
  },
};

mkdirSync(join(root, 'workflows'), { recursive: true });
const outPath = join(root, 'workflows/WF-OFFER-ENGINE-SFR.json');
writeFileSync(outPath, JSON.stringify(workflow, null, 2) + '\n');
console.log('wrote ' + outPath);
