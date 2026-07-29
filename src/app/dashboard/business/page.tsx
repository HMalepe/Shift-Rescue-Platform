import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { PostShiftForm } from "./post-shift-form";
import { ApplicantActions } from "./applicant-actions";

export default async function BusinessDashboardPage() {
  const { user, profile } = await getCurrentUser();
  if (!user) redirect("/login");
  if (profile?.role !== "business") redirect("/dashboard/worker");

  const supabase = await createClient();
  const { data: shifts } = await supabase
    .from("shifts")
    .select(
      "*, shift_applications(id, status, created_at, profiles(id, full_name, phone))",
    )
    .eq("business_id", user.id)
    .order("starts_at", { ascending: true });

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Post a shift</h1>
      <PostShiftForm />

      <h2 className="mt-12 text-xl font-semibold">Your shifts</h2>
      <div className="mt-4 flex flex-col gap-6">
        {shifts?.length ? (
          shifts.map((shift) => (
            <div
              key={shift.id}
              className="rounded-md border border-black/10 p-4 dark:border-white/20"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-medium">{shift.title}</h3>
                  <p className="text-sm text-black/60 dark:text-white/60">
                    {shift.location} · ${shift.hourly_rate}/hr
                  </p>
                  <p className="text-sm text-black/60 dark:text-white/60">
                    {new Date(shift.starts_at).toLocaleString()} –{" "}
                    {new Date(shift.ends_at).toLocaleString()}
                  </p>
                </div>
                <span className="rounded-full bg-black/5 px-2 py-1 text-xs capitalize dark:bg-white/10">
                  {shift.status}
                </span>
              </div>

              <div className="mt-4">
                <h4 className="text-sm font-medium">Applicants</h4>
                {shift.shift_applications?.length ? (
                  <ul className="mt-2 flex flex-col gap-2">
                    {shift.shift_applications.map((application) => (
                      <li
                        key={application.id}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span>
                          {application.profiles?.full_name ?? "Worker"} —{" "}
                          <span className="capitalize">{application.status}</span>
                        </span>
                        {application.status === "pending" && (
                          <ApplicantActions applicationId={application.id} />
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-black/60 dark:text-white/60">
                    No applicants yet.
                  </p>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-black/60 dark:text-white/60">
            You haven&apos;t posted any shifts yet.
          </p>
        )}
      </div>
    </div>
  );
}
