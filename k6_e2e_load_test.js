/**
 * ============================================================
 *  K6 END-TO-END LOAD TEST
 *  Activity Upload & Extraction API — Happy Flow Only
 * ============================================================
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'https://u3w2iq9qbd.execute-api.us-east-1.amazonaws.com';
const PROFILE = __ENV.K6_PROFILE || 'load';
const LOG_HTTP = __ENV.LOG_HTTP === 'true';
const POLL_TIMEOUT_MS = Number(__ENV.POLL_TIMEOUT_MS || 180000);
const POLL_INTERVAL_MS = Number(__ENV.POLL_INTERVAL_MS || 10000);

const PROFILES = {
  smoke: { stages: [{ duration: '1m', target: 1 }, { duration: '1m', target: 1 }] },
  load: { stages: [{ duration: '5m', target: 10 }, { duration: '5m', target: 50 }, { duration: '30m', target: 50 }, { duration: '5m', target: 0 }] },
  peak: { stages: [{ duration: '5m', target: 50 }, { duration: '5m', target: 100 }, { duration: '5m', target: 200 }, { duration: '45m', target: 200 }, { duration: '10m', target: 0 }] },
  stress: { stages: [{ duration: '5m', target: 200 }, { duration: '5m', target: 300 }, { duration: '5m', target: 400 }, { duration: '5m', target: 500 }, { duration: '10m', target: 500 }, { duration: '5m', target: 0 }] },
  soak: { stages: [{ duration: '5m', target: 50 }, { duration: '10m', target: 100 }, { duration: '7h', target: 100 }, { duration: '10m', target: 0 }] },
};

if (!PROFILES[PROFILE]) {
  throw new Error(`Invalid K6_PROFILE='${PROFILE}'. Supported values: ${Object.keys(PROFILES).join(', ')}`);
}

export const options = {
  stages: PROFILES[PROFILE].stages,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  tags: { testProfile: PROFILE, testSuite: 'career-api-e2e' },
};

const RESUME_PDF = open('testdata/Alex_Johnson_QA_Resume.pdf', 'b');

function jsonHeaders() {
  return { 'Content-Type': 'application/json', Accept: 'application/json' };
}

function safeJson(res) {
  try {
    if (!res || !res.body) return {};
    const parsed = JSON.parse(res.body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function logReqRes(label, reqBody, res) {
  if (!LOG_HTTP) return;
  const reqLog = reqBody !== null && typeof reqBody === 'object' ? '[multipart/form-data payload]' : reqBody;
  const body = res.body || '[empty body]';
  const resLog = body.length > 500 ? `${body.substring(0, 500)}... [truncated]` : body;

  console.log(`\n[${label}] VU=${__VU} ITER=${__ITER}\n  STATUS : ${res.status}\n  REQ    : ${reqLog}\n  RES    : ${resLog}`);
}

function waitForSuccess(label, apiFn, timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const res = apiFn();
    if (res.status === 200) return res;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    sleep(Math.min(intervalMs, remaining) / 1000);
  }

  console.error(`[${label}] TIMEOUT after ${timeoutMs / 1000}s.`);
  return null;
}

function generateUserId() {
  const ts = Date.now().toString(16).padStart(12, '0');
  const vu = __VU.toString(16).padStart(4, '0');
  const itr = __ITER.toString(16).padStart(4, '0');
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-${vu}-${itr}-000000000000`;
}

function executeStep({ name, endpoint, payload, validations, transformBody, formPayload = false }) {
  const requestBody = formPayload ? payload : JSON.stringify(payload);
  const response = waitForSuccess(name, () => {
    const res = http.post(`${BASE_URL}${endpoint}`, requestBody, formPayload ? { headers: { Accept: 'application/json' } } : { headers: jsonHeaders() });
    logReqRes(name, requestBody, res);
    return res;
  });

  if (!response) return { ok: false, body: {} };

  const body = safeJson(response);
  const ok = check(response, validations(body));
  if (ok && transformBody) transformBody(body);

  return { ok, body };
}

export function setup() {
  const warmup = http.post(`${BASE_URL}/activity/presign`, JSON.stringify({ file_name: 'Alex_Johnson_QA_Resume.pdf' }), { headers: jsonHeaders() });
  if (warmup.status !== 200) {
    throw new Error(`[SETUP] API unreachable — /activity/presign returned ${warmup.status}`);
  }
  return { startTime: Date.now() };
}

export default function () {
  const userId = __ENV.USER_ID || generateUserId();
  const state = { userId, assessmentId: null, objectKey: null, uploadUrl: null, clusterId: null, simulationId: null };

  group('Step 0: Assessment Creation', () => {
    const { ok, body } = executeStep({
      name: 'Step 0: Assessment Creation', endpoint: '/user/assessment_creation', payload: { user_id: userId },
      validations: (b) => ({ 'assessment_creation -> 200': (r) => r.status === 200, 'assessment_creation -> assessment_id': () => b.assessment_id !== undefined }),
    });
    if (ok) state.assessmentId = body.assessment_id;
  });
  if (!state.assessmentId) return;

  sleep(randomIntBetween(1, 2));

  group('Step 1: Activity Presign', () => {
    const { ok, body } = executeStep({
      name: 'Step 1: Activity Presign', endpoint: '/activity/presign', payload: { file_name: 'Alex_Johnson_QA_Resume.pdf' },
      validations: (b) => ({ presign_200: (r) => r.status === 200, has_upload_url: () => typeof b.upload_url === 'string', has_object_key: () => typeof b.object_key === 'string' }),
    });
    if (ok) { state.uploadUrl = body.upload_url; state.objectKey = body.object_key; }
  });
  if (!state.uploadUrl || !state.objectKey) return;

  group('Step 2: Activity Upload', () => {
    const formData = { upload_url: state.uploadUrl, object_key: state.objectKey, file: http.file(RESUME_PDF, 'Alex_Johnson_QA_Resume.pdf', 'application/pdf') };
    const { ok, body } = executeStep({
      name: 'Step 2: Activity Upload', endpoint: '/activity/upload', payload: formData, formPayload: true,
      validations: (b) => ({ upload_200: (r) => r.status === 200, has_view_url: () => typeof b.view_url === 'string', has_object_key: () => typeof b.object_key === 'string' }),
    });
    if (ok && body.object_key) state.objectKey = body.object_key;
  });

  state.clusterId = randomIntBetween(100, 999);
  state.simulationId = state.assessmentId;

  const followupSteps = [
    { label: 'Step 3: AI Activity Extract', endpoint: '/extract', payload: () => ({ assessment_id: state.assessmentId, object_key: state.objectKey }) },
    { label: 'Step 4: Quiz Generate', endpoint: '/user/quiz-generate', payload: () => ({ assessment_id: state.assessmentId }) },
    { label: 'Step 5: Init Recommend', endpoint: '/user/init-recommend', payload: () => ({ assessment_id: state.assessmentId }) },
    { label: 'Step 6: Simulation Create', endpoint: '/user/simulation-create', payload: () => ({ assessment_id: state.assessmentId, cluster_id: state.clusterId }) },
    { label: 'Step 7: Simulation Evaluation', endpoint: '/user/simulation-evaluation', payload: () => ({ assessment_id: state.assessmentId, simulation_id: state.simulationId, cluster_id: state.clusterId }) },
    { label: 'Step 8: Revise Recommend', endpoint: '/user/revise-recommend', payload: () => ({ assessment_id: state.assessmentId, revise_reason: 'User requested alternative career path' }) },
    { label: 'Step 9: Dashboard Recommend', endpoint: '/user/dash-recommend', payload: () => ({ assessment_id: state.assessmentId, user_id: state.userId }) },
  ];

  for (const step of followupSteps) {
    let ok = false;
    group(step.label, () => {
      const result = executeStep({
        name: step.label,
        endpoint: step.endpoint,
        payload: step.payload(),
        validations: () => ({ [`${step.endpoint} -> 200`]: (r) => r.status === 200 }),
      });
      ok = result.ok;
    });

    if (!ok) return;
  }

  sleep(randomIntBetween(3, 7));
}

export function teardown(data) {
  const durationMin = ((Date.now() - data.startTime) / 1000 / 60).toFixed(1);
  console.log(`Test Complete | Profile=${PROFILE} | Duration=${durationMin} minutes`);
}
