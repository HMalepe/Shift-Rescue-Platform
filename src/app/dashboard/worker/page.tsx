import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { ApplyButton } from "./apply-button";

export default async function WorkerDashboardPage() {
  const { user, profile } = await getCurrentUser();
  if (!user) redirect("/login");
  if (profile?.role !== "worker") redirect("/dashboard/business");

  const supabase = await createClient();

  const { data: myApplications } = await supabase
    .from("shift_applications")
    .select("shift_id, status")
    .eq("worker_id", user.id);

  const appliedShiftIds = new Set(myApplications?.map((a) => a.shift_id));
  const statusByShiftId = new Map(
    myApplications?.map((a) => [a.shift_id, a.status]),
  );

  const { data: shifts } = await supabase
    .from("shifts")
    .select("*, profiles(company_name, full_name)")
    .eq("status", "open")
    .order("starts_at", { ascending: true });

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Open shifts</h1>
      <div className="mt-6 flex flex-col gap-4">
        {shifts?.length ? (
          shifts.map((shift) => {
            const applied = appliedShiftIds.has(shift.id);
            return (
              <div
                key={shift.id}
                className="rounded-md border border-black/10 p-4 dark:border-white/20"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-medium">{shift.title}</h3>
                    <p className="text-sm text-black/60 dark:text-white/60">
                      {shift.profiles?.company_name ?? shift.profiles?.full_name}
                    </p>
                    <p className="text-sm text-black/60 dark:text-white/60">
                      {shift.location} · ${shift.hourly_rate}/hr
                    </p>
                    <p className="text-sm text-black/60 dark:text-white/60">
                      {new Date(shift.starts_at).toLocaleString()} –{" "}
                      {new Date(shift.ends_at).toLocaleString()}
                    </p>
                    {shift.description && (
                      <p className="mt-2 text-sm">{shift.description}</p>
                    )}
                  </div>
                  <ApplyButton
                    shiftId={shift.id}
                    applied={applied}
                    status={statusByShiftId.get(shift.id)}
                  />
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-sm text-black/60 dark:text-white/60">
            No open shifts right now — check back soon.
          </p>
        )}
      </div>
    </div>
  );
}
