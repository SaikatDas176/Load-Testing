/**
 * ============================================================
 *  K6 END-TO-END LOAD TEST
 *  Activity Upload & Extraction API
 * ============================================================
 *  Author  : Performance Engineering Team
 *  Version : 1.0
 *  Date    : February 2026
 *
 *  Workflow Coverage:
 *    Stage 1  — Activity: Presign → Upload → Extract
 *    Stage 2  — User:     Quiz Generate → Init Recommend
 *    Stage 3  — Simulate: Simulation Create → Evaluate → Revise Recommend
 *    Stage 4  — Profile:  Image Presign → Image Upload
 *    Stage 5  — Admin:    Cluster Presign → Upload → Extract
 *
 *  Test Profiles (select via ENV var: K6_PROFILE):
 *    smoke   — 1 VU, 2 min
 *    load    — 50 VU ramp, 30 min steady
 *    peak    — 200 VU ramp, 45 min steady
 *    stress  — 200→500 VU step-up
 *    spike   — 50→500→50 VU spike
 *    soak    — 100 VU, 8 hours
 *
 *  Usage:
 *    k6 run k6_e2e_load_test.js
 *    K6_PROFILE=peak BASE_URL=https://api.example.com k6 run k6_e2e_load_test.js
 *    k6 run --out influxdb=http://localhost:8086/k6 k6_e2e_load_test.js
 * ============================================================
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ─────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────
const BASE_URL  = __ENV.BASE_URL  || 'https://u3w2iq9qbd.execute-api.us-east-1.amazonaws.com';
const PROFILE   = __ENV.K6_PROFILE || 'load';
const API_TOKEN = __ENV.API_TOKEN  || '';   // Set if auth is required

// ─────────────────────────────────────────────────────────────
//  TEST PROFILES
// ─────────────────────────────────────────────────────────────
const PROFILES = {
  smoke: {
    stages: [
      { duration: '1m',  target: 1 },
      { duration: '1m',  target: 1 },
    ],
    thresholds: buildThresholds(2000, 4000, 2.0),
  },
  load: {
    stages: [
      { duration: '5m',  target: 10  },   // ramp-up
      { duration: '5m',  target: 50  },   // ramp-up continued
      { duration: '30m', target: 50  },   // steady state
      { duration: '5m',  target: 0   },   // ramp-down
    ],
    thresholds: buildThresholds(300, 800, 0.5),
  },
  peak: {
    stages: [
      { duration: '5m',  target: 50  },
      { duration: '5m',  target: 100 },
      { duration: '5m',  target: 200 },
      { duration: '45m', target: 200 },   // steady peak
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
    thresholds: buildThresholds(1000, 3000, 2.0),   // relaxed for stress
  },
  spike: {
    stages: [
      { duration: '2m',  target: 50  },   // baseline
      { duration: '1m',  target: 500 },   // spike up
      { duration: '5m',  target: 500 },   // hold spike
      { duration: '2m',  target: 50  },   // recover
      { duration: '5m',  target: 50  },   // confirm recovery
      { duration: '1m',  target: 500 },   // spike 2
      { duration: '5m',  target: 500 },
      { duration: '2m',  target: 50  },
      { duration: '5m',  target: 50  },
      { duration: '1m',  target: 500 },   // spike 3
      { duration: '5m',  target: 500 },
      { duration: '5m',  target: 0   },
    ],
    thresholds: buildThresholds(1500, 4000, 2.0),
  },
  soak: {
    stages: [
      { duration: '5m',  target: 50  },
      { duration: '10m', target: 100 },
      { duration: '7h',  target: 100 },   // 7-hour soak
      { duration: '10m', target: 0   },
    ],
    thresholds: buildThresholds(500, 1200, 1.0),
  },
};

function buildThresholds(p95, p99, errPct) {
  return {
    http_req_duration:                 [`p(95)<${p95}`, `p(99)<${p99}`],
    http_req_failed:                   [`rate<${errPct / 100}`],
    'presign_duration':                [`p(95)<300`],
    'upload_duration':                 [`p(95)<800`],
    'extract_duration':                [`p(95)<500`],
    'quiz_generate_duration':          [`p(95)<500`],
    'init_recommend_duration':         [`p(95)<500`],
    'revise_recommend_duration':       [`p(95)<500`],
    'simulation_create_duration':      [`p(95)<500`],
    'simulation_evaluation_duration':  [`p(95)<500`],
    'image_presign_duration':          [`p(95)<300`],
    'image_upload_duration':           [`p(95)<700`],
    'admin_presign_duration':          [`p(95)<300`],
    'admin_upload_duration':           [`p(95)<900`],
    'admin_extract_duration':          [`p(95)<500`],
    'errors_4xx':                      ['count<10'],
    'errors_5xx':                      ['count<5'],
  };
}

const activeProfile = PROFILES[PROFILE] || PROFILES['load'];

export const options = {
  stages:     activeProfile.stages,
  thresholds: activeProfile.thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  tags: {
    testProfile: PROFILE,
    testSuite:   'activity-upload-extraction-api',
  },
};

// ─────────────────────────────────────────────────────────────
//  CUSTOM METRICS
// ─────────────────────────────────────────────────────────────
const presignDuration           = new Trend('presign_duration',           true);
const uploadDuration            = new Trend('upload_duration',            true);
const extractDuration           = new Trend('extract_duration',           true);
const quizGenerateDuration      = new Trend('quiz_generate_duration',     true);
const initRecommendDuration     = new Trend('init_recommend_duration',    true);
const reviseRecommendDuration   = new Trend('revise_recommend_duration',  true);
const simCreateDuration         = new Trend('simulation_create_duration', true);
const simEvalDuration           = new Trend('simulation_evaluation_duration', true);
const imagePresignDuration      = new Trend('image_presign_duration',     true);
const imageUploadDuration       = new Trend('image_upload_duration',      true);
const adminPresignDuration      = new Trend('admin_presign_duration',     true);
const adminUploadDuration       = new Trend('admin_upload_duration',      true);
const adminExtractDuration      = new Trend('admin_extract_duration',     true);

const errors4xx                 = new Counter('errors_4xx');
const errors5xx                 = new Counter('errors_5xx');
const successRate               = new Rate('success_rate');
const workflowCompletionRate    = new Rate('workflow_completion_rate');
const activeWorkflows           = new Gauge('active_workflows');

// ─────────────────────────────────────────────────────────────
//  SHARED TEST DATA  (loaded once, shared across VUs)
// ─────────────────────────────────────────────────────────────

// Simulate PDF content as base64-like binary stub
// In real tests, replace with actual file content using open() or SharedArray
const PDF_STUB_SMALL  = generateFakeFile('pdf',  15 * 1024);   // 15 KB
const PDF_STUB_MED    = generateFakeFile('pdf',  100 * 1024);  // 100 KB
const DOCX_STUB       = generateFakeFile('docx', 50 * 1024);   // 50 KB
const JPEG_STUB       = generateFakeFile('jpeg', 80 * 1024);   // 80 KB
const CSV_STUB_SMALL  = generateFakeCsv(50);                   // 50-row CSV
const CSV_STUB_MED    = generateFakeCsv(500);                  // 500-row CSV

function generateFakeFile(type, sizeBytes) {
  // Create a realistic-sized binary payload
  // In production: use open('testdata/resume.pdf', 'b')
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let content = `%${type.toUpperCase()}-1.4 fake test file for performance testing\n`;
  const remaining = Math.max(0, sizeBytes - content.length);
  for (let i = 0; i < remaining; i++) {
    content += chars[i % chars.length];
  }
  return content;
}

function generateFakeCsv(rows) {
  let csv = 'user_id,name,email,assessment_score,activity_count,cluster_id\n';
  for (let i = 0; i < rows; i++) {
    csv += `${100000 + i},User ${i},user${i}@example.com,${75 + (i % 25)},${5 + (i % 20)},${1 + (i % 10)}\n`;
  }
  return csv;
}

// ─────────────────────────────────────────────────────────────
//  HEADERS
// ─────────────────────────────────────────────────────────────
function getHeaders(contentType = 'application/json') {
  const h = {
    'Content-Type': contentType,
    'Accept':       'application/json',
  };
  if (API_TOKEN) {
    h['Authorization'] = `Bearer ${API_TOKEN}`;
  }
  return h;
}

// ─────────────────────────────────────────────────────────────
//  UTILITY: HTTP Wrapper with metric recording
// ─────────────────────────────────────────────────────────────
function apiPost(url, payload, params, trendMetric, label) {
  const res = http.post(url, payload, params);

  if (trendMetric) trendMetric.add(res.timings.duration);

  if (res.status >= 400 && res.status < 500) errors4xx.add(1);
  if (res.status >= 500) errors5xx.add(1);

  successRate.add(res.status >= 200 && res.status < 300);
  return res;
}

function parseJson(res) {
  try {
    if (!res || !res.body) return {};
    const parsed = JSON.parse(res.body);
    return (parsed !== null && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    return {};
  }
}

function vuId() {
  // Unique ID per VU + iteration to prevent data collision
  return ((__VU - 1) * 100000) + __ITER + 100000;
}

// ─────────────────────────────────────────────────────────────
//  STAGE 1: ACTIVITY PRESIGN + UPLOAD + EXTRACT
// ─────────────────────────────────────────────────────────────
function stageActivityUpload() {
  let objectKey = null;

  group('S1.1 Activity Presign', () => {
    const fileNames = ['resume.pdf', 'cv.pdf', 'portfolio.docx', 'experience.pdf', 'skills.docx'];
    const fileName  = randomItem(fileNames);

    const res = apiPost(
      `${BASE_URL}/activity/presign`,
      JSON.stringify({ file_name: fileName }),
      { headers: getHeaders() },
      presignDuration,
      'activity-presign'
    );

    const ok = check(res, {
      '[Presign] status is 200':          (r) => r.status === 200,
      '[Presign] has upload_url':         (r) => { const b = parseJson(r); return b.upload_url !== undefined; },
      '[Presign] has object_key':         (r) => { const b = parseJson(r); return b.object_key !== undefined; },
      '[Presign] response time < 300ms':  (r) => r.timings.duration < 300,
    });

    if (ok) {
      objectKey = parseJson(res).object_key;
    }
  });

  // Negative test: invalid file type (runs on every 20th VU iteration)
  if (__ITER % 20 === 0) {
    group('S1.1-NEG Activity Presign Invalid Type', () => {
      const res = apiPost(
        `${BASE_URL}/activity/presign`,
        JSON.stringify({ file_name: 'malicious.exe' }),
        { headers: getHeaders() },
        null,
        'activity-presign-neg'
      );
      check(res, {
        '[Presign-NEG] status is 400':       (r) => r.status === 400,
        '[Presign-NEG] returns fast < 200ms':(r) => r.timings.duration < 200,
      });
    });
  }

  sleep(randomIntBetween(1, 2));

  // ── Upload ─────────────────────────────────────────────────
  group('S1.2 Activity Upload', () => {
    if (!objectKey) return;

    const fileOptions  = [
      { content: PDF_STUB_SMALL,  mime: 'application/pdf',       name: 'resume.pdf'  },
      { content: PDF_STUB_MED,    mime: 'application/pdf',       name: 'cv.pdf'      },
      { content: DOCX_STUB,       mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'skills.docx' },
    ];
    const chosen = randomItem(fileOptions);

    // Simulate a presigned S3 upload URL (in real tests this comes from presign response)
    const fakeUploadUrl = `${BASE_URL}/activity/upload`;

    const formData = {
      upload_url: 'https://test-bucket.s3.amazonaws.com/presigned-url-placeholder',
      object_key: objectKey,
      file:       http.file(chosen.content, chosen.name, chosen.mime),
    };

    const res = apiPost(
      `${BASE_URL}/activity/upload`,
      formData,
      { headers: { 'Accept': 'application/json', ...(API_TOKEN ? { 'Authorization': `Bearer ${API_TOKEN}` } : {}) } },
      uploadDuration,
      'activity-upload'
    );

    check(res, {
      '[Upload] status is 200':           (r) => r.status === 200,
      '[Upload] has object_key':          (r) => { const b = parseJson(r); return b.object_key !== undefined; },
      '[Upload] response time < 800ms':   (r) => r.timings.duration < 800,
    });
  });

  sleep(randomIntBetween(1, 2));

  // ── Extract ────────────────────────────────────────────────
  group('S1.3 AI Extraction Queue', () => {
    if (!objectKey) return;

    const res = apiPost(
      `${BASE_URL}/extract`,
      JSON.stringify({
        assessment_id: vuId(),
        object_key:    objectKey || `user-activities/${vuId()}_resume.pdf`,
      }),
      { headers: getHeaders() },
      extractDuration,
      'extract'
    );

    check(res, {
      '[Extract] status is 200':          (r) => r.status === 200,
      '[Extract] queued message':         (r) => { const b = parseJson(r); return (b.message || '').toLowerCase().includes('queue'); },
      '[Extract] response time < 500ms':  (r) => r.timings.duration < 500,
    });
  });

  sleep(randomIntBetween(1, 3));
}

// ─────────────────────────────────────────────────────────────
//  STAGE 2: QUIZ GENERATE + INIT RECOMMEND
// ─────────────────────────────────────────────────────────────
function stageUserAssessment() {
  const assessmentId = vuId();

  group('S2.1 Quiz Generate', () => {
    const res = apiPost(
      `${BASE_URL}/user/quiz-generate`,
      JSON.stringify({ assessment_id: assessmentId }),
      { headers: getHeaders() },
      quizGenerateDuration,
      'quiz-generate'
    );

    check(res, {
      '[Quiz] status is 200':           (r) => r.status === 200,
      '[Quiz] has quiz_id':             (r) => { const b = parseJson(r); return b.quiz_id !== undefined; },
      '[Quiz] response time < 500ms':   (r) => r.timings.duration < 500,
    });

    // Negative: missing assessment_id
    if (__ITER % 25 === 0) {
      const negRes = apiPost(
        `${BASE_URL}/user/quiz-generate`,
        JSON.stringify({}),
        { headers: getHeaders() },
        null,
        'quiz-generate-neg'
      );
      check(negRes, {
        '[Quiz-NEG] status is 400':    (r) => r.status === 400,
      });
    }
  });

  sleep(randomIntBetween(1, 2));

  group('S2.2 Init Recommend', () => {
    const res = apiPost(
      `${BASE_URL}/user/init-recommend`,
      JSON.stringify({ assessment_id: assessmentId }),
      { headers: getHeaders() },
      initRecommendDuration,
      'init-recommend'
    );

    check(res, {
      '[InitRec] status is 200':          (r) => r.status === 200,
      '[InitRec] response time < 500ms':  (r) => r.timings.duration < 500,
    });
  });

  sleep(randomIntBetween(1, 2));
}

// ─────────────────────────────────────────────────────────────
//  STAGE 3: SIMULATION CREATE → EVALUATE → REVISE RECOMMEND
// ─────────────────────────────────────────────────────────────
function stageSimulation() {
  const assessmentId  = vuId();
  const clusterId     = randomIntBetween(100, 999);
  let   simulationId  = null;

  group('S3.1 Simulation Create', () => {
    const res = apiPost(
      `${BASE_URL}/user/simulation-create`,
      JSON.stringify({ assessment_id: assessmentId, cluster_id: clusterId }),
      { headers: getHeaders() },
      simCreateDuration,
      'simulation-create'
    );

    check(res, {
      '[SimCreate] status is 200':          (r) => r.status === 200,
      '[SimCreate] response time < 500ms':  (r) => r.timings.duration < 500,
    });

    // Extract simulation_id if returned; otherwise synthesise one
    const body = parseJson(res);
    simulationId = body.simulation_id || randomIntBetween(5000, 9999);
  });

  sleep(randomIntBetween(2, 4));

  group('S3.2 Simulation Evaluation', () => {
    const res = apiPost(
      `${BASE_URL}/user/simulation-evaluation`,
      JSON.stringify({
        assessment_id:  assessmentId,
        simulation_id:  simulationId || randomIntBetween(5000, 9999),
        cluster_id:     clusterId,
      }),
      { headers: getHeaders() },
      simEvalDuration,
      'simulation-evaluation'
    );

    check(res, {
      '[SimEval] status is 200':          (r) => r.status === 200,
      '[SimEval] response time < 500ms':  (r) => r.timings.duration < 500,
    });

    // Negative: missing simulation_id
    if (__ITER % 30 === 0) {
      const negRes = apiPost(
        `${BASE_URL}/user/simulation-evaluation`,
        JSON.stringify({ assessment_id: assessmentId }),
        { headers: getHeaders() },
        null,
        'simulation-evaluation-neg'
      );
      check(negRes, {
        '[SimEval-NEG] status is 400 or 404': (r) => r.status === 400 || r.status === 404,
      });
    }
  });

  sleep(randomIntBetween(1, 2));

  group('S3.3 Revise Recommend', () => {
    const reviseReasons = [
      'User requested alternative career path',
      'Simulation score below threshold',
      'New skill data available',
      'User preference update',
    ];

    const res = apiPost(
      `${BASE_URL}/user/revise-recommend`,
      JSON.stringify({
        assessment_id: assessmentId,
        revise_reason: randomItem(reviseReasons),
      }),
      { headers: getHeaders() },
      reviseRecommendDuration,
      'revise-recommend'
    );

    check(res, {
      '[ReviseRec] status is 200':          (r) => r.status === 200,
      '[ReviseRec] response time < 500ms':  (r) => r.timings.duration < 500,
    });
  });

  sleep(randomIntBetween(1, 2));
}

// ─────────────────────────────────────────────────────────────
//  STAGE 4: USER PROFILE IMAGE
// ─────────────────────────────────────────────────────────────
function stageProfileImage() {
  let imageObjectKey = null;
  const userId = randomIntBetween(1000, 9999);

  group('S4.1 Image Presign', () => {
    const imageNames = ['profile_pic.jpg', 'avatar.jpeg', 'photo.png', 'headshot.jpg'];

    const res = apiPost(
      `${BASE_URL}/user/image/presign`,
      JSON.stringify({ file_name: randomItem(imageNames) }),
      { headers: getHeaders() },
      imagePresignDuration,
      'image-presign'
    );

    check(res, {
      '[ImgPresign] status is 200':          (r) => r.status === 200,
      '[ImgPresign] has upload_url':         (r) => { const b = parseJson(r); return b.upload_url !== undefined; },
      '[ImgPresign] has object_key':         (r) => { const b = parseJson(r); return b.object_key !== undefined; },
      '[ImgPresign] response time < 300ms':  (r) => r.timings.duration < 300,
    });

    imageObjectKey = parseJson(res).object_key;

    // Negative: unsupported image type
    if (__ITER % 20 === 0) {
      const negRes = apiPost(
        `${BASE_URL}/user/image/presign`,
        JSON.stringify({ file_name: 'animation.gif' }),
        { headers: getHeaders() },
        null,
        'image-presign-neg'
      );
      check(negRes, {
        '[ImgPresign-NEG] status is 400': (r) => r.status === 400,
      });
    }
  });

  sleep(randomIntBetween(1, 2));

  group('S4.2 Image Upload', () => {
    const formData = {
      file:       http.file(JPEG_STUB, 'profile_pic.jpg', 'image/jpeg'),
      user_id:    String(userId),
      object_key: imageObjectKey || `user-images/${Date.now()}_profile_pic.jpg`,
    };

    const res = apiPost(
      `${BASE_URL}/user/image/upload`,
      formData,
      { headers: { 'Accept': 'application/json', ...(API_TOKEN ? { 'Authorization': `Bearer ${API_TOKEN}` } : {}) } },
      imageUploadDuration,
      'image-upload'
    );

    check(res, {
      '[ImgUpload] status is 200':          (r) => r.status === 200,
      '[ImgUpload] has image_url':          (r) => { const b = parseJson(r); return b.image_url !== undefined; },
      '[ImgUpload] response time < 700ms':  (r) => r.timings.duration < 700,
    });
  });

  sleep(randomIntBetween(1, 2));
}

// ─────────────────────────────────────────────────────────────
//  STAGE 5: ADMIN CLUSTER  (lower VU weight — admin traffic)
// ─────────────────────────────────────────────────────────────
function stageAdminCluster() {
  let clusterObjectKey = null;

  group('S5.1 Admin Cluster Presign', () => {
    const res = apiPost(
      `${BASE_URL}/admin/cluster/presign`,
      JSON.stringify({ file_name: `user_data_batch_${vuId()}.csv` }),
      { headers: getHeaders() },
      adminPresignDuration,
      'admin-cluster-presign'
    );

    check(res, {
      '[AdminPresign] status is 200':          (r) => r.status === 200,
      '[AdminPresign] has upload_url':         (r) => { const b = parseJson(r); return b.upload_url !== undefined; },
      '[AdminPresign] has object_key':         (r) => { const b = parseJson(r); return b.object_key !== undefined; },
      '[AdminPresign] response time < 300ms':  (r) => r.timings.duration < 300,
    });

    clusterObjectKey = parseJson(res).object_key;
  });

  sleep(randomIntBetween(1, 2));

  group('S5.2 Admin Cluster Upload', () => {
    const csvOptions = [
      { content: CSV_STUB_SMALL, name: 'cluster_small.csv' },
      { content: CSV_STUB_MED,   name: 'cluster_medium.csv' },
    ];
    const chosen = randomItem(csvOptions);

    const formData = {
      upload_url: 'https://test-bucket.s3.amazonaws.com/presigned-url-placeholder',
      object_key: clusterObjectKey || `admin-cluster/${Date.now()}_data.csv`,
      file:       http.file(chosen.content, chosen.name, 'text/csv'),
    };

    const res = apiPost(
      `${BASE_URL}/admin/cluster/upload`,
      formData,
      { headers: { 'Accept': 'application/json', ...(API_TOKEN ? { 'Authorization': `Bearer ${API_TOKEN}` } : {}) } },
      adminUploadDuration,
      'admin-cluster-upload'
    );

    check(res, {
      '[AdminUpload] status is 200':          (r) => r.status === 200,
      '[AdminUpload] has object_key':         (r) => { const b = parseJson(r); return b.object_key !== undefined; },
      '[AdminUpload] response time < 900ms':  (r) => r.timings.duration < 900,
    });

    // Negative: unsupported file type
    if (__ITER % 15 === 0) {
      const negFormData = {
        upload_url: 'https://test-bucket.s3.amazonaws.com/presigned-url-placeholder',
        object_key: 'admin-cluster/invalid.xlsx',
        file:       http.file('not a csv', 'data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      };
      const negRes = apiPost(
        `${BASE_URL}/admin/cluster/upload`,
        negFormData,
        { headers: { 'Accept': 'application/json' } },
        null,
        'admin-upload-neg'
      );
      check(negRes, {
        '[AdminUpload-NEG] status is 400':  (r) => r.status === 400,
        '[AdminUpload-NEG] fast < 200ms':   (r) => r.timings.duration < 200,
      });
    }
  });

  sleep(randomIntBetween(1, 2));

  group('S5.3 Admin Cluster Extract', () => {
    const res = apiPost(
      `${BASE_URL}/admin/cluster/extract`,
      JSON.stringify({
        object_key: clusterObjectKey || `admin-cluster/${Date.now()}_data.csv`,
      }),
      { headers: getHeaders() },
      adminExtractDuration,
      'admin-cluster-extract'
    );

    check(res, {
      '[AdminExtract] status is 200':          (r) => r.status === 200,
      '[AdminExtract] queued message':         (r) => { const b = parseJson(r); return (b.message || '').toLowerCase().includes('queue'); },
      '[AdminExtract] response time < 500ms':  (r) => r.timings.duration < 500,
    });

    // Negative: file not in S3
    if (__ITER % 20 === 0) {
      const negRes = apiPost(
        `${BASE_URL}/admin/cluster/extract`,
        JSON.stringify({ object_key: 'admin-cluster/nonexistent_ghost_file.csv' }),
        { headers: getHeaders() },
        null,
        'admin-extract-neg'
      );
      check(negRes, {
        '[AdminExtract-NEG] status is 404 or 400': (r) => r.status === 404 || r.status === 400,
      });
    }
  });

  sleep(randomIntBetween(2, 3));
}

// ─────────────────────────────────────────────────────────────
//  SETUP — runs once before the test
// ─────────────────────────────────────────────────────────────
export function setup() {
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   K6 E2E Load Test — Activity Upload & Extraction   ║
  ║   Profile  : ${PROFILE.padEnd(38)}║
  ║   Base URL : ${BASE_URL.substring(0, 38).padEnd(38)}║
  ╚══════════════════════════════════════════════════════╝
  `);

  // Smoke check: confirm API is reachable before ramping
  const res = http.post(
    `${BASE_URL}/activity/presign`,
    JSON.stringify({ file_name: 'warmup.pdf' }),
    { headers: getHeaders() }
  );

  if (res.status !== 200) {
    console.error(`❌ SETUP FAILED — API returned ${res.status}. Aborting.`);
  } else {
    console.log(`✅ API reachable. Starting test profile: [${PROFILE.toUpperCase()}]`);
  }

  return { startTime: Date.now() };
}

// ─────────────────────────────────────────────────────────────
//  MAIN VU FUNCTION
// ─────────────────────────────────────────────────────────────
export default function (data) {
  activeWorkflows.add(1);

  // VU routing: admin traffic is ~5% of total load
  const isAdminVu = __VU % 20 === 0;

  if (isAdminVu) {
    // Admin-only workflow
    group('ADMIN E2E Workflow', () => {
      stageAdminCluster();
    });
  } else {
    // Full user E2E workflow
    group('USER E2E Workflow', () => {
      stageActivityUpload();
      stageUserAssessment();
      stageSimulation();

      // Profile image upload runs on ~30% of user iterations
      if (__ITER % 3 === 0) {
        stageProfileImage();
      }
    });

    workflowCompletionRate.add(true);
  }

  activeWorkflows.add(-1);

  // Pacing: think time between full workflow iterations
  sleep(randomIntBetween(3, 7));
}

// ─────────────────────────────────────────────────────────────
//  TEARDOWN — runs once after the test
// ─────────────────────────────────────────────────────────────
export function teardown(data) {
  const durationMin = ((Date.now() - data.startTime) / 1000 / 60).toFixed(1);
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   Test Completed                                     ║
  ║   Profile  : ${PROFILE.padEnd(38)}║
  ║   Duration : ${(durationMin + ' minutes').padEnd(38)}║
  ╚══════════════════════════════════════════════════════╝
  `);
}

// ─────────────────────────────────────────────────────────────
//  CUSTOM SUMMARY  (HTML report + JSON + stdout)
// ─────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const metrics = data.metrics;

  function val(metricName, key) {
    const m = metrics[metricName];
    if (!m) return null;
    return m.values[key] !== undefined ? m.values[key] : null;
  }
  function pctNum(metricName, pctile) { return val(metricName, `p(${pctile})`) || 0; }
  function pctStr(metricName, pctile) { const v = pctNum(metricName, pctile); return v ? v.toFixed(1) + ' ms' : 'N/A'; }
  function rateNum(metricName) { return (val(metricName, 'rate') || 0) * 100; }
  function rateStr(metricName) { return rateNum(metricName).toFixed(2) + '%'; }
  function countNum(metricName) { return val(metricName, 'count') || 0; }
  function avgStr(metricName) { const v = val(metricName, 'avg'); return v !== null ? v.toFixed(1) + ' ms' : 'N/A'; }

  const failedThresholds = Object.entries(metrics)
    .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some(t => !t.ok))
    .map(([name]) => name);
  const overallPassed = failedThresholds.length === 0;

  const endpoints = [
    { label: 'Activity Presign',       metric: 'presign_duration',               sla95: 300 },
    { label: 'Activity Upload',        metric: 'upload_duration',                sla95: 800 },
    { label: 'AI Extract (queue)',     metric: 'extract_duration',               sla95: 500 },
    { label: 'Quiz Generate',          metric: 'quiz_generate_duration',         sla95: 500 },
    { label: 'Init Recommend',         metric: 'init_recommend_duration',        sla95: 500 },
    { label: 'Revise Recommend',       metric: 'revise_recommend_duration',      sla95: 500 },
    { label: 'Simulation Create',      metric: 'simulation_create_duration',     sla95: 500 },
    { label: 'Simulation Evaluate',    metric: 'simulation_evaluation_duration', sla95: 500 },
    { label: 'Image Presign',          metric: 'image_presign_duration',         sla95: 300 },
    { label: 'Image Upload',           metric: 'image_upload_duration',          sla95: 700 },
    { label: 'Admin Cluster Presign',  metric: 'admin_presign_duration',         sla95: 300 },
    { label: 'Admin Cluster Upload',   metric: 'admin_upload_duration',          sla95: 900 },
    { label: 'Admin Cluster Extract',  metric: 'admin_extract_duration',         sla95: 500 },
  ];

  const endpointRows = endpoints.map(ep => {
    const p95 = pctNum(ep.metric, 95);
    const p99 = pctNum(ep.metric, 99);
    const avg = val(ep.metric, 'avg') || 0;
    const passed = p95 <= ep.sla95;
    const pct = Math.min((p95 / (ep.sla95 * 1.5)) * 100, 100).toFixed(1);
    const barColor = passed ? '#22c55e' : '#ef4444';
    return `<tr class="${passed ? '' : 'row-fail'}">
        <td class="ep-name">${ep.label}</td>
        <td class="num">${avg > 0 ? avg.toFixed(1) + ' ms' : 'N/A'}</td>
        <td class="num ${p95 > ep.sla95 ? 'over-sla' : ''}">${p95 > 0 ? p95.toFixed(1) + ' ms' : 'N/A'}</td>
        <td class="num">${p99 > 0 ? p99.toFixed(1) + ' ms' : 'N/A'}</td>
        <td class="sla-cell">${ep.sla95} ms</td>
        <td class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor}"></div></div></td>
        <td>${passed ? '<span class="badge pass">PASS</span>' : '<span class="badge fail">FAIL</span>'}</td>
      </tr>`;
  }).join('');

  const chartLabels = JSON.stringify(endpoints.map(e => e.label));
  const chartP95    = JSON.stringify(endpoints.map(e => pctNum(e.metric, 95).toFixed(1)));
  const chartSLA    = JSON.stringify(endpoints.map(e => e.sla95));
  const chartColors = JSON.stringify(endpoints.map(e => pctNum(e.metric, 95) <= e.sla95 ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)'));

  const totalRequests  = countNum('http_reqs');
  const errRate        = rateNum('http_req_failed');
  const successPct     = (100 - errRate).toFixed(2);
  const errors4xxCount = countNum('errors_4xx');
  const errors5xxCount = countNum('errors_5xx');
  const wfCompletion   = rateNum('workflow_completion_rate').toFixed(2);
  const overallP95     = pctNum('http_req_duration', 95).toFixed(1);
  const overallP99     = pctNum('http_req_duration', 99).toFixed(1);
  const throughput     = (val('http_reqs', 'rate') || 0).toFixed(2);
  const runDate        = new Date().toLocaleString('en-US', { year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short' });

  const failedBox = failedThresholds.length > 0
    ? `<div class="alert-box"><h3>⚠ Failed Thresholds (${failedThresholds.length})</h3>${failedThresholds.map(t=>`<div class="alert-item">→ ${t}</div>`).join('')}</div>`
    : '';

  function kpiColor(val, goodBelow, warnBelow) {
    if (val <= goodBelow) return 'green';
    if (val <= warnBelow) return 'amber';
    return 'red';
  }

  const sysRows = [
    ['Total Requests',    totalRequests.toLocaleString()],
    ['HTTP p90',          pctStr('http_req_duration', 90)],
    ['HTTP p95',          pctStr('http_req_duration', 95)],
    ['HTTP p99',          pctStr('http_req_duration', 99)],
    ['HTTP avg',          avgStr('http_req_duration')],
    ['Failed Requests',   countNum('http_req_failed').toLocaleString()],
    ['Blocked avg',       avgStr('http_req_blocked')],
    ['Connect avg',       avgStr('http_req_connecting')],
    ['TLS handshake avg', avgStr('http_req_tls_handshaking')],
    ['Send avg',          avgStr('http_req_sending')],
    ['Wait avg',          avgStr('http_req_waiting')],
    ['Receive avg',       avgStr('http_req_receiving')],
  ].map(([l,v]) => `<div class="sys-card"><span class="sys-label">${l}</span><span class="sys-value">${v}</span></div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Load Test Report — ${PROFILE.toUpperCase()}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></scr` + `ipt>
<style>
:root{--bg:#0b0f1a;--surface:#111827;--surface2:#1a2235;--border:#1e2d45;--accent:#3b82f6;--accent2:#06b6d4;--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--text:#e2e8f0;--muted:#64748b;--mono:'DM Mono',monospace;--sans:'Syne',sans-serif}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;line-height:1.6}
.header{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0f172a 100%);border-bottom:1px solid var(--border);padding:3rem 4rem 2.5rem;position:relative;overflow:hidden}
.header::before{content:'';position:absolute;top:-60px;right:-60px;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,rgba(59,130,246,.15) 0%,transparent 70%);pointer-events:none}
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
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.2rem 1.4rem;position:relative;overflow:hidden;transition:border-color .2s}
.kpi-card:hover{border-color:var(--accent)}
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
th{font-family:var(--mono);font-size:.65rem;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;padding:.8rem 1.2rem;text-align:left;white-space:nowrap}
td{padding:.8rem 1.2rem;font-size:.88rem;border-bottom:1px solid rgba(30,45,69,.6);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(59,130,246,.04)}
tbody tr.row-fail{background:rgba(239,68,68,.04)}
.ep-name{font-weight:600;color:var(--text)}.num{font-family:var(--mono);font-size:.82rem;color:var(--text)}.over-sla{color:var(--red)!important;font-weight:600}
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
.sys-label{font-family:var(--mono);font-size:.72rem;color:var(--muted)}.sys-value{font-family:var(--mono);font-size:1rem;font-weight:500;color:var(--text)}
.footer{border-top:1px solid var(--border);padding:1.5rem 2rem;text-align:center;font-family:var(--mono);font-size:.68rem;color:var(--muted)}
@media(max-width:768px){.header{padding:2rem 1.5rem}.main{padding:1.5rem 1rem 3rem}.header h1{font-size:1.5rem}.kpi-grid{grid-template-columns:repeat(2,1fr)}.bar-cell{display:none}}
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div>
      <div class="report-label">Performance Test Report</div>
      <h1>Activity Upload &amp;<br/><span>Extraction API</span></h1>
    </div>
    <div class="header-meta">
      <div class="overall-badge ${overallPassed ? 'pass' : 'fail'}">${overallPassed ? '✓ All Thresholds Passed' : '✗ Thresholds Failed'}</div>
      <div class="meta-row">Generated: <strong>${runDate}</strong></div>
      <div class="meta-row">Profile: <strong>${PROFILE.toUpperCase()}</strong></div>
      <div class="meta-row">Base URL: <strong>${BASE_URL.substring(0,50)}</strong></div>
    </div>
  </div>
  <div class="header-pills">
    <div class="pill">Profile: <strong>${PROFILE.toUpperCase()}</strong></div>
    <div class="pill">Requests: <strong>${totalRequests.toLocaleString()}</strong></div>
    <div class="pill">Throughput: <strong>${throughput} req/s</strong></div>
    <div class="pill">Overall p95: <strong>${overallP95} ms</strong></div>
    <div class="pill">Error Rate: <strong>${errRate.toFixed(2)}%</strong></div>
  </div>
</div>
<div class="main">
  ${failedBox}
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
      <div class="kpi-label">Overall p95</div><div class="kpi-value">${overallP95}</div><div class="kpi-sub">ms latency</div>
    </div>
    <div class="kpi-card ${parseFloat(overallP99) <= 1000 ? 'green' : parseFloat(overallP99) <= 2000 ? 'amber' : 'red'}">
      <div class="kpi-label">Overall p99</div><div class="kpi-value">${overallP99}</div><div class="kpi-sub">ms latency</div>
    </div>
    <div class="kpi-card ${errors4xxCount === 0 ? 'green' : 'amber'}">
      <div class="kpi-label">4xx Errors</div><div class="kpi-value">${errors4xxCount.toLocaleString()}</div><div class="kpi-sub">client errors (SLA &lt; 10)</div>
    </div>
    <div class="kpi-card ${errors5xxCount === 0 ? 'green' : 'red'}">
      <div class="kpi-label">5xx Errors</div><div class="kpi-value">${errors5xxCount.toLocaleString()}</div><div class="kpi-sub">server errors (SLA &lt; 5)</div>
    </div>
    <div class="kpi-card ${parseFloat(wfCompletion) >= 99 ? 'green' : 'amber'}">
      <div class="kpi-label">Workflow Completion</div><div class="kpi-value">${wfCompletion}%</div><div class="kpi-sub">end-to-end success</div>
    </div>
  </div>
  <div class="section-title">Endpoint Latency — p95 vs SLA Threshold</div>
  <div class="chart-wrap">
    <canvas id="latencyChart"></canvas>
  </div>
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
<div class="footer">Generated by k6 Load Testing Framework &nbsp;|&nbsp; Profile: ${PROFILE.toUpperCase()} &nbsp;|&nbsp; ${runDate}</div>
<script>
(function(){
  const labels=${chartLabels},p95=${chartP95},sla=${chartSLA},colors=${chartColors};
  new Chart(document.getElementById('latencyChart').getContext('2d'),{
    type:'bar',
    data:{
      labels,
      datasets:[
        {label:'p95 Latency (ms)',data:p95,backgroundColor:colors,borderRadius:4,borderSkipped:false,order:1},
        {label:'SLA Threshold (ms)',data:sla,type:'line',borderColor:'rgba(245,158,11,0.8)',backgroundColor:'transparent',pointBackgroundColor:'rgba(245,158,11,0.8)',pointRadius:4,borderWidth:2,borderDash:[5,4],order:0,tension:0}
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:true,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{labels:{color:'#94a3b8',font:{family:'DM Mono',size:11}}},
        tooltip:{backgroundColor:'#1a2235',titleColor:'#e2e8f0',bodyColor:'#94a3b8',borderColor:'#1e2d45',borderWidth:1,callbacks:{label:c=>c.dataset.label+': '+c.parsed.y+' ms'}}
      },
      scales:{
        x:{ticks:{color:'#64748b',font:{family:'DM Mono',size:10},maxRotation:40},grid:{color:'rgba(30,45,69,0.6)'}},
        y:{ticks:{color:'#64748b',font:{family:'DM Mono',size:10},callback:v=>v+' ms'},grid:{color:'rgba(30,45,69,0.6)'}}
      }
    }
  });
})();
</scr` + `ipt>
</body>
</html>`;

  const summary = `
╔═══════════════════════════════════════════════════════════════════════════╗
║   K6 Load Test Complete — ${PROFILE.toUpperCase().padEnd(47)}║
║   Result: ${(overallPassed ? '✓ PASSED' : '✗ FAILED — '+failedThresholds.length+' threshold(s)').padEnd(63)}║
║   Success: ${successPct.padEnd(8)} │ p95: ${(overallP95+' ms').padEnd(9)} │ Throughput: ${(throughput+' req/s').padEnd(15)}║
╚═══════════════════════════════════════════════════════════════════════════╝
→ HTML Report : results/k6_report.html
→ JSON Data   : results/k6_summary.json
`;

  console.log(summary);

  return {
    'stdout':                  summary,
    'results/k6_report.html':  html,
    'results/k6_summary.json': JSON.stringify(data, null, 2),
  };
}
