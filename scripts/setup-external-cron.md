# External cron for Airsup job queue (free, Vercel Hobby-safe)

Vercel Hobby only allows **one cron per day** in `vercel.json`.  
The background AI pipeline (factory search → negotiation → matches) needs to run every few minutes.  
The solution: a free external HTTP scheduler pings `/api/internal/jobs`.

---

## Option A — cron-job.org (recommended, 100% free)

### 1 · Generate a CRON_SECRET

Run this in your terminal and copy the output:
```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2 · Add it to Vercel

**Vercel → airsup project → Settings → Environment Variables**

| Name | Value | Environments |
|------|-------|--------------|
| `CRON_SECRET` | (the hex string from step 1) | Production, Preview |

Then **redeploy** (or it won't take effect).

### 3 · Create the cron on cron-job.org

1. Sign up free at **https://cron-job.org**
2. **Dashboard → Create cronjob**

| Field | Value |
|-------|-------|
| URL | `https://airsup.vercel.app/api/internal/jobs` |
| Execution schedule | Every **2 minutes** (or 5 — your choice) |
| Request method | **GET** |
| Add header | `Authorization` : `Bearer <your-CRON_SECRET>` |

3. Save & enable. That's it.

### Verify it works

After the first run, **Vercel → airsup → Logs** should show a request to `/api/internal/jobs` returning `200`.  
You can also hit it manually:

```sh
CRON_SECRET="your-secret"
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  https://airsup.vercel.app/api/internal/jobs
# → {"ok":true}
```

---

## Option B — UptimeRobot (free HTTP monitor)

UptimeRobot's free tier checks URLs every **5 minutes** and doesn't support custom headers.  
Use it only as a **secondary heartbeat** alongside Option A, not as the primary trigger.

---

## Option C — GitHub Actions scheduled workflow

Add a `.github/workflows/cron.yml` (requires `workflow` scope on your PAT):

```yaml
name: Job poll
on:
  schedule:
    - cron: "*/5 * * * *"   # every 5 min (GitHub Actions min interval)
jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -f \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            https://airsup.vercel.app/api/internal/jobs
```

Add `CRON_SECRET` in **GitHub → repo → Settings → Secrets → Actions**.

---

## What the job does

`/api/internal/jobs` calls `runJobPollOnce()` which runs:

1. **Factory search** — scores candidates with AI, creates `outreach_logs`
2. **Negotiation** — Claude negotiates the brief with each factory
3. **Match processing** — converts accepted briefs into live `matches` (buyer ↔ factory connection)
4. **Timeline checks** — updates project status for overdue milestones

The daily Vercel cron (`0 2 * * *` in `vercel.json`) acts as a fallback safety net.
