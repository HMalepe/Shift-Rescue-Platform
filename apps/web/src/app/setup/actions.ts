"use server";

import { bootstrapAdminAccount, syncAdminPassword } from "@/lib/api";
import { readAdminEnv } from "@/lib/admin-env";

export type SetupState =
  | { ok: true; email: string }
  | { ok: false; message: string }
  | null;

export async function bootstrapAdmin(_prev: SetupState, _formData: FormData): Promise<SetupState> {
  const admin = readAdminEnv();
  if (!admin.configured) {
    return {
      ok: false,
      message: "Set ADMIN_EMAIL and ADMIN_PASSWORD on Vercel, then redeploy.",
    };
  }

  return bootstrapAdminAccount({
    email: admin.email,
    password: admin.password,
    fullName: admin.fullName,
  });
}

export async function applyAdminPassword(
  _prev: SetupState,
  _formData: FormData,
): Promise<SetupState> {
  const admin = readAdminEnv();
  if (!admin.configured) {
    return {
      ok: false,
      message: "Set ADMIN_EMAIL and ADMIN_PASSWORD on Vercel, then redeploy.",
    };
  }

  const syncSecret = process.env["ADMIN_SYNC_SECRET"] ?? "";
  if (syncSecret === "") {
    return {
      ok: false,
      message: "ADMIN_SYNC_SECRET is not set on Vercel.",
    };
  }

  return syncAdminPassword({
    email: admin.email,
    password: admin.password,
    fullName: admin.fullName,
    syncSecret,
  });
}
