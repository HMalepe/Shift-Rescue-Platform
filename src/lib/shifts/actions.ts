"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth/session";
import type { ApplicationStatus } from "@/lib/supabase/types";

export type ShiftFormState = { error: string } | undefined;

export async function postShift(
  _prevState: ShiftFormState,
  formData: FormData,
): Promise<ShiftFormState> {
  const { user, profile } = await getCurrentUser();
  if (!user || profile?.role !== "business") {
    return { error: "Only businesses can post shifts." };
  }

  const title = String(formData.get("title") ?? "");
  const description = String(formData.get("description") ?? "") || null;
  const location = String(formData.get("location") ?? "");
  const startsAt = String(formData.get("startsAt") ?? "");
  const endsAt = String(formData.get("endsAt") ?? "");
  const hourlyRate = Number(formData.get("hourlyRate") ?? 0);

  if (!title || !location || !startsAt || !endsAt || !hourlyRate) {
    return { error: "Please fill in all fields." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("shifts").insert({
    business_id: user.id,
    title,
    description,
    location,
    starts_at: new Date(startsAt).toISOString(),
    ends_at: new Date(endsAt).toISOString(),
    hourly_rate: hourlyRate,
  });

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/dashboard/business");
  redirect("/dashboard/business");
}

export async function applyToShift(shiftId: string) {
  const { user, profile } = await getCurrentUser();
  if (!user || profile?.role !== "worker") {
    throw new Error("Only workers can apply to shifts.");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("shift_applications").insert({
    shift_id: shiftId,
    worker_id: user.id,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/dashboard/worker");
}

export async function updateApplicationStatus(
  applicationId: string,
  status: ApplicationStatus,
) {
  const { user, profile } = await getCurrentUser();
  if (!user || profile?.role !== "business") {
    throw new Error("Only businesses can update applications.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("shift_applications")
    .update({ status })
    .eq("id", applicationId);

  if (error) {
    throw new Error(error.message);
  }

  if (status === "accepted") {
    const { data: application } = await supabase
      .from("shift_applications")
      .select("shift_id")
      .eq("id", applicationId)
      .single();

    if (application) {
      await supabase
        .from("shifts")
        .update({ status: "filled" })
        .eq("id", application.shift_id);
    }
  }

  revalidatePath("/dashboard/business");
}
