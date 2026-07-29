"use client";

import { useTransition } from "react";
import { updateApplicationStatus } from "@/lib/shifts/actions";

export function ApplicantActions({ applicationId }: { applicationId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex gap-2">
      <button
        disabled={isPending}
        onClick={() =>
          startTransition(() => updateApplicationStatus(applicationId, "accepted"))
        }
        className="rounded-md bg-foreground px-2 py-1 text-xs text-background disabled:opacity-50"
      >
        Accept
      </button>
      <button
        disabled={isPending}
        onClick={() =>
          startTransition(() => updateApplicationStatus(applicationId, "declined"))
        }
        className="rounded-md border border-black/10 px-2 py-1 text-xs disabled:opacity-50 dark:border-white/20"
      >
        Decline
      </button>
    </div>
  );
}
