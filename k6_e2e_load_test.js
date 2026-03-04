/**
 * ============================================================
 *  K6 END-TO-END LOAD TEST
 *  Activity Upload & Extraction API — Happy Flow Only
 * ============================================================
 *  Author  : Performance Engineering Team
 *  Version : 3.0
 *  Date    : March 2026
 *
 *  Test Data : testdata/Alex_Johnson_QA_Resume.pdf (real binary, loaded via open())
 *
 *  Workflow (all APIs in order):
 *    Step 0  — Assessment Creation      POST /user/assessment_creation
 *    Step 1  — Activity Presign         POST /activity/presign
 *    Step 2  — Activity Upload          POST /activity/upload
 *    Step 3  — AI Extract               POST /extract
 *    Step 4  — Quiz Generate            POST /user/quiz-generate
 *    Step 5  — Init Recommend           POST /user/init-recommend
 *    Step 6  — Simulation Create        POST /user/simulation-create
 *    Step 7  — Simulation Evaluation    POST /user/simulation-evaluation
 *    Step 8  — Revise Recommend         POST /user/revise-recommend
 *    Step 9  — Dashboard Recommend      POST /user/dash-recommend
 *
 *  Usage:
 *    k6 run k6_e2e_load_test.js
 *    K6_PROFILE=smoke BASE_URL=https://api.example.com k6 run k6_e2e_load_test.js
 *    K6_PROFILE=load  BASE_URL=https://api.example.com k6 run k6_e2e_load_test.js
 *
 *  Notes:
 *    - Run from the project root (where testdata/ folder lives)
 *    - /user/simulation-create does not return simulation_id in its response body
 *      (spec gap). simulation_id is derived from assessment_id for now.
 * ============================================================
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ─────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL   || 'https://u3w2iq9qbd.execute-api.us-east-1.amazonaws.com';
const PROFILE  = __ENV.K6_PROFILE || 'load';

// ─────────────────────────────────────────────────────────────
//  TEST PROFILES
// ─────────────────────────────────────────────────────────────
const PROFILES = {
  smoke: {
    stages: [
      { duration: '1m', target: 1 },
      { duration: '1m', target: 1 },
    ],
  },
  load: {
    stages: [
      { duration: '5m',  target: 10 },
      { duration: '5m',  target: 50 },
      { duration: '30m', target: 50 },
      { duration: '5m',  target: 0  },
    ],
  },
  peak: {
    stages: [
      { duration: '5m',  target: 50  },
      { duration: '5m',  target: 100 },
      { duration: '5m',  target: 200 },
      { duration: '45m', target: 200 },
      { duration: '10m', target: 0   },
    ],
  },
  stress: {
    stages: [
      { duration: '5m',  target: 200 },
      { duration: '5m',  target: 300 },
      { duration: '5m',  target: 400 },
      { duration: '5m',  target: 500 },
      { duration: '10m', target: 500 },
      { duration: '5m',  target: 0   },
    ],
  },
  soak: {
    stages: [
      { duration: '5m',  target: 50  },
      { duration: '10m', target: 100 },
      { duration: '7h',  target: 100 },
      { duration: '10m', target: 0   },
    ],
  },
};

const activeProfile = PROFILES[PROFILE] || PROFILES['load'];

export const options = {
  stages:            activeProfile.stages,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  tags: {
    testProfile: PROFILE,
    testSuite:   'career-api-e2e',
  },
};

// ─────────────────────────────────────────────────────────────
//  TEST DATA
//  Real PDF binary loaded once at init — shared across all VUs.
//  Must be run from project root (the folder containing testdata/).
// ─────────────────────────────────────────────────────────────
const RESUME_PDF = open('testdata/Alex_Johnson_QA_Resume.pdf', 'b');

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };
}

/**
 * Safe JSON parse — returns {} on failure; never throws.
 */
function safeJson(res) {
  try {
    if (!res || !res.body) return {};
    const parsed = JSON.parse(res.body);
    return (parsed !== null && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Retries an API call every POLL_INTERVAL_MS until it returns HTTP 200,
 * or until TIMEOUT_MS is exceeded — whichever comes first.
 *
 * @param {string}   label       - Step label for logging
 * @param {Function} apiFn       - Function that makes the http.post call and returns the response
 * @param {number}   timeoutMs   - Max wait time in ms (default 180000 = 3 min)
 * @param {number}   intervalMs  - Polling interval in ms (default 10000 = 10 sec)
 * @returns {object|null}        - Final response object, or null on timeout
 */
/**
 * Logs request body and response (status + body) for every API call.
 * For multipart/form-data (binary file payloads) the request body is
 * replaced with a human-readable placeholder.
 */
function logReqRes(label, reqBody, res) {
  const isFormData = reqBody !== null && typeof reqBody === 'object';
  const reqLog     = isFormData
    ? '[multipart/form-data — binary file payload]'
    : reqBody;

  const resLog = res.body
    ? (res.body.length > 500 ? res.body.substring(0, 500) + '... [truncated]' : res.body)
    : '[empty body]';

  console.log(
    `\n[${label}] VU=${__VU} ITER=${__ITER}` +
    `\n  STATUS : ${res.status}` +
    `\n  REQ    : ${reqLog}` +
    `\n  RES    : ${resLog}`
  );
}

function waitForSuccess(label, apiFn, timeoutMs = 180000, intervalMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let attempt    = 0;

  while (Date.now() < deadline) {
    attempt++;
    const res = apiFn();

    console.log(
      `[${label}] attempt=${attempt}` +
      ` elapsed=${((Date.now() - (deadline - timeoutMs)) / 1000).toFixed(0)}s` +
      ` status=${res.status}`
    );

    if (res.status === 200) {
      return res;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // Sleep for poll interval (or remaining time — whichever is shorter)
    sleep(Math.min(intervalMs, remaining) / 1000);
  }

  console.error(
    `[${label}] TIMEOUT — did not return 200 within ${timeoutMs / 1000}s` +
    ` after ${attempt} attempt(s). Failing iteration.`
  );
  return null;
}

/**
 * UUID-like user_id per spec example format:
 *   "550e8400-e29b-41d4-a716-446655440017"
 * Unique per VU + iteration to avoid cross-VU DB collisions.
 */
function generateUserId() {
  const ts  = Date.now().toString(16).padStart(12, '0');
  const vu  = __VU.toString(16).padStart(4, '0');
  const itr = __ITER.toString(16).padStart(4, '0');
  return `${ts.slice(0,8)}-${ts.slice(8,12)}-${vu}-${itr}-000000000000`;
}

// ─────────────────────────────────────────────────────────────
//  SETUP — runs once before ramp-up; aborts on failure
// ─────────────────────────────────────────────────────────────
export function setup() {
  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║   K6 E2E Load Test — Career API (Happy Flow)               ║
  ║   Profile  : ${PROFILE.padEnd(44)}║
  ║   Base URL : ${BASE_URL.substring(0, 44).padEnd(44)}║
  ╚══════════════════════════════════════════════════════════════╝
  `);

  // Connectivity check — fail fast before committing VUs
  const warmup = http.post(
    `${BASE_URL}/activity/presign`,
    JSON.stringify({ file_name: 'Alex_Johnson_QA_Resume.pdf' }),
    { headers: jsonHeaders() }
  );

  if (warmup.status !== 200) {
    throw new Error(`[SETUP] API unreachable — /activity/presign returned ${warmup.status}`);
  }

  console.log('[SETUP] Connectivity confirmed. Starting profile: ' + PROFILE);
  return { startTime: Date.now() };
}

// ─────────────────────────────────────────────────────────────
//  MAIN VU FUNCTION
// ─────────────────────────────────────────────────────────────
export default function () {
  const userId = __ENV.USER_ID || generateUserId();

  let assessmentId = null;
  let objectKey    = null;
  let uploadUrl    = null;
  let clusterId    = null;
  let simulationId = null;

  // ── Step 0: Assessment Creation ──────────────────────────────
  // Creates a new assessment for the user; returns assessment_id
  // that flows through every subsequent step.
  group('Step 0: Assessment Creation', () => {
    const reqBody = JSON.stringify({ user_id: userId });
    const res     = http.post(
      `${BASE_URL}/user/assessment_creation`,
      reqBody,
      { headers: jsonHeaders() }
    );
    logReqRes('Step 0: Assessment Creation', reqBody, res);
    const body = safeJson(res);

    check(res, {
      '[/user/assessment_creation] Create new assessment -> 200':        (r) => r.status === 200,
      '[/user/assessment_creation] Create new assessment -> assessment_id': ()  => body.assessment_id !== undefined,
      '[/user/assessment_creation] Create new assessment -> message':    ()  => typeof body.message === 'string',
    });

    if (res.status === 200 && body.assessment_id !== undefined) {
      assessmentId = body.assessment_id;
    }
  });

  // assessment_id is required by all downstream steps
  if (!assessmentId) {
    console.warn(`[VU ${__VU} ITER ${__ITER}] Step 0 failed — aborting iteration`);
    return;
  }

  sleep(randomIntBetween(1, 2));

  // ── Step 1: Activity Presign ─────────────────────────────────
  // Returns upload_url (presigned S3 URL) and object_key for upload.
  group('Step 1: Activity Presign', () => {
    const reqBody = JSON.stringify({ file_name: 'Alex_Johnson_QA_Resume.pdf' });
    const res     = http.post(
      `${BASE_URL}/activity/presign`,
      reqBody,
      { headers: jsonHeaders() }
    );
    logReqRes('Step 1: Activity Presign', reqBody, res);
    const body = safeJson(res);

    check(res, {
      '[/activity/presign] Generate S3 presigned URL -> 200':            (r) => r.status === 200,
      '[/activity/presign] Generate S3 presigned URL -> upload_url':     ()  => typeof body.upload_url === 'string' && body.upload_url.length > 0,
      '[/activity/presign] Generate S3 presigned URL -> object_key':     ()  => typeof body.object_key === 'string' && body.object_key.length > 0,
    });

    if (res.status === 200) {
      uploadUrl = body.upload_url;
      objectKey = body.object_key;
    }
  });

  if (!uploadUrl || !objectKey) {
    console.warn(`[VU ${__VU} ITER ${__ITER}] Step 1 (Presign) failed — aborting iteration`);
    return;
  }

  sleep(randomIntBetween(1, 2));

  // ── Step 2: Activity Upload ──────────────────────────────────
  // Uploads the PDF using the presigned URL from Step 1.
  // Returns view_url and confirmed object_key.
  group('Step 2: Activity Upload', () => {
    const formData = {
      upload_url: uploadUrl,
      object_key: objectKey,
      file:       http.file(RESUME_PDF, 'Alex_Johnson_QA_Resume.pdf', 'application/pdf'),
    };

    const res  = http.post(
      `${BASE_URL}/activity/upload`,
      formData,
      { headers: { 'Accept': 'application/json' } }
    );
    logReqRes('Step 2: Activity Upload', formData, res);
    const body = safeJson(res);

    check(res, {
      '[/activity/upload] Upload a file using presigned URL -> 200':         (r) => r.status === 200,
      '[/activity/upload] Upload a file using presigned URL -> view_url':    ()  => typeof body.view_url === 'string' && body.view_url.length > 0,
      '[/activity/upload] Upload a file using presigned URL -> object_key':  ()  => typeof body.object_key === 'string' && body.object_key.length > 0,
    });

    // Use the confirmed object_key from the response (backend may normalise it)
    if (res.status === 200 && body.object_key) {
      objectKey = body.object_key;
    }
  });

  sleep(randomIntBetween(1, 2));

  // ── Step 3: AI Activity Extract ──────────────────────────────
  // Async queue trigger — retries every 10s for up to 3 min until 200.
  let extractOk = false;
  group('Step 3: AI Activity Extract', () => {
    const reqBody = JSON.stringify({
      assessment_id: assessmentId,
      object_key:    objectKey,
    });

    const res = waitForSuccess('Step 3: AI Activity Extract', () => {
      const r = http.post(`${BASE_URL}/extract`, reqBody, { headers: jsonHeaders() });
      logReqRes('Step 3: AI Activity Extract', reqBody, r);
      return r;
    });

    if (!res) return;

    const body = safeJson(res);
    extractOk = check(res, {
      '[/extract] AI extraction of activities -> 200':             (r) => r.status === 200,
      '[/extract] AI extraction of activities -> message':         ()  => typeof body.message === 'string',
      '[/extract] AI extraction of activities -> assessment_id':   ()  => body.assessment_id !== undefined,
    });
  });

  if (!extractOk) {
    console.error(`[VU ${__VU} ITER ${__ITER}] Step 3 (Extract) timed out after 3 min — aborting iteration`);
    return;
  }

  // ── Step 4: Quiz Generate ────────────────────────────────────
  // Retries every 10s for up to 3 min until 200.
  let quizOk = false;
  group('Step 4: Quiz Generate', () => {
    const reqBody = JSON.stringify({ assessment_id: assessmentId });

    const res = waitForSuccess('Step 4: Quiz Generate', () => {
      const r = http.post(`${BASE_URL}/user/quiz-generate`, reqBody, { headers: jsonHeaders() });
      logReqRes('Step 4: Quiz Generate', reqBody, r);
      return r;
    });

    if (!res) return;

    const body = safeJson(res);
    quizOk = check(res, {
      '[/user/quiz-generate] Generate quiz question set -> 200':     (r) => r.status === 200,
      '[/user/quiz-generate] Generate quiz question set -> quiz_id': ()  => body.quiz_id !== undefined,
      '[/user/quiz-generate] Generate quiz question set -> message': ()  => typeof body.message === 'string',
    });
  });

  if (!quizOk) {
    console.error(`[VU ${__VU} ITER ${__ITER}] Step 4 (Quiz Generate) timed out after 3 min — aborting iteration`);
    return;
  }

  // ── Step 5: Init Recommend ───────────────────────────────────
  // Retries every 10s for up to 3 min until 200.
  let initRecOk = false;
  group('Step 5: Init Recommend', () => {
    const reqBody = JSON.stringify({ assessment_id: assessmentId });

    const res = waitForSuccess('Step 5: Init Recommend', () => {
      const r = http.post(`${BASE_URL}/user/init-recommend`, reqBody, { headers: jsonHeaders() });
      logReqRes('Step 5: Init Recommend', reqBody, r);
      return r;
    });

    if (!res) return;

    const body = safeJson(res);
    initRecOk = check(res, {
      '[/user/init-recommend] Trigger initial recommendations -> 200':     (r) => r.status === 200,
      '[/user/init-recommend] Trigger initial recommendations -> message': ()  => typeof body.message === 'string',
    });
  });

  if (!initRecOk) {
    console.error(`[VU ${__VU} ITER ${__ITER}] Step 5 (Init Recommend) timed out after 3 min — aborting iteration`);
    return;
  }

  // ── Step 6: Simulation Create ────────────────────────────────
  // NOTE: Response body does not include simulation_id (spec gap).
  //       simulation_id for Step 7 is derived from assessment_id until the API
  //       is updated to return it.
  // Retries every 10s for up to 3 min until 200.
  clusterId = randomIntBetween(100, 999);
  let simCreateOk = false;
  group('Step 6: Simulation Create', () => {
    const reqBody = JSON.stringify({
      assessment_id: assessmentId,
      cluster_id:    clusterId,
    });

    const res = waitForSuccess('Step 6: Simulation Create', () => {
      const r = http.post(`${BASE_URL}/user/simulation-create`, reqBody, { headers: jsonHeaders() });
      logReqRes('Step 6: Simulation Create', reqBody, r);
      return r;
    });

    if (!res) return;

    const body = safeJson(res);
    simCreateOk = check(res, {
      '[/user/simulation-create] Create new simulation -> 200':     (r) => r.status === 200,
      '[/user/simulation-create] Create new simulation -> message': ()  => typeof body.message === 'string',
    });
  });

  if (!simCreateOk) {
    console.error(`[VU ${__VU} ITER ${__ITER}] Step 6 (Simulation Create) timed out after 3 min — aborting iteration`);
    return;
  }

  // ── Step 7: Simulation Evaluation ───────────────────────────
  // spec gap workaround — update when API returns simulation_id
  // Retries every 10s for up to 3 min until 200.
  simulationId = assessmentId;
  let simEvalOk = false;
  group('Step 7: Simulation Evaluation', () => {
    const reqBody = JSON.stringify({
      assessment_id: assessmentId,
      simulation_id: simulationId,
      cluster_id:    clusterId,
    });

    const res = waitForSuccess('Step 7: Simulation Evaluation', () => {
      const r = http.post(`${BASE_URL}/user/simulation-evaluation`, reqBody, { headers: jsonHeaders() });
      logReqRes('Step 7: Simulation Evaluation', reqBody, r);
      return r;
    });

    if (!res) return;

    const body = safeJson(res);
    simEvalOk = check(res, {
      '[/user/simulation-evaluation] Queue simulation evaluation -> 200':     (r) => r.status === 200,
      '[/user/simulation-evaluation] Queue simulation evaluation -> message': ()  => typeof body.message === 'string',
    });
  });

  if (!simEvalOk) {
    console.error(`[VU ${__VU} ITER ${__ITER}] Step 7 (Simulation Evaluation) timed out after 3 min — aborting iteration`);
    return;
  }

  // ── Step 8: Revise Recommend ─────────────────────────────────
  // Retries every 10s for up to 3 min until 200.
  let reviseOk = false;
  group('Step 8: Revise Recommend', () => {
    const reqBody = JSON.stringify({
      assessment_id: assessmentId,
      revise_reason: 'User requested alternative career path',
    });

    const res = waitForSuccess('Step 8: Revise Recommend', () => {
      const r = http.post(`${BASE_URL}/user/revise-recommend`, reqBody, { headers: jsonHeaders() });
      logReqRes('Step 8: Revise Recommend', reqBody, r);
      return r;
    });

    if (!res) return;

    const body = safeJson(res);
    reviseOk = check(res, {
      '[/user/revise-recommend] Trigger revise recommendations -> 200':     (r) => r.status === 200,
      '[/user/revise-recommend] Trigger revise recommendations -> message': ()  => typeof body.message === 'string',
    });
  });

  if (!reviseOk) {
    console.error(`[VU ${__VU} ITER ${__ITER}] Step 8 (Revise Recommend) timed out after 3 min — aborting iteration`);
    return;
  }

  // ── Step 9: Dashboard Recommend ──────────────────────────────
  // Retries every 10s for up to 3 min until 200.
  let dashOk = false;
  group('Step 9: Dashboard Recommend', () => {
    const reqBody = JSON.stringify({
      assessment_id: assessmentId,
      user_id:       userId,
    });

    const res = waitForSuccess('Step 9: Dashboard Recommend', () => {
      const r = http.post(`${BASE_URL}/user/dash-recommend`, reqBody, { headers: jsonHeaders() });
      logReqRes('Step 9: Dashboard Recommend', reqBody, r);
      return r;
    });

    if (!res) return;

    const body = safeJson(res);
    dashOk = check(res, {
      '[/user/dash-recommend] Trigger dashboard recommendations -> 200':     (r) => r.status === 200,
      '[/user/dash-recommend] Trigger dashboard recommendations -> message': ()  => typeof body.message === 'string',
    });
  });

  if (!dashOk) {
    console.error(`[VU ${__VU} ITER ${__ITER}] Step 9 (Dashboard Recommend) timed out after 3 min — aborting iteration`);
    return;
  }

  // Think time between full workflow iterations
  sleep(randomIntBetween(3, 7));
}

// ─────────────────────────────────────────────────────────────
//  TEARDOWN — runs once after all VUs finish
// ─────────────────────────────────────────────────────────────
export function teardown(data) {
  const durationMin = ((Date.now() - data.startTime) / 1000 / 60).toFixed(1);
  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║   Test Complete                                            ║
  ║   Profile  : ${PROFILE.padEnd(44)}║
  ║   Duration : ${(durationMin + ' minutes').padEnd(44)}║
  ╚══════════════════════════════════════════════════════════════╝
  `);
}
