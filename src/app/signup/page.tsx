"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { signup } from "@/lib/auth/actions";
import type { UserRole } from "@/lib/supabase/types";

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signup, undefined);
  const [role, setRole] = useState<UserRole>("business");

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold">Sign up</h1>

      <div className="mt-6 flex gap-2 rounded-md border border-black/10 p-1 dark:border-white/20">
        <button
          type="button"
          onClick={() => setRole("business")}
          className={`flex-1 rounded px-3 py-2 text-sm font-medium ${
            role === "business" ? "bg-foreground text-background" : ""
          }`}
        >
          I&apos;m hiring
        </button>
        <button
          type="button"
          onClick={() => setRole("worker")}
          className={`flex-1 rounded px-3 py-2 text-sm font-medium ${
            role === "worker" ? "bg-foreground text-background" : ""
          }`}
        >
          I want shifts
        </button>
      </div>

      <form action={formAction} className="mt-6 flex flex-col gap-4">
        <input type="hidden" name="role" value={role} />
        <label className="flex flex-col gap-1 text-sm">
          Full name
          <input
            name="fullName"
            required
            className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
          />
        </label>
        {role === "business" && (
          <label className="flex flex-col gap-1 text-sm">
            Company name
            <input
              name="companyName"
              required
              className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
          />
        </label>
        {state?.error && (
          <p className="text-sm text-red-600">{state.error}</p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="mt-6 text-sm">
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
