"use server";

import { bootstrapAdminAccount } from "@/lib/api";

export type SetupState =
  | { ok: true; email: string; mfaSecret: string; otpauthUrl: string }
  | { ok: false; message: string }
  | null;

export async function bootstrapAdmin(_prev: SetupState, formData: FormData): Promise<SetupState> {
  return bootstrapAdminAccount({
    bootstrapSecret: String(formData.get("bootstrapSecret") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
  });
}
