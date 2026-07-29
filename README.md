# Shift Rescue Platform

A reliable recruitment platform connecting businesses with fully qualified, verified, and readily available plug-and-play staff for instant shift coverage.

An on-demand staffing and recruitment platform designed to solve emergency shift coverage and temporary staffing gaps. We connect businesses across all industries with pre-screened, verified, and ready-to-deploy casual workers.

- **Plug-and-Play Staffing:** Fully qualified and experienced professionals ready to step in seamlessly when regular staff are absent, sick, or on leave.
- **Fully Registered & Verified:** Rigorous background, credential, and identity checks ensure complete compliance and quality assurance.
- **Readily Available:** On-demand access to temporary talent to ensure zero workflow disruption or operational downtime.
- **Cross-Industry Coverage:** Built to support diverse sectors needing reliable shift relief at short notice.
- **High Reliability:** A dependable talent pool engineered for speed, trust, and minimal onboarding overhead.

## Stack

- [Next.js 16](https://nextjs.org) (App Router, TypeScript)
- [Tailwind CSS v4](https://tailwindcss.com)
- [Supabase](https://supabase.com) for auth, Postgres, and row-level security

## Getting started

1. Create a Supabase project.
2. Run the SQL migration in `supabase/migrations/0001_init.sql` against it (via the SQL editor or `supabase db push`).
3. Copy `.env.example` to `.env.local` and fill in your Supabase project URL and anon key.
4. Install dependencies and run the dev server:

   ```bash
   npm install
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## Current MVP scope

- Sign up / log in as a **business** or a **worker**.
- Businesses post shifts (title, location, time window, hourly rate) and review/accept or decline applicants.
- Workers browse open shifts and apply with one click.

Not yet built: identity/credential verification, payments, notifications.

## Project structure

- `src/app` — routes (landing page, auth, dashboards)
- `src/lib/supabase` — Supabase client/server helpers and generated types
- `src/lib/auth` — auth server actions and session helper
- `src/lib/shifts` — shift/application server actions
- `supabase/migrations` — SQL schema and RLS policies
- `src/proxy.ts` — route guard for `/dashboard/*` (Next.js 16 renamed Middleware to Proxy)
