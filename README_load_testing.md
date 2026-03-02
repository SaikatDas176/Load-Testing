# k6 Grafana Integration — Setup Guide

## What's in this package

```
grafana-k6/
├── docker-compose.yml                          ← Starts InfluxDB + Grafana
└── grafana/
    ├── provisioning/
    │   ├── datasources/influxdb.yml            ← Auto-connects InfluxDB datasource
    │   └── dashboards/dashboards.yml           ← Auto-loads dashboards
    └── dashboards/
        └── k6-dashboard.json                   ← Pre-built k6 dashboard
```

---

## Step 1 — Start the Stack

```bash
cd grafana-k6-fixed
docker-compose up -d
```

Wait ~15 seconds for InfluxDB to initialize, then verify:
- **Grafana**:  http://localhost:3000  (admin / admin)
- **InfluxDB**: http://localhost:8086  (admin / k6password123)

---

## Step 2 — Run k6 with InfluxDB output

Add `--out influxdb` to stream live metrics into Grafana:

```bash
# Default load profile
BASE_URL=https://your-api.com k6 run \
  --out influxdb=http://localhost:8086/k6 \
  k6_e2e_load_test.js

# Smoke test (recommended first)
K6_PROFILE=smoke BASE_URL=https://your-api.com k6 run \
  --out influxdb=http://localhost:8086/k6 \
  k6_e2e_load_test.js

# Peak load
K6_PROFILE=peak BASE_URL=https://your-api.com k6 run \
  --out influxdb=http://localhost:8086/k6 \
  k6_e2e_load_test.js
```

**Windows PowerShell:**
```powershell
$env:BASE_URL="https://your-api.com"; $env:K6_PROFILE="smoke"
k6 run --out influxdb=http://localhost:8086/k6 k6_e2e_load_test.js
```

---

## Step 3 — Open Grafana Dashboard

1. Go to http://localhost:3000
2. Navigate to **Dashboards → k6 Load Test — Activity Upload & Extraction API**
3. Dashboard auto-refreshes every 5 seconds during the run

The dashboard shows:
- **Live KPIs**: Total requests, req/s, error rate, active VUs, p95 latency
- **Response time trends**: p50 / p90 / p95 / p99 over time
- **VU ramp**: Active VUs and throughput on dual axis
- **Endpoint breakdown**: Horizontal bar gauge per endpoint vs SLA
- **Error tracking**: 4xx and 5xx error rates over time

---

## Step 4 — HTML Report (after run completes)

k6 automatically saves to your `results/` folder:

| File | Description |
|------|-------------|
| `results/k6_report.html` | ✅ Client-shareable HTML report with charts |
| `results/k6_summary.json` | Raw metrics JSON for CI parsing |

Open `results/k6_report.html` in any browser — no server needed. Send to clients as-is.

---

## InfluxDB credentials

| Setting | Value |
|---------|-------|
| URL | http://localhost:8086 |
| Org | k6-org |
| Bucket | k6 |
| Token | k6-super-secret-token |

> ⚠️ Change these for production environments.

---

## Stop the stack

```bash
docker-compose down          # Stop containers (keeps data)
docker-compose down -v       # Stop + delete all data
```

---

## Troubleshooting

**k6 can't connect to InfluxDB**
```bash
# Check InfluxDB is running
curl http://localhost:8086/ping
# Should return: 204
```

**No data in Grafana**
- Make sure you passed `--out influxdb=http://localhost:8086/k6` to k6
- Check the time range in Grafana matches when you ran the test
- Click the datasource in Grafana Settings → InfluxDB-k6 → "Save & Test"