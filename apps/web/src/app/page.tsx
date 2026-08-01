import { redirect } from "next/navigation";
import { homeFor, requireViewer } from "@/lib/guard";

/** Each role has one place its work lives; send them there. */
export default async function Home() {
  const viewer = await requireViewer();
  redirect(homeFor(viewer.role));
}
