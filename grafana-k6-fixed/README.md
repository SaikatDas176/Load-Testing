# k6 + Grafana Setup (InfluxDB v1 — Fixed)

## Why InfluxDB v1?
k6's built-in `--out influxdb` flag **only supports InfluxDB v1.x**.
The previous setup used v2 which caused the `unauthorized access` error you saw.

---

## Step 1 — Stop old containers (if running)

```bash
docker stop k6-influxdb k6-grafana
docker rm k6-influxdb k6-grafana
```

---

## Step 2 — Start the fixed stack

```bash
cd grafana-k6
docker-compose up -d
```

Verify InfluxDB is running:
```bash
curl http://localhost:8086/ping
# Should return HTTP 204 — no output, just success
```

---

## Step 3 — Run k6 (same command as before — now it works)

```bash
# Smoke test
K6_PROFILE=smoke BASE_URL=https://your-api.com k6 run \
  --out influxdb=http://localhost:8086/k6 \
  k6_e2e_load_test.js

# Load test
K6_PROFILE=load BASE_URL=https://your-api.com k6 run \
  --out influxdb=http://localhost:8086/k6 \
  k6_e2e_load_test.js
```

**Windows PowerShell:**
```powershell
$env:K6_PROFILE="smoke"; $env:BASE_URL="https://your-api.com"
k6 run --out influxdb=http://localhost:8086/k6 k6_e2e_load_test.js
```

No more `unauthorized` errors!

---

## Step 4 — Open Grafana

→ http://localhost:3000 (admin / admin)

Navigate to **Dashboards → k6 Load Test — Activity Upload & Extraction API**

---

## After the run

Your `results/` folder will contain:
- `results/k6_report.html` — open in browser, send to client
- `results/k6_summary.json` — raw data

---

## What changed from v2 → v1

| Setting         | Old (broken v2)                      | New (working v1)           |
|----------------|--------------------------------------|----------------------------|
| Docker image    | `influxdb:2.7`                       | `influxdb:1.8`             |
| Auth            | Token-based                          | No auth (local)            |
| DB setup        | `DOCKER_INFLUXDB_INIT_*` env vars    | `INFLUXDB_DB: k6`          |
| Query language  | Flux                                 | InfluxQL                   |
| Grafana config  | `version: Flux` + token              | `database: k6`, no token   |
