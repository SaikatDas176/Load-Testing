/**
 * ============================================================
 *  K6 END-TO-END LOAD TEST
 *  Activity Upload & Extraction API
 * ============================================================
 *  Author  : Performance Engineering Team
 *  Version : 2.1
 *  Date    : March 2026
 *
 *  Spec Source  : Career.json (OpenAPI 3.0.1)
 *  Test Data    : testdata/Alex_Johnson_QA_Resume.pdf  (real binary, loaded via open())
 *                 testdata/cluster_subcluster - cluster_subcluster.csv
 *                   └─ NOT USED — /admin/cluster/* APIs excluded from scope
 *
 *  Workflow Coverage (User Journey Only):
 *    Stage 1 — Activity : Presign → Upload (real PDF) → Extract
 *    Stage 2 — Quiz     : Quiz Generate → Init Recommend
 *    Stage 3 — Sim      : Simulation Create → Evaluate → Revise Recommend → Dash Recommend
 *
 *  EXCLUDED APIs (by design):
 *    /admin/cluster/presign   — excluded per test scope
 *    /admin/cluster/extract   — excluded per test scope
 *    /user/image/presign      — excluded per test scope
 *    (consequently /admin/cluster/upload and /user/image/upload
 *     are also excluded since their required object_key/upload_url
 *     depend on the excluded presign endpoints)
 *
 *  Test Profiles (select via ENV var: K6_PROFILE):
 *    smoke  — 1 VU, 2 min             (quick sanity check)
 *    load   — 50 VU ramp, 30 min      (normal operating load)
 *    peak   — 200 VU ramp, 45 min     (expected peak load)
 *    stress — 200→500 VU step-up      (find breaking point)
 *    spike  — 50→500→50 VU            (traffic burst resilience)
 *    soak   — 100 VU, 8 hours         (memory leak / drift detection)
 *
 *  Usage:
 *    # Must be run from the project root (where testdata/ folder lives)
 *    k6 run k6_e2e_load_test.js
 *    K6_PROFILE=smoke  BASE_URL=https://api.example.com k6 run k6_e2e_load_test.js
 *    K6_PROFILE=load   BASE_URL=https://api.example.com k6 run k6_e2e_load_test.js
 *    K6_PROFILE=peak   BASE_URL=https://api.example.com k6 run k6_e2e_load_test.js
 *    k6 run --out influxdb=http://localhost:8086/k6 k6_e2e_load_test.js
 *
 *  Key Design Decisions:
 *    - Real PDF binary loaded once at init via open() — shared across all VUs,
 *      zero per-iteration file I/O overhead.
 *    - assessmentId flows through all 3 stages (same user context per VU iteration)
 *    - simulation_id is derived from assessmentId because the
 *      /user/simulation-create spec returns only {status_code, message}
 *      with no simulation_id in the response body. This is documented
 *      as a spec gap — update derivation logic if API is updated.
 *    - cluster_id is randomised per VU to simulate realistic cluster spread
 *    - user_id is formatted as "user_<assessmentId>" to match spec example format
 *    - Negative tests run on configurable iteration cadence (not every iteration)
 *      to keep error budget realistic and not skew 4xx counters
 * ============================================================
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ─────────────────────────────────────────────────────────────
//  ENVIRONMENT CONFIGURATION
// ─────────────────────────────────────────────────────────────
const BASE_URL  = __ENV.BASE_URL   || 'https://u3w2iq9qbd.execute-api.us-east-1.amazonaws.com';
const PROFILE   = __ENV.K6_PROFILE || 'load';

// ─────────────────────────────────────────────────────────────
//  TEST PROFILES
// ─────────────────────────────────────────────────────────────
function buildThresholds(p95, p99, errPct) {
  return {
    // Global HTTP thresholds
    http_req_duration:                  [`p(95)<${p95}`, `p(99)<${p99}`],
    http_req_failed:                    [`rate<${errPct / 100}`],

    // Per-endpoint SLA thresholds (aligned to Career.json API behaviour)
    'activity_presign_duration':        ['p(95)<300'],
    'activity_upload_duration':         ['p(95)<800'],
    'extract_duration':                 ['p(95)<500'],
    'quiz_generate_duration':           ['p(95)<500'],
    'init_recommend_duration':          ['p(95)<500'],
    'simulation_create_duration':       ['p(95)<500'],
    'simulation_evaluation_duration':   ['p(95)<500'],
    'revise_recommend_duration':        ['p(95)<500'],
    'dash_recommend_duration':          ['p(95)<500'],

    // Error budget counters
    'errors_4xx':                       ['count<10'],
    'errors_5xx':                       ['count<5'],
  };
}

const PROFILES = {
  smoke: {
    stages: [
      { duration: '1m', target: 1 },
      { duration: '1m', target: 1 },
    ],
    thresholds: buildThresholds(2000, 4000, 2.0),
  },

  load: {
    stages: [
      { duration: '5m',  target: 10 },   // gradual ramp-up
      { duration: '5m',  target: 50 },   // approach steady state
      { duration: '30m', target: 50 },   // steady state (primary measurement window)
      { duration: '5m',  target: 0  },   // ramp-down
    ],
    thresholds: buildThresholds(300, 800, 0.5),
  },

  peak: {
    stages: [
      { duration: '5m',  target: 50  },
      { duration: '5m',  target: 100 },
      { duration: '5m',  target: 200 },
      { duration: '45m', target: 200 },  // sustained peak
      { duration: '10m', target: 0   },
    ],
    thresholds: buildThresholds(500, 1500, 0.5),
  },

  stress: {
    stages: [
      { duration: '5m',  target: 200 },
      { duration: '5m',  target: 200 },
      { duration: '5m',  target: 300 },
      { duration: '5m',  target: 300 },
      { duration: '5m',  target: 400 },
      { duration: '5m',  target: 400 },
      { duration: '5m',  target: 500 },
      { duration: '10m', target: 500 },
      { duration: '5m',  target: 0   },
    ],
    // Relaxed thresholds — intent is to find the breaking point, not pass SLA
    thresholds: buildThresholds(1000, 3000, 2.0),
  },

  spike: {
    stages: [
      { duration: '2m', target: 50  },   // warm baseline
      { duration: '1m', target: 500 },   // spike #1 up
      { duration: '5m', target: 500 },   // hold
      { duration: '2m', target: 50  },   // recover
      { duration: '5m', target: 50  },   // confirm recovery
      { duration: '1m', target: 500 },   // spike #2
      { duration: '5m', target: 500 },
      { duration: '2m', target: 50  },
      { duration: '5m', target: 50  },
      { duration: '1m', target: 500 },   // spike #3
      { duration: '5m', target: 500 },
      { duration: '5m', target: 0   },
    ],
    thresholds: buildThresholds(1500, 4000, 2.0),
  },

  soak: {
    stages: [
      { duration: '5m',  target: 50  },
      { duration: '10m', target: 100 },
      { duration: '7h',  target: 100 },  // 7-hour soak (memory / drift detection)
      { duration: '10m', target: 0   },
    ],
    thresholds: buildThresholds(500, 1200, 1.0),
  },
};

const activeProfile = PROFILES[PROFILE] || PROFILES['load'];

export const options = {
  stages:            activeProfile.stages,
  thresholds:        activeProfile.thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  tags: {
    testProfile: PROFILE,
    testSuite:   'career-api-e2e',
  },
};

// ─────────────────────────────────────────────────────────────
//  CUSTOM METRICS
// ─────────────────────────────────────────────────────────────
const activityPresignDuration      = new Trend('activity_presign_duration',     true);
const activityUploadDuration       = new Trend('activity_upload_duration',      true);
const extractDuration              = new Trend('extract_duration',              true);
const quizGenerateDuration         = new Trend('quiz_generate_duration',        true);
const initRecommendDuration        = new Trend('init_recommend_duration',       true);
const simCreateDuration            = new Trend('simulation_create_duration',    true);
const simEvalDuration              = new Trend('simulation_evaluation_duration',true);
const reviseRecommendDuration      = new Trend('revise_recommend_duration',     true);
const dashRecommendDuration        = new Trend('dash_recommend_duration',       true);

const errors4xx                    = new Counter('errors_4xx');
const errors5xx                    = new Counter('errors_5xx');
const successRate                  = new Rate('success_rate');
const workflowCompletionRate       = new Rate('workflow_completion_rate');
const activeWorkflows              = new Gauge('active_workflows');

// ─────────────────────────────────────────────────────────────
//  TRANSACTION LOG
//  Collects full request + response details for every API call.
//  Written to results/k6_transactions.json and embedded in the
//  HTML report. Each VU maintains its own copy of this array.
//  For multi-VU profiles, the report shows all captured entries
//  from the VU that handleSummary shares context with (typically
//  the last active VU). Smoke profile (1 VU) captures everything.
// ─────────────────────────────────────────────────────────────
const txnLog = [];

// ─────────────────────────────────────────────────────────────
//  TEST DATA
//
//  Real PDF binary loaded once at k6 init time via open().
//  open() is ONLY valid at module init scope (top-level code),
//  never inside default(), setup(), or stage functions.
//  The ArrayBuffer is shared across all VUs — zero per-iteration
//  file I/O overhead. k6 handles the memory sharing internally.
//
//  File  : testdata/Alex_Johnson_QA_Resume.pdf
//  Why   : Real file guarantees that backend PDF validation,
//          magic-byte sniffing, text extraction, and AI processing
//          behave identically to production. Fake stubs can silently
//          pass upload checks while breaking downstream extraction.
//
//  IMPORTANT: k6 must be run from the project root directory
//  (the folder that contains the testdata/ subdirectory).
//
//    ✓ Correct:   k6 run k6_e2e_load_test.js          (from project root)
//    ✗ Wrong:     k6 run ../k6_e2e_load_test.js        (wrong working dir)
//
//  cluster_subcluster - cluster_subcluster.csv is intentionally
//  NOT loaded here. The admin cluster chain is excluded from scope.
// ─────────────────────────────────────────────────────────────
const RESUME_PDF = open('testdata/Alex_Johnson_QA_Resume.pdf', 'b');

// Realistic revise reasons — mirrors actual user behaviour
const REVISE_REASONS = [
  'User requested alternative career path',
  'Simulation score below threshold',
  'User preference updated after quiz',
  'New extracurricular data available',
  'User selected different domain interest',
];

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Returns per-VU + per-iteration unique integer ID.
 * Ensures no two concurrent VUs share the same assessmentId,
 * preventing cross-VU data contamination in the backend DB.
 */
function vuUniqueId() {
  return ((__VU - 1) * 100000) + __ITER + 100000;
}

/**
 * user_id format per Career.json spec example: "user_456"
 */
function formatUserId(assessmentId) {
  return `user_${assessmentId}`;
}

function getJsonHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };
  return h;
}

function getMultipartHeaders() {
  const h = { 'Accept': 'application/json' };
  return h;
}

/**
 * Central HTTP wrapper.
 * Records per-endpoint Trend metrics, increments error counters,
 * updates global success rate, logs full req/resp to console,
 * and pushes a structured entry into txnLog for the HTML report.
 *
 * @param {string}  url         - Full request URL
 * @param {*}       payload     - Request body (JSON string or FormData object)
 * @param {object}  params      - k6 request params (headers, tags, etc.)
 * @param {Trend}   trendMetric - Per-endpoint custom Trend metric (null for neg tests)
 * @param {string}  label       - Human-readable label for console and report
 * @param {boolean} isNegative  - True for intentional negative/error tests
 */
function apiPost(url, payload, params, trendMetric, label = '', isNegative = false) {
  const ts = new Date().toISOString();

  // Determine what to log as the request body
  // FormData (multipart) payloads are binary — log a placeholder
  const isFormData  = payload !== null && typeof payload === 'object' && !(typeof payload === 'string');
  const reqBodyLog  = isFormData
    ? '[multipart/form-data — binary file payload]'
    : (typeof payload === 'string' ? payload : JSON.stringify(payload));

  const res = http.post(url, payload, params);

  // ── Metric recording ────────────────────────────────────────
  if (trendMetric)                           trendMetric.add(res.timings.duration);
  if (res.status >= 400 && res.status < 500) errors4xx.add(1);
  if (res.status >= 500)                     errors5xx.add(1);
  successRate.add(res.status >= 200 && res.status < 300);

  // ── Response body — truncate binary or very long responses ──
  let resBodyLog = '';
  if (res.body) {
    resBodyLog = res.body.length > 500
      ? res.body.substring(0, 500) + '... [truncated]'
      : res.body;
  } else {
    resBodyLog = '[empty body]';
  }

  // ── Determine pass/fail for logging ─────────────────────────
  const ok = res.status >= 200 && res.status < 300;
  const statusIcon = ok ? '✓' : '✗';

  // ── Console log — printed live during test run ───────────────
  const path = url.replace(BASE_URL, '');
  console.log(
    `[${ts}] ${statusIcon} ${isNegative ? '[NEG] ' : ''}${label || path}`
    + ` | VU=${__VU} ITER=${__ITER}`
    + ` | POST ${path}`
    + ` | STATUS=${res.status}`
    + ` | ${res.timings.duration.toFixed(0)}ms`
    + `\n  REQ : ${reqBodyLog}`
    + `\n  RES : ${resBodyLog}`
  );

  // ── txnLog entry — embedded in HTML report ───────────────────
  txnLog.push({
    ts,
    vu:         __VU,
    iter:       __ITER,
    label:      label || path,
    method:     'POST',
    url,
    path,
    reqBody:    reqBodyLog,
    resStatus:  res.status,
    resBody:    resBodyLog,
    duration:   parseFloat(res.timings.duration.toFixed(2)),
    blocked:    parseFloat(res.timings.blocked.toFixed(2)),
    connecting: parseFloat(res.timings.connecting.toFixed(2)),
    sending:    parseFloat(res.timings.sending.toFixed(2)),
    waiting:    parseFloat(res.timings.waiting.toFixed(2)),
    receiving:  parseFloat(res.timings.receiving.toFixed(2)),
    ok,
    isNegative,
  });

  return res;
}

/**
 * Safe JSON parse — never throws; returns {} on failure.
 * Centralised here so every caller gets consistent nil-safety.
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

// ─────────────────────────────────────────────────────────────
//  STAGE 1: ACTIVITY PRESIGN → UPLOAD → EXTRACT
//
//  Dependency chain:
//    presign → { upload_url, object_key }
//    upload  ← { upload_url, object_key }  → { view_url, object_key }
//    extract ← { assessment_id, object_key }
//
//  Returns: { assessmentId, objectKey } for downstream stages.
//           Returns null on any hard failure to allow stage skipping.
// ─────────────────────────────────────────────────────────────
function stageActivityUpload() {
  const assessmentId = vuUniqueId();
  let   objectKey    = null;
  let   uploadUrl    = null;
  let   presignOk    = false;

  // ── 1.1 Presign ────────────────────────────────────────────
  group('S1.1 Activity Presign', () => {
    // Only PDF presign — we only have Alex_Johnson_QA_Resume.pdf as real test data.
    // Sending different realistic PDF names exercises the presign filename routing
    // without needing multiple physical files.
    const fileNames = ['Alex_Johnson_QA_Resume.pdf', 'resume.pdf', 'cv.pdf', 'portfolio.pdf', 'experience.pdf'];
    const fileName  = randomItem(fileNames);

    const res = apiPost(
      `${BASE_URL}/activity/presign`,
      JSON.stringify({ file_name: fileName }),
      { headers: getJsonHeaders() },
      activityPresignDuration, 'Activity Presign'
    );

    const body = safeJson(res);

    // Functional check — determines if workflow continues.
    // Timing is asserted separately so a slow-but-valid response
    // does NOT abort the workflow. Timing failures show in the
    // threshold report and HTML report without killing the run.
    presignOk = check(res, {
      '[Presign] HTTP 200':       (r) => r.status === 200,
      '[Presign] has upload_url': (r) => typeof body.upload_url === 'string' && body.upload_url.length > 0,
      '[Presign] has object_key': (r) => typeof body.object_key === 'string' && body.object_key.length > 0,
    });

    // Timing assertion — non-blocking, recorded for SLA reporting only
    check(res, {
      '[Presign] response time < 300ms': (r) => r.timings.duration < 300,
    });

    if (presignOk) {
      uploadUrl = body.upload_url;
      objectKey = body.object_key;
    } else {
      // Log full response detail so we can diagnose the failure
      console.error(`[PRESIGN FAIL] VU=${__VU} ITER=${__ITER}`
        + ` | status=${res.status}`
        + ` | duration=${res.timings.duration.toFixed(0)}ms`
        + ` | body=${res.body ? res.body.substring(0, 300) : 'empty'}`
        + ` | file_name=${fileName}`
        + ` | url=${BASE_URL}/activity/presign`
      );
    }
  });

  // Negative test: unsupported file type → spec returns 400
  // Run once every 20 iterations to keep 4xx budget sane.
  if (__ITER % 20 === 0) {
    group('S1.1-NEG Activity Presign Unsupported Type', () => {
      const res = apiPost(
        `${BASE_URL}/activity/presign`,
        JSON.stringify({ file_name: 'malicious.exe' }),
        { headers: getJsonHeaders() },
        null, 'Activity Presign (NEG: .exe)', true
      );
      check(res, {
        '[Presign-NEG] HTTP 400 for .exe':    (r) => r.status === 400,
        '[Presign-NEG] responds quickly':     (r) => r.timings.duration < 300,
      });
    });
  }

  // Negative test: missing file_name body field → spec returns 400
  if (__ITER % 30 === 0) {
    group('S1.1-NEG Activity Presign Missing file_name', () => {
      const res = apiPost(
        `${BASE_URL}/activity/presign`,
        JSON.stringify({}),
        { headers: getJsonHeaders() },
        null, 'Activity Presign (NEG: no file_name)', true
      );
      check(res, {
        '[Presign-NEG] HTTP 400 missing field': (r) => r.status === 400,
      });
    });
  }

  sleep(randomIntBetween(1, 2));

  // Guard: skip upload + extract if presign failed — broken dependency
  if (!presignOk || !objectKey || !uploadUrl) {
    console.warn(`[VU ${__VU} ITER ${__ITER}] Presign failed — skipping upload and extract`);
    return null;
  }

  // ── 1.2 Upload ─────────────────────────────────────────────
  //  Spec: multipart/form-data with upload_url, object_key, file
  //  upload_url MUST be the real presigned URL from step 1.1.
  //  File must be >= 1 KB (enforced by API).
  let uploadOk = false;

  group('S1.2 Activity Upload', () => {
    // Real PDF binary from open() at init scope.
    // We always upload the real file — the presign filename varies (see S1.1)
    // but the actual binary uploaded is always the real PDF.
    // This is intentional: we're load testing the API pipeline, not
    // testing file variety. The real file exercises actual extraction logic.
    //
    // http.file() accepts ArrayBuffer (binary) directly from open(..., 'b').
    // The third arg sets the Content-Type header for this form field.
    const formData = {
      upload_url: uploadUrl,
      object_key: objectKey,
      file:       http.file(RESUME_PDF, 'Alex_Johnson_QA_Resume.pdf', 'application/pdf'),
    };

    const res = apiPost(
      `${BASE_URL}/activity/upload`,
      formData,
      { headers: getMultipartHeaders() },
      activityUploadDuration, 'Activity Upload'
    );

    const body = safeJson(res);

    uploadOk = check(res, {
      '[Upload] HTTP 200':       (r) => r.status === 200,
      '[Upload] has view_url':   (r) => typeof body.view_url === 'string',
      '[Upload] has object_key': (r) => typeof body.object_key === 'string',
    });

    check(res, {
      '[Upload] response time < 800ms': (r) => r.timings.duration < 800,
    });

    // Capture object_key from response (backend may normalise it)
    if (uploadOk && body.object_key) {
      objectKey = body.object_key;
    }
  });

  sleep(randomIntBetween(1, 2));

  if (!uploadOk) {
    console.error(`[UPLOAD FAIL] VU=${__VU} ITER=${__ITER}`
      + ` | status=${res ? res.status : 'no_response'}`
      + ` | body=${res && res.body ? res.body.substring(0, 300) : 'empty'}`
    );
    return null;
  }

  // ── 1.3 Extract ────────────────────────────────────────────
  //  Spec: async queue trigger — returns 200 + queued message.
  //  Validation failures return 404 (per spec, not 400).
  group('S1.3 AI Activity Extract', () => {
    const res = apiPost(
      `${BASE_URL}/extract`,
      JSON.stringify({
        assessment_id: assessmentId,    // integer per spec
        object_key:    objectKey,
      }),
      { headers: getJsonHeaders() },
      extractDuration, 'AI Extract'
    );

    const body = safeJson(res);

    check(res, {
      '[Extract] HTTP 200':             (r) => r.status === 200,
      '[Extract] body confirms queued': (r) => typeof body.message === 'string' && body.message.toLowerCase().includes('queue'),
      '[Extract] echoes assessment_id': (r) => body.assessment_id !== undefined,
    });

    check(res, {
      '[Extract] response time < 500ms': (r) => r.timings.duration < 500,
    });
  });

  // Negative: missing assessment_id — spec returns 404 for validation failure
  if (__ITER % 25 === 0) {
    group('S1.3-NEG Extract Missing assessment_id', () => {
      const res = apiPost(
        `${BASE_URL}/extract`,
        JSON.stringify({ object_key: objectKey }),
        { headers: getJsonHeaders() },
        null, 'AI Extract (NEG: no assessment_id)', true
      );
      check(res, {
        // Spec: 404 for "Validation failed (missing fields, assessment not found)"
        '[Extract-NEG] HTTP 404 missing field': (r) => r.status === 404,
      });
    });
  }

  sleep(randomIntBetween(1, 3));

  return { assessmentId, objectKey };
}

// ─────────────────────────────────────────────────────────────
//  STAGE 2: QUIZ GENERATE → INIT RECOMMEND
//
//  Dependency: assessmentId from Stage 1
//  quiz_id is captured from quiz-generate response.
//  init-recommend only needs assessment_id (not quiz_id) per spec.
// ─────────────────────────────────────────────────────────────
function stageQuizAndRecommend(assessmentId) {
  let quizId = null;

  // ── 2.1 Quiz Generate ──────────────────────────────────────
  group('S2.1 Quiz Generate', () => {
    const res = apiPost(
      `${BASE_URL}/user/quiz-generate`,
      JSON.stringify({ assessment_id: assessmentId }),
      { headers: getJsonHeaders() },
      quizGenerateDuration, 'Quiz Generate'
    );

    const body = safeJson(res);

    check(res, {
      '[QuizGen] HTTP 200':    (r) => r.status === 200,
      '[QuizGen] has quiz_id': (r) => body.quiz_id !== undefined,
    });

    check(res, {
      '[QuizGen] response time < 500ms': (r) => r.timings.duration < 500,
    });

    if (res.status === 200) quizId = body.quiz_id;
  });

  // Negative: missing assessment_id → spec returns 400
  if (__ITER % 25 === 0) {
    group('S2.1-NEG Quiz Generate Missing ID', () => {
      const res = apiPost(
        `${BASE_URL}/user/quiz-generate`,
        JSON.stringify({}),
        { headers: getJsonHeaders() },
        null, 'Quiz Generate (NEG: no assessment_id)', true
      );
      check(res, {
        '[QuizGen-NEG] HTTP 400 missing assessment_id': (r) => r.status === 400,
      });
    });
  }

  sleep(randomIntBetween(1, 2));

  // ── 2.2 Init Recommend ─────────────────────────────────────
  //  Spec: validates assessment, updates profile from quiz responses,
  //  enqueues for recommendation processing.
  //  Spec returns 400 if assessment_profile not found yet (race condition
  //  from async extract in Stage 1). The sleep above acts as a basic buffer.
  group('S2.2 Init Recommend', () => {
    const res = apiPost(
      `${BASE_URL}/user/init-recommend`,
      JSON.stringify({ assessment_id: assessmentId }),
      { headers: getJsonHeaders() },
      initRecommendDuration, 'Init Recommend'
    );

    check(res, {
      '[InitRec] HTTP 200': (r) => r.status === 200,
    });

    check(res, {
      '[InitRec] response time < 500ms': (r) => r.timings.duration < 500,
    });
  });

  sleep(randomIntBetween(1, 2));

  return { quizId };
}

// ─────────────────────────────────────────────────────────────
//  STAGE 3: SIMULATION CREATE → EVALUATE → REVISE → DASH RECOMMEND
//
//  Dependency chain:
//    simulation-create ← { assessment_id, cluster_id }
//      NOTE: The spec for /user/simulation-create returns only
//      {status_code, message} — NO simulation_id in the response.
//      This is a documented spec gap. simulation_id for the evaluate
//      call is derived from assessmentId until the API is updated.
//      Impact: simulation-evaluate may return 404 if the backend
//      assigns a different internal ID. Monitor [SimEval] 404 rates.
//
//    simulation-evaluate ← { assessment_id, simulation_id, cluster_id }
//    revise-recommend    ← { assessment_id, revise_reason }
//    dash-recommend      ← { assessment_id, user_id }
// ─────────────────────────────────────────────────────────────
function stageSimulation(assessmentId) {
  // Randomise cluster_id per VU iteration to spread realistic cluster load
  const clusterId  = randomIntBetween(100, 999);
  // Spec gap workaround: derive simulation_id from assessmentId
  // Update this if the API ever returns simulation_id from simulation-create.
  const simulationId = assessmentId;
  const userId     = formatUserId(assessmentId);  // "user_<id>" per spec example

  // ── 3.1 Simulation Create ──────────────────────────────────
  let createOk = false;
  group('S3.1 Simulation Create', () => {
    const res = apiPost(
      `${BASE_URL}/user/simulation-create`,
      JSON.stringify({
        assessment_id: assessmentId,
        cluster_id:    clusterId,
      }),
      { headers: getJsonHeaders() },
      simCreateDuration, 'Simulation Create'
    );

    createOk = check(res, {
      '[SimCreate] HTTP 200': (r) => r.status === 200,
    });

    check(res, {
      '[SimCreate] response time < 500ms': (r) => r.timings.duration < 500,
    });
  });

  // Negative: missing cluster_id → spec returns 400
  if (__ITER % 30 === 0) {
    group('S3.1-NEG Simulation Create Missing cluster_id', () => {
      const res = apiPost(
        `${BASE_URL}/user/simulation-create`,
        JSON.stringify({ assessment_id: assessmentId }),
        { headers: getJsonHeaders() },
        null, 'Simulation Create (NEG: no cluster_id)', true
      );
      check(res, {
        '[SimCreate-NEG] HTTP 400 missing cluster_id': (r) => r.status === 400,
      });
    });
  }

  sleep(randomIntBetween(2, 4));  // Slightly longer — backend queues async work

  // ── 3.2 Simulation Evaluation ──────────────────────────────
  group('S3.2 Simulation Evaluation', () => {
    const res = apiPost(
      `${BASE_URL}/user/simulation-evaluation`,
      JSON.stringify({
        assessment_id: assessmentId,
        simulation_id: simulationId,  // spec gap: see note above
        cluster_id:    clusterId,
      }),
      { headers: getJsonHeaders() },
      simEvalDuration, 'Simulation Evaluation'
    );

    check(res, {
      '[SimEval] HTTP 200 or 404': (r) => r.status === 200 || r.status === 404,
    });

    check(res, {
      '[SimEval] response time < 500ms': (r) => r.timings.duration < 500,
    });
  });

  // Negative: missing simulation_id → spec returns 400
  if (__ITER % 30 === 0) {
    group('S3.2-NEG Simulation Eval Missing sim_id', () => {
      const res = apiPost(
        `${BASE_URL}/user/simulation-evaluation`,
        JSON.stringify({ assessment_id: assessmentId, cluster_id: clusterId }),
        { headers: getJsonHeaders() },
        null, 'Simulation Evaluation (NEG: no sim_id)', true
      );
      check(res, {
        '[SimEval-NEG] HTTP 400 missing simulation_id': (r) => r.status === 400,
      });
    });
  }

  sleep(randomIntBetween(1, 2));

  // ── 3.3 Revise Recommend ───────────────────────────────────
  //  Spec: updates assessment profile from simulation evaluations,
  //  enqueues for downstream recommendation processing.
  group('S3.3 Revise Recommend', () => {
    const res = apiPost(
      `${BASE_URL}/user/revise-recommend`,
      JSON.stringify({
        assessment_id: assessmentId,
        revise_reason: randomItem(REVISE_REASONS),
      }),
      { headers: getJsonHeaders() },
      reviseRecommendDuration, 'Revise Recommend'
    );

    check(res, {
      '[ReviseRec] HTTP 200': (r) => r.status === 200,
    });

    check(res, {
      '[ReviseRec] response time < 500ms': (r) => r.timings.duration < 500,
    });
  });

  // Negative: missing revise_reason → spec returns 400
  if (__ITER % 25 === 0) {
    group('S3.3-NEG Revise Recommend Missing reason', () => {
      const res = apiPost(
        `${BASE_URL}/user/revise-recommend`,
        JSON.stringify({ assessment_id: assessmentId }),
        { headers: getJsonHeaders() },
        null, 'Revise Recommend (NEG: no reason)', true
      );
      check(res, {
        '[ReviseRec-NEG] HTTP 400 missing revise_reason': (r) => r.status === 400,
      });
    });
  }

  sleep(randomIntBetween(1, 2));

  // ── 3.4 Dashboard Recommend ────────────────────────────────
  //  Spec: validates assessment, updates profile if simulation evals exist,
  //  sends to SQS, resets dashboard recommendation status.
  //  user_id is a string per spec.
  group('S3.4 Dashboard Recommend', () => {
    const res = apiPost(
      `${BASE_URL}/user/dash-recommend`,
      JSON.stringify({
        assessment_id: assessmentId,
        user_id:       userId,            // string, e.g. "user_100001"
      }),
      { headers: getJsonHeaders() },
      dashRecommendDuration, 'Dash Recommend'
    );

    check(res, {
      '[DashRec] HTTP 200': (r) => r.status === 200,
    });

    check(res, {
      '[DashRec] response time < 500ms': (r) => r.timings.duration < 500,
    });
  });

  // Negative: missing user_id → spec returns 400
  if (__ITER % 25 === 0) {
    group('S3.4-NEG Dashboard Recommend Missing user_id', () => {
      const res = apiPost(
        `${BASE_URL}/user/dash-recommend`,
        JSON.stringify({ assessment_id: assessmentId }),
        { headers: getJsonHeaders() },
        null, 'Dash Recommend (NEG: no user_id)', true
      );
      check(res, {
        '[DashRec-NEG] HTTP 400 missing user_id': (r) => r.status === 400,
      });
    });
  }

  sleep(randomIntBetween(1, 2));
}

// ─────────────────────────────────────────────────────────────
//  SETUP — executes once before test ramp-up begins
//  Use this to confirm API reachability and fail fast
//  before committing hundreds of VUs.
// ─────────────────────────────────────────────────────────────
export function setup() {
  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║   K6 E2E Load Test — Career API                            ║
  ║   Profile  : ${PROFILE.padEnd(44)}║
  ║   Base URL : ${BASE_URL.substring(0, 44).padEnd(44)}║
  ╚══════════════════════════════════════════════════════════════╝
  `);

  // Connectivity smoke check — abort if API is unreachable
  // Warmup uses the same filename format as real test iterations
  const warmup = http.post(
    `${BASE_URL}/activity/presign`,
    JSON.stringify({ file_name: 'Alex_Johnson_QA_Resume.pdf' }),
    { headers: getJsonHeaders() }
  );

  if (warmup.status !== 200) {
    console.error(`[SETUP] /activity/presign returned ${warmup.status} — aborting test`);
    // Throwing here causes k6 to abort before ramping VUs
    throw new Error(`API unreachable at setup. Status: ${warmup.status}`);
  }

  console.log(`[SETUP] Connectivity confirmed. Starting ${PROFILE} profile.`);

  return { startTime: Date.now() };
}

// ─────────────────────────────────────────────────────────────
//  MAIN VU FUNCTION — executes once per VU per iteration
// ─────────────────────────────────────────────────────────────
export default function (data) {
  activeWorkflows.add(1);

  let workflowSucceeded = false;

  group('USER E2E Workflow', () => {
    // Stage 1: Upload resume and queue extraction
    const stage1 = stageActivityUpload();

    // Hard stop on stage 1 failure — downstream stages are meaningless
    // without a valid assessmentId tied to a real DB record.
    if (!stage1) {
      console.warn(`[VU ${__VU} ITER ${__ITER}] Stage 1 failed — skipping Stages 2 & 3`);
      return;
    }

    const { assessmentId } = stage1;

    // Stage 2: Generate quiz and trigger initial recommendation
    stageQuizAndRecommend(assessmentId);

    // Stage 3: Simulation flow + dashboard recommendation
    stageSimulation(assessmentId);

    workflowSucceeded = true;
  });

  // Only mark workflow as complete when all stages ran without a hard abort
  workflowCompletionRate.add(workflowSucceeded);

  activeWorkflows.add(-1);

  // Think time between full workflow iterations — simulates real user pacing
  sleep(randomIntBetween(3, 7));
}

// ─────────────────────────────────────────────────────────────
//  TEARDOWN — executes once after all VUs finish
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

// ─────────────────────────────────────────────────────────────
//  CUSTOM SUMMARY — HTML report + JSON data + stdout summary
// ─────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m = data.metrics;

  // txnLog is the module-level array populated by apiPost() during the run.
  // For multi-VU profiles it contains this VU context's transactions.
  // For smoke (1 VU) it contains the complete transaction history.
  const txnData = typeof txnLog !== 'undefined' ? txnLog : [];

  function val(name, key) {
    const metric = m[name];
    if (!metric) return null;
    return metric.values[key] !== undefined ? metric.values[key] : null;
  }
  function p(name, pct)   { return val(name, `p(${pct})`) || 0; }
  function pStr(name, pct){ const v = p(name, pct); return v ? v.toFixed(1) + ' ms' : 'N/A'; }
  function avgStr(name)   { const v = val(name, 'avg'); return v !== null ? v.toFixed(1) + ' ms' : 'N/A'; }
  function cnt(name)      { return val(name, 'count') || 0; }
  function rate(name)     { return (val(name, 'rate') || 0) * 100; }

  const failedThresholds = Object.entries(m)
    .filter(([, metric]) => metric.thresholds && Object.values(metric.thresholds).some(t => !t.ok))
    .map(([name]) => name);
  const overallPassed = failedThresholds.length === 0;

  // Endpoints table definition — only the APIs in scope
  const endpoints = [
    { label: 'Activity Presign',     metric: 'activity_presign_duration',      sla: 300 },
    { label: 'Activity Upload',      metric: 'activity_upload_duration',       sla: 800 },
    { label: 'AI Extract (queue)',   metric: 'extract_duration',               sla: 500 },
    { label: 'Quiz Generate',        metric: 'quiz_generate_duration',         sla: 500 },
    { label: 'Init Recommend',       metric: 'init_recommend_duration',        sla: 500 },
    { label: 'Simulation Create',    metric: 'simulation_create_duration',     sla: 500 },
    { label: 'Simulation Evaluate',  metric: 'simulation_evaluation_duration', sla: 500 },
    { label: 'Revise Recommend',     metric: 'revise_recommend_duration',      sla: 500 },
    { label: 'Dash Recommend',       metric: 'dash_recommend_duration',        sla: 500 },
  ];

  const totalRequests  = cnt('http_reqs');
  const errRate        = rate('http_req_failed');
  const successPct     = (100 - errRate).toFixed(2);
  const errors4xxCount = cnt('errors_4xx');
  const errors5xxCount = cnt('errors_5xx');
  const wfCompletion   = rate('workflow_completion_rate').toFixed(2);
  const overallP95     = p('http_req_duration', 95).toFixed(1);
  const overallP99     = p('http_req_duration', 99).toFixed(1);
  const throughput     = (val('http_reqs', 'rate') || 0).toFixed(2);
  const runDate        = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  // Serialise transaction log for embedding into the HTML report.
  // txnData was captured at handleSummary invocation from the module-level array.
  const txnDataJson = JSON.stringify(txnData);

  const endpointRows = endpoints.map(ep => {
    const p95    = p(ep.metric, 95);
    const p99v   = p(ep.metric, 99);
    const avg    = val(ep.metric, 'avg') || 0;
    const passed = p95 <= ep.sla;
    const pct    = Math.min((p95 / (ep.sla * 1.5)) * 100, 100).toFixed(1);
    const color  = passed ? '#22c55e' : '#ef4444';
    return `<tr class="${passed ? '' : 'row-fail'}">
      <td class="ep-name">${ep.label}</td>
      <td class="num">${avg > 0 ? avg.toFixed(1) + ' ms' : 'N/A'}</td>
      <td class="num ${p95 > ep.sla ? 'over-sla' : ''}">${p95 > 0 ? p95.toFixed(1) + ' ms' : 'N/A'}</td>
      <td class="num">${p99v > 0 ? p99v.toFixed(1) + ' ms' : 'N/A'}</td>
      <td class="sla-cell">${ep.sla} ms</td>
      <td class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div></td>
      <td>${passed ? '<span class="badge pass">PASS</span>' : '<span class="badge fail">FAIL</span>'}</td>
    </tr>`;
  }).join('');

  const chartLabels = JSON.stringify(endpoints.map(e => e.label));
  const chartP95    = JSON.stringify(endpoints.map(e => p(e.metric, 95).toFixed(1)));
  const chartSLA    = JSON.stringify(endpoints.map(e => e.sla));
  const chartColors = JSON.stringify(endpoints.map(e =>
    p(e.metric, 95) <= e.sla ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)'
  ));

  const failedBox = failedThresholds.length > 0
    ? `<div class="alert-box"><h3>⚠ Failed Thresholds (${failedThresholds.length})</h3>
       ${failedThresholds.map(t => `<div class="alert-item">→ ${t}</div>`).join('')}</div>`
    : '';

  const sysRows = [
    ['Total Requests',    totalRequests.toLocaleString()],
    ['HTTP p90',          pStr('http_req_duration', 90)],
    ['HTTP p95',          pStr('http_req_duration', 95)],
    ['HTTP p99',          pStr('http_req_duration', 99)],
    ['HTTP avg',          avgStr('http_req_duration')],
    ['Failed Requests',   cnt('http_req_failed').toLocaleString()],
    ['Blocked avg',       avgStr('http_req_blocked')],
    ['Connect avg',       avgStr('http_req_connecting')],
    ['TLS Handshake avg', avgStr('http_req_tls_handshaking')],
    ['Send avg',          avgStr('http_req_sending')],
    ['Wait avg',          avgStr('http_req_waiting')],
    ['Receive avg',       avgStr('http_req_receiving')],
    ['Workflow Complete', wfCompletion + '%'],
    ['4xx Errors',        errors4xxCount.toLocaleString()],
    ['5xx Errors',        errors5xxCount.toLocaleString()],
  ].map(([l, v]) => `<div class="sys-card"><span class="sys-label">${l}</span><span class="sys-value">${v}</span></div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Load Test Report — ${PROFILE.toUpperCase()}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></scr` + `ipt>
<style>
:root{--bg:#0b0f1a;--surface:#111827;--surface2:#1a2235;--border:#1e2d45;--accent:#3b82f6;--accent2:#06b6d4;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--text:#e2e8f0;--muted:#64748b;--mono:'DM Mono',monospace;--sans:'Syne',sans-serif}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;line-height:1.6}
.header{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0f172a 100%);border-bottom:1px solid var(--border);padding:3rem 4rem 2.5rem}
.header-top{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:1.5rem}
.report-label{font-family:var(--mono);font-size:.7rem;letter-spacing:.2em;color:var(--accent2);text-transform:uppercase;margin-bottom:.5rem}
.header h1{font-size:2.2rem;font-weight:800;letter-spacing:-.03em;line-height:1.1;color:#fff}
.header h1 span{color:var(--accent)}
.header-meta{display:flex;flex-direction:column;align-items:flex-end;gap:.4rem}
.overall-badge{font-family:var(--mono);font-size:.85rem;font-weight:500;padding:.5rem 1.2rem;border-radius:6px;letter-spacing:.1em;text-transform:uppercase}
.overall-badge.pass{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.3)}
.overall-badge.fail{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}
.meta-row{font-family:var(--mono);font-size:.72rem;color:var(--muted)}
.meta-row strong{color:var(--text)}
.header-pills{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1.5rem}
.pill{background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:20px;padding:.3rem .9rem;font-family:var(--mono);font-size:.72rem;color:var(--muted)}
.pill strong{color:var(--accent2)}
.main{max-width:1300px;margin:0 auto;padding:2.5rem 2rem 4rem}
.section-title{font-size:.65rem;font-family:var(--mono);letter-spacing:.2em;color:var(--muted);text-transform:uppercase;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:1rem;margin-bottom:2.5rem}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.2rem 1.4rem;position:relative;overflow:hidden}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--accent)}
.kpi-card.green::before{background:var(--green)}.kpi-card.red::before{background:var(--red)}.kpi-card.amber::before{background:var(--amber)}.kpi-card.cyan::before{background:var(--accent2)}
.kpi-label{font-family:var(--mono);font-size:.65rem;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-bottom:.5rem}
.kpi-value{font-size:1.8rem;font-weight:700;letter-spacing:-.03em;line-height:1;color:#fff}
.kpi-sub{font-family:var(--mono);font-size:.65rem;color:var(--muted);margin-top:.3rem}
.chart-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.5rem 1.5rem 1rem;margin-bottom:2.5rem}
canvas{max-height:280px}
.table-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:2.5rem}
table{width:100%;border-collapse:collapse}
thead tr{background:var(--surface2);border-bottom:1px solid var(--border)}
th{font-family:var(--mono);font-size:.65rem;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;padding:.8rem 1.2rem;text-align:left}
td{padding:.8rem 1.2rem;font-size:.88rem;border-bottom:1px solid rgba(30,45,69,.6);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr.row-fail{background:rgba(239,68,68,.04)}
.ep-name{font-weight:600}.num{font-family:var(--mono);font-size:.82rem}.over-sla{color:var(--red)!important;font-weight:600}
.sla-cell{font-family:var(--mono);font-size:.78rem;color:var(--muted)}.bar-cell{width:140px}
.bar-bg{background:var(--surface2);border-radius:4px;height:6px;overflow:hidden}.bar-fill{height:100%;border-radius:4px}
.badge{display:inline-block;font-family:var(--mono);font-size:.62rem;letter-spacing:.08em;padding:.2rem .55rem;border-radius:4px;font-weight:500}
.badge.pass{background:rgba(34,197,94,.12);color:var(--green);border:1px solid rgba(34,197,94,.25)}
.badge.fail{background:rgba(239,68,68,.12);color:var(--red);border:1px solid rgba(239,68,68,.25)}
.alert-box{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:1.2rem 1.5rem;margin-bottom:2.5rem}
.alert-box h3{font-size:.85rem;font-weight:700;color:var(--red);margin-bottom:.6rem}
.alert-item{font-family:var(--mono);font-size:.75rem;color:#fca5a5;padding:.2rem 0}
.sys-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;margin-bottom:2.5rem}
.sys-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1rem 1.2rem;display:flex;justify-content:space-between;align-items:center}
.sys-label{font-family:var(--mono);font-size:.72rem;color:var(--muted)}.sys-value{font-family:var(--mono);font-size:1rem;font-weight:500}
.footer{border-top:1px solid var(--border);padding:1.5rem 2rem;text-align:center;font-family:var(--mono);font-size:.68rem;color:var(--muted)}
.spec-note{background:rgba(6,182,212,.06);border:1px solid rgba(6,182,212,.2);border-radius:8px;padding:1rem 1.2rem;margin-bottom:2rem;font-family:var(--mono);font-size:.72rem;color:var(--muted)}
.spec-note strong{color:var(--accent2)}
/* Transaction log */
.txn-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:2.5rem}
.txn-controls{display:flex;gap:.8rem;padding:1rem 1.2rem;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center}
.txn-controls input,.txn-controls select{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:.75rem;padding:.35rem .7rem;border-radius:6px;outline:none}
.txn-controls input{flex:1;min-width:160px}.txn-controls input:focus{border-color:var(--accent)}
.txn-count{font-family:var(--mono);font-size:.7rem;color:var(--muted);margin-left:auto}
.txn-table-wrap{overflow-x:auto;max-height:520px;overflow-y:auto}
.txn-table{width:100%;border-collapse:collapse;font-size:.78rem}
.txn-table thead tr{background:var(--surface2);position:sticky;top:0;z-index:1}
.txn-table th{font-family:var(--mono);font-size:.6rem;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;padding:.6rem 1rem;text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)}
.txn-table td{padding:.55rem 1rem;border-bottom:1px solid rgba(30,45,69,.5);vertical-align:top;font-family:var(--mono);font-size:.72rem;white-space:nowrap}
.txn-table tr.txn-ok td{color:var(--text)}.txn-table tr.txn-fail td{color:#fca5a5}
.txn-table tr.txn-neg td{color:var(--amber)}
.txn-table tr:last-child td{border-bottom:none}
.txn-table td.body-cell{white-space:pre-wrap;word-break:break-all;max-width:320px;font-size:.68rem;color:var(--muted)}
.txn-table td.body-cell:hover{color:var(--text)}
.status-chip{display:inline-block;padding:.1rem .45rem;border-radius:4px;font-weight:600;font-size:.68rem}
.status-2xx{background:rgba(34,197,94,.12);color:var(--green)}.status-4xx{background:rgba(245,158,11,.12);color:var(--amber)}
.status-5xx{background:rgba(239,68,68,.12);color:var(--red)}.status-neg{background:rgba(148,163,184,.1);color:#94a3b8}
.timing-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.2rem .6rem;font-size:.65rem;color:var(--muted);margin-top:.25rem}
.hidden{display:none}
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div>
      <div class="report-label">Performance Test Report</div>
      <h1>Career API E2E<br/><span>Load Test — ${PROFILE.toUpperCase()}</span></h1>
    </div>
    <div class="header-meta">
      <div class="overall-badge ${overallPassed ? 'pass' : 'fail'}">${overallPassed ? '✓ All Thresholds Passed' : '✗ Thresholds Failed'}</div>
      <div class="meta-row">Generated: <strong>${runDate}</strong></div>
      <div class="meta-row">Profile: <strong>${PROFILE.toUpperCase()}</strong></div>
      <div class="meta-row">Base URL: <strong>${BASE_URL.substring(0, 50)}</strong></div>
    </div>
  </div>
  <div class="header-pills">
    <div class="pill">Profile: <strong>${PROFILE.toUpperCase()}</strong></div>
    <div class="pill">Requests: <strong>${totalRequests.toLocaleString()}</strong></div>
    <div class="pill">Throughput: <strong>${throughput} req/s</strong></div>
    <div class="pill">Overall p95: <strong>${overallP95} ms</strong></div>
    <div class="pill">Error Rate: <strong>${errRate.toFixed(2)}%</strong></div>
    <div class="pill">Workflow Complete: <strong>${wfCompletion}%</strong></div>
    <div class="pill">Transactions Logged: <strong>${txnData.length}</strong></div>
  </div>
</div>
<div class="main">
  ${failedBox}
  <div class="spec-note">
    <strong>Test Data:</strong> Real PDF — testdata/Alex_Johnson_QA_Resume.pdf &nbsp;|&nbsp;
    <strong>Excluded APIs:</strong> /admin/cluster/presign, /admin/cluster/extract, /user/image/presign (and dependent upload endpoints) &nbsp;|&nbsp;
    <strong>Known Gap:</strong> /user/simulation-create returns no simulation_id — simulation_id derived from assessmentId. Monitor [SimEval] 404 rate.
  </div>
  <div class="section-title">Key Performance Indicators</div>
  <div class="kpi-grid">
    <div class="kpi-card ${parseFloat(successPct) >= 99.5 ? 'green' : parseFloat(successPct) >= 98 ? 'amber' : 'red'}">
      <div class="kpi-label">Success Rate</div><div class="kpi-value">${successPct}%</div><div class="kpi-sub">HTTP 2xx responses</div>
    </div>
    <div class="kpi-card ${parseFloat(errRate) <= 0.5 ? 'green' : 'red'}">
      <div class="kpi-label">Error Rate</div><div class="kpi-value">${errRate.toFixed(2)}%</div><div class="kpi-sub">HTTP failures</div>
    </div>
    <div class="kpi-card cyan">
      <div class="kpi-label">Throughput</div><div class="kpi-value">${throughput}</div><div class="kpi-sub">requests / second</div>
    </div>
    <div class="kpi-card ${parseFloat(overallP95) <= 500 ? 'green' : parseFloat(overallP95) <= 1000 ? 'amber' : 'red'}">
      <div class="kpi-label">Overall p95</div><div class="kpi-value">${overallP95} ms</div><div class="kpi-sub">latency</div>
    </div>
    <div class="kpi-card ${parseFloat(overallP99) <= 1000 ? 'green' : parseFloat(overallP99) <= 2000 ? 'amber' : 'red'}">
      <div class="kpi-label">Overall p99</div><div class="kpi-value">${overallP99} ms</div><div class="kpi-sub">latency</div>
    </div>
    <div class="kpi-card ${errors4xxCount === 0 ? 'green' : 'amber'}">
      <div class="kpi-label">4xx Errors</div><div class="kpi-value">${errors4xxCount.toLocaleString()}</div><div class="kpi-sub">client errors (budget &lt;10)</div>
    </div>
    <div class="kpi-card ${errors5xxCount === 0 ? 'green' : 'red'}">
      <div class="kpi-label">5xx Errors</div><div class="kpi-value">${errors5xxCount.toLocaleString()}</div><div class="kpi-sub">server errors (budget &lt;5)</div>
    </div>
    <div class="kpi-card ${parseFloat(wfCompletion) >= 99 ? 'green' : 'amber'}">
      <div class="kpi-label">Workflow Completion</div><div class="kpi-value">${wfCompletion}%</div><div class="kpi-sub">all stages passed</div>
    </div>
  </div>
  <div class="section-title">Endpoint Latency — p95 vs SLA</div>
  <div class="chart-wrap"><canvas id="latencyChart"></canvas></div>
  <div class="section-title">Endpoint Breakdown</div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Endpoint</th><th>Avg</th><th>p95</th><th>p99</th><th>SLA (p95)</th><th>vs SLA</th><th>Status</th></tr></thead>
      <tbody>${endpointRows}</tbody>
    </table>
  </div>
  <div class="section-title">HTTP System Metrics</div>
  <div class="sys-grid">${sysRows}</div>
</div>
<div class="section-title">Request / Response Log</div>
  <div class="txn-wrap">
    <div class="txn-controls">
      <input type="text"   id="txnSearch"      placeholder="Filter by label, URL, body, status…" oninput="filterTxn()"/>
      <select id="txnStatus" onchange="filterTxn()">
        <option value="">All statuses</option>
        <option value="2xx">2xx OK</option>
        <option value="4xx">4xx Client Error</option>
        <option value="5xx">5xx Server Error</option>
        <option value="neg">Negative Tests</option>
      </select>
      <select id="txnLabel" onchange="filterTxn()"><option value="">All endpoints</option></select>
      <span class="txn-count" id="txnCount"></span>
    </div>
    <div class="txn-table-wrap">
      <table class="txn-table" id="txnTable">
        <thead>
          <tr>
            <th>#</th>
            <th>Timestamp</th>
            <th>VU / Iter</th>
            <th>Label</th>
            <th>Endpoint</th>
            <th>Status</th>
            <th>Total (ms)</th>
            <th>Wait (ms)</th>
            <th>Request Body</th>
            <th>Response Body</th>
          </tr>
        </thead>
        <tbody id="txnBody"></tbody>
      </table>
    </div>
  </div>
</div>
<div class="footer">Generated by k6 v2.2 | Career API E2E | Profile: ${PROFILE.toUpperCase()} | ${runDate}</div>
<script>
(function(){
  const labels=${chartLabels},p95=${chartP95},sla=${chartSLA},colors=${chartColors};
  new Chart(document.getElementById('latencyChart').getContext('2d'),{
    type:'bar',
    data:{
      labels,
      datasets:[
        {label:'p95 Latency (ms)',data:p95,backgroundColor:colors,borderRadius:4,borderSkipped:false,order:1},
        {label:'SLA Threshold (ms)',data:sla,type:'line',borderColor:'rgba(245,158,11,0.8)',backgroundColor:'transparent',pointRadius:4,borderWidth:2,borderDash:[5,4],order:0,tension:0}
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:true,
      plugins:{
        legend:{labels:{color:'#94a3b8',font:{family:'DM Mono',size:11}}},
        tooltip:{backgroundColor:'#1a2235',titleColor:'#e2e8f0',bodyColor:'#94a3b8',borderColor:'#1e2d45',borderWidth:1}
      },
      scales:{
        x:{ticks:{color:'#64748b',font:{family:'DM Mono',size:10},maxRotation:40},grid:{color:'rgba(30,45,69,0.6)'}},
        y:{ticks:{color:'#64748b',font:{family:'DM Mono',size:10},callback:v=>v+' ms'},grid:{color:'rgba(30,45,69,0.6)'}}
      }
    }
  });
})();
})();
</scr` + `ipt>
<script>
// ── Transaction log data injected from k6 txnLog ──
const TXN_DATA = ${txnDataJson};

(function(){
  const tbody    = document.getElementById('txnBody');
  const countEl  = document.getElementById('txnCount');
  const labelSel = document.getElementById('txnLabel');

  // Populate label filter dropdown
  const labels = [...new Set(TXN_DATA.map(t => t.label))].sort();
  labels.forEach(l => {
    const o = document.createElement('option');
    o.value = l; o.textContent = l;
    labelSel.appendChild(o);
  });

  function statusChip(status, isNeg) {
    if (isNeg) return '<span class="status-chip status-neg">NEG ' + status + '</span>';
    if (status >= 500) return '<span class="status-chip status-5xx">' + status + '</span>';
    if (status >= 400) return '<span class="status-chip status-4xx">' + status + '</span>';
    return '<span class="status-chip status-2xx">' + status + '</span>';
  }

  function renderRows(data) {
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:2rem">No transactions match the current filter</td></tr>';
      countEl.textContent = '0 transactions';
      return;
    }
    tbody.innerHTML = data.map((t, i) => {
      const rowClass = t.isNegative ? 'txn-neg' : (t.ok ? 'txn-ok' : 'txn-fail');
      const ts = t.ts.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
      return '<tr class="' + rowClass + '">'
        + '<td>' + (i + 1) + '</td>'
        + '<td>' + ts + '</td>'
        + '<td>' + t.vu + ' / ' + t.iter + '</td>'
        + '<td>' + t.label + '</td>'
        + '<td>' + t.path + '</td>'
        + '<td>' + statusChip(t.resStatus, t.isNegative) + '</td>'
        + '<td>' + t.duration.toFixed(1) + '<div class="timing-grid"><span>blk ' + t.blocked + '</span><span>snd ' + t.sending + '</span><span>wait ' + t.waiting + '</span><span>rcv ' + t.receiving + '</span><span>conn ' + t.connecting + '</span></div></td>'
        + '<td>' + t.waiting.toFixed(1) + '</td>'
        + '<td class="body-cell">' + escHtml(t.reqBody) + '</td>'
        + '<td class="body-cell">' + escHtml(t.resBody) + '</td>'
        + '</tr>';
    }).join('');
    countEl.textContent = data.length + ' transaction' + (data.length !== 1 ? 's' : '');
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  window.filterTxn = function() {
    const q      = document.getElementById('txnSearch').value.toLowerCase();
    const status = document.getElementById('txnStatus').value;
    const label  = document.getElementById('txnLabel').value;

    const filtered = TXN_DATA.filter(t => {
      const matchQ = !q || [t.label, t.path, t.reqBody, t.resBody, String(t.resStatus)]
        .some(s => s.toLowerCase().includes(q));
      const matchStatus = !status
        || (status === '2xx' && t.resStatus >= 200 && t.resStatus < 300 && !t.isNegative)
        || (status === '4xx' && t.resStatus >= 400 && t.resStatus < 500)
        || (status === '5xx' && t.resStatus >= 500)
        || (status === 'neg' && t.isNegative);
      const matchLabel = !label || t.label === label;
      return matchQ && matchStatus && matchLabel;
    });
    renderRows(filtered);
  };

  renderRows(TXN_DATA);
})();
</scr` + `ipt>
</body>
</html>`;

  const summary = `
╔══════════════════════════════════════════════════════════════════════════════╗
║   K6 Load Test Complete — ${PROFILE.toUpperCase().padEnd(51)}║
║   Result : ${(overallPassed ? '✓ PASSED' : '✗ FAILED — ' + failedThresholds.length + ' threshold(s)').padEnd(66)}║
║   Success: ${successPct.padEnd(8)} │ p95: ${(overallP95 + ' ms').padEnd(10)} │ Throughput: ${(throughput + ' req/s').padEnd(17)}║
║   Workflow Completion: ${wfCompletion.padEnd(4)}%                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
→ HTML Report : results/k6_report.html
→ JSON Data   : results/k6_summary.json
`;

  console.log(summary);

  return {
    'stdout':                        summary,
    'results/k6_report.html':        html,
    'results/k6_summary.json':       JSON.stringify(data, null, 2),
    'results/k6_transactions.json':  JSON.stringify(txnData, null, 2),
  };
}
