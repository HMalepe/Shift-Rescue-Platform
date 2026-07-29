-- Shift Rescue Platform: core marketplace schema
-- Businesses post shifts; workers browse and apply; businesses accept applicants.

create type user_role as enum ('business', 'worker');
create type shift_status as enum ('open', 'filled', 'cancelled', 'completed');
create type application_status as enum ('pending', 'accepted', 'declined');

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role user_role not null,
  full_name text not null,
  company_name text,
  phone text,
  created_at timestamptz not null default now()
);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references profiles (id) on delete cascade,
  title text not null,
  description text,
  location text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  hourly_rate numeric(10, 2) not null check (hourly_rate >= 0),
  status shift_status not null default 'open',
  created_at timestamptz not null default now(),
  constraint shifts_ends_after_starts check (ends_at > starts_at)
);

create table shift_applications (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references shifts (id) on delete cascade,
  worker_id uuid not null references profiles (id) on delete cascade,
  status application_status not null default 'pending',
  created_at timestamptz not null default now(),
  unique (shift_id, worker_id)
);

create index shifts_business_id_idx on shifts (business_id);
create index shifts_status_idx on shifts (status);
create index shift_applications_shift_id_idx on shift_applications (shift_id);
create index shift_applications_worker_id_idx on shift_applications (worker_id);

-- Row Level Security

alter table profiles enable row level security;
alter table shifts enable row level security;
alter table shift_applications enable row level security;

-- profiles: anyone signed in can read profiles (needed to show applicant/business
-- names), but a user can only create/update their own row.
create policy "profiles are readable by authenticated users"
  on profiles for select
  to authenticated
  using (true);

create policy "users can insert their own profile"
  on profiles for insert
  to authenticated
  with check (auth.uid() = id);

create policy "users can update their own profile"
  on profiles for update
  to authenticated
  using (auth.uid() = id);

-- shifts: open shifts are visible to everyone signed in; a business can only
-- manage its own shifts.
create policy "shifts are readable by authenticated users"
  on shifts for select
  to authenticated
  using (true);

create policy "businesses can insert their own shifts"
  on shifts for insert
  to authenticated
  with check (
    auth.uid() = business_id
    and exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.role = 'business'
    )
  );

create policy "businesses can update their own shifts"
  on shifts for update
  to authenticated
  using (auth.uid() = business_id);

create policy "businesses can delete their own shifts"
  on shifts for delete
  to authenticated
  using (auth.uid() = business_id);

-- shift_applications: a worker can see and create their own applications; a
-- business can see (and accept/decline) applications for its own shifts.
create policy "workers can view their own applications"
  on shift_applications for select
  to authenticated
  using (auth.uid() = worker_id);

create policy "businesses can view applications for their shifts"
  on shift_applications for select
  to authenticated
  using (
    exists (
      select 1 from shifts
      where shifts.id = shift_applications.shift_id
        and shifts.business_id = auth.uid()
    )
  );

create policy "workers can apply to shifts"
  on shift_applications for insert
  to authenticated
  with check (
    auth.uid() = worker_id
    and exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.role = 'worker'
    )
  );

create policy "businesses can update applications for their shifts"
  on shift_applications for update
  to authenticated
  using (
    exists (
      select 1 from shifts
      where shifts.id = shift_applications.shift_id
        and shifts.business_id = auth.uid()
    )
  );
