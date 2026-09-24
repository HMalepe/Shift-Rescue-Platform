import { redirect } from "next/navigation";
import { requireRole } from "@/lib/guard";

export default async function AdminHome() {
  await requireRole("admin");
  redirect("/admin/accounts");
}
