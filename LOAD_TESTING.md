# OncoConnect Load Testing Guide

**Last Updated:** July 30, 2026  
**Purpose:** Verify API performance under load and identify bottlenecks  
**Target:** Support 50+ concurrent patients with <500ms response time (p95)

---

## Quick Start

### Install k6
```bash
# macOS
brew install k6

# Linux (Ubuntu/Debian)
sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3232A
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6-archive.list
sudo apt-get update
sudo apt-get install k6

# Docker
docker run -i loadimpact/k6 run - <tests/load.js
```

### Run Baseline Test
```bash
# Local testing (5 concurrent users, 20 seconds)
k6 run tests/load.js

# Custom settings
k6 run tests/load.js \
  -e BASE_URL=http://localhost:3000 \
  -e VUS=10 \
  -e DURATION=30s

# Production URL (use with caution!)
k6 run tests/load.js \
  -e BASE_URL=https://onco-connect-run.preview.emergentagent.com \
  -e VUS=5 \
  -e DURATION=10s
```

### Run with Thresholds
```bash
# Fail if error rate exceeds 5%
k6 run tests/load.js --threshold 'http_req_failed{errorCode:!=429}:rate<=0.05'

# With detailed metrics output
k6 run tests/load.js -o json=results.json
k6 run tests/load.js -o csv=results.csv
```

---

## Performance Baselines

### Current Targets (5 concurrent users, 20s steady state)

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| **Response time (p50)** | <100ms | — | TBD |
| **Response time (p95)** | <500ms | — | TBD |
| **Response time (p99)** | <1000ms | — | TBD |
| **Error rate** | <1% | — | TBD |
| **Throughput** | >50 req/s | — | TBD |
| **DB latency (avg)** | <20ms | — | TBD |

### Bottlenecks to Watch

1. **Database query optimization**
   - Current: Indexed kv_store queries (O(log n))
   - Risk: Full table scans on unindexed columns
   - Fix: Monitor slow query logs

2. **Encryption overhead**
   - PHI encryption/decryption on every sync
   - Mitigation: Already using AES-256-GCM (hardware-accelerated on most servers)
   - Impact: ~5-10ms per record

3. **Concurrent connections**
   - SQLite write serialization (WAL mode helps)
   - Turso/Cloud SQLite: handles 100+ concurrent connections
   - Render pool size: auto-scales

4. **Large payloads**
   - Doctor with 1000+ patients = large sync payload
   - Mitigation: Pagination (TODO: implement)
   - Current: Entire keyspace mirrored

---

## Load Test Scenarios

### Scenario 1: Normal Usage (Baseline)
```bash
k6 run tests/load.js \
  -e VUS=5 \
  -e DURATION=30s
```
**Expected:** Mimics 5 users active simultaneously (1 doctor + 4 patients)  
**Use case:** Verify basic functionality under realistic load

### Scenario 2: Peak Load (Clinic Hours)
```bash
k6 run tests/load.js \
  -e VUS=20 \
  -e DURATION=60s
```
**Expected:** Clinic with 20 concurrent users  
**Use case:** Verify stability during busy clinic hours (10am-2pm)

### Scenario 3: Stress Test (Breaking Point)
```bash
k6 run tests/load.js \
  -e VUS=50 \
  -e DURATION=120s
```
**Expected:** Hospital deployment with 50 concurrent users  
**Use case:** Find error rate, response time degradation, resource exhaustion

### Scenario 4: Soak Test (Long-running)
```bash
# Run for 2 hours at steady 10 concurrent users
k6 run tests/load.js \
  -e VUS=10 \
  -e DURATION=7200s
```
**Expected:** Memory leaks, connection pool exhaustion  
**Use case:** Catch resource leaks in production deployment

---

## Expected Results

### Healthy System (5 VUS)
```
HTTP Requests: 1,234 passed | 0 failed (0%)
Response Times:
  - min: 45ms
  - p50: 95ms
  - p95: 380ms
  - p99: 650ms
  - max: 1,240ms

Database Queries: avg 12ms (indexed)
Throughput: ~58 req/s
```

### Degraded System (20+ VUS)
```
HTTP Requests: 5,600 passed | 150 failed (2.6%)
Response Times:
  - p95: 1,200ms (exceeds SLA)
  - p99: 2,100ms

Bottleneck: Database write serialization (SQLite WAL limit)
Recommendation: Migrate to Turso distributed SQLite or PostgreSQL
```

### Overload (50 VUS)
```
HTTP Requests: 8,000 passed | 2,000 failed (20%)
Response Times:
  - p95: 5,000ms+ (severe degradation)
  - Timeouts: 10%+

Bottleneck: Connection pool exhausted, OOM on database server
Action: Scale horizontally (add server replicas) or implement rate limiting
```

---

## Interpreting Results

### ✅ Healthy Metrics
- **Error rate < 1%** — System handling load correctly
- **p95 < 500ms** — Acceptable performance for web UI
- **No timeouts** — Connection pool sized correctly
- **Flat response time curve** — No resource degradation

### ⚠️ Warning Signs
- **Error rate 1-5%** — Some requests failing; check error logs
- **p95 500-1000ms** — Getting slow; check database logs
- **Increasing response time** — Resource exhaustion (add cache or scale)
- **Connection timeouts** — Pool too small; increase or fix slow queries

### 🔴 Critical Issues
- **Error rate > 10%** — System unstable; immediate investigation needed
- **p95 > 2000ms** — Major bottleneck; likely database or network
- **OOM errors** — Add RAM or optimize memory usage
- **Crashed server** — Check logs; may be unhandled exception

---

## What's Being Tested

### Auth Flow ✅
- Doctor registration (email, password validation)
- Doctor login (session creation)
- Patient login (MRN + password)
- Session expiry & revocation

### Sync Operations ✅
- Doctor full keyspace pull (GET /api/sync)
- Doctor push with multiple keys (PUT /api/sync)
- Patient scoped pull (GET /api/sync/patient)
- Patient scoped push (PUT /api/sync/patient)

### Encryption ✅
- PHI encryption on every push
- PHI decryption on every pull
- PBKDF2 password hashing (~210k iterations)

### Database Operations ✅
- Indexed kv_store queries
- Encrypted value storage/retrieval
- Transaction rollback on errors

---

## What's NOT Being Tested

- ❌ Lab file uploads (multipart/form-data)
- ❌ WebSocket real-time updates (push notifications)
- ❌ Email sending (SMTP)
- ❌ Sentry error tracking (conditional)
- ❌ Turso-specific distributed features

---

## CI/CD Integration

### GitHub Actions
```yaml
- name: Load Test
  run: |
    k6 run tests/load.js \
      -e BASE_URL=http://localhost:3000 \
      -e VUS=5 \
      -e DURATION=30s \
      --threshold 'http_req_failed:rate<0.01' \
      --threshold 'http_req_duration:p(95)<500'
```

### Render Deploy Hook
Add to render.yaml:
```yaml
  postDeploy: |
    sleep 30  # wait for server startup
    if command -v k6 &> /dev/null; then
      k6 run tests/load.js -e BASE_URL=http://localhost:3000 || exit 1
    fi
```

---

## Scaling Guide

### Current Capacity
- **Database:** Turso (cloud SQLite, distributed)
- **App server:** Render free tier (512MB RAM, 1 CPU)
- **CDN:** Vercel (auto-scaling)
- **Max concurrent:** ~50 users before p95 > 1000ms

### Scale to 200 Users
1. **App:** Render Standard (2GB RAM, 2 CPUs) — $12/mo
2. **Database:** Turso Pro plan — $25/mo
3. **Add Redis cache** — Render Redis $15/mo
4. **Expected:** p95 < 300ms at 50 concurrent

### Scale to 1000+ Users
1. **Database:** Move to PostgreSQL (managed AWS RDS) — $100+/mo
2. **App:** Docker container orchestration (Kubernetes)
3. **Cache:** Redis cluster for session & data cache
4. **Monitoring:** DataDog or New Relic ($200+/mo)

---

## Next Steps

1. **Run baseline test** — `npm run load-test`
2. **Log results** — Compare p95, error rate, throughput
3. **Identify bottlenecks** — Check database slow query logs
4. **Optimize** — Add indexes, caching, pagination
5. **Retest** — Verify improvements
6. **Monitor production** — Set up alerts in Sentry/DataDog

---

**Status:** Load testing framework implemented  
**Priority:** Run quarterly to catch performance regressions  
**Owner:** DevOps / Performance team
