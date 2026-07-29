import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";

export default async function DashboardPage() {
  const { user, profile } = await getCurrentUser();

  if (!user) redirect("/login");
  if (!profile) redirect("/login");

  redirect(profile.role === "business" ? "/dashboard/business" : "/dashboard/worker");
}
