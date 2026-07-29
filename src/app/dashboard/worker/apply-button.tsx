"use client";

import { useTransition } from "react";
import { applyToShift } from "@/lib/shifts/actions";
import type { ApplicationStatus } from "@/lib/supabase/types";

export function ApplyButton({
  shiftId,
  applied,
  status,
}: {
  shiftId: string;
  applied: boolean;
  status?: ApplicationStatus;
}) {
  const [isPending, startTransition] = useTransition();

  if (applied) {
    return (
      <span className="shrink-0 rounded-full bg-black/5 px-3 py-1.5 text-xs capitalize dark:bg-white/10">
        {status}
      </span>
    );
  }

  return (
    <button
      disabled={isPending}
      onClick={() => startTransition(() => applyToShift(shiftId))}
      className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
    >
      {isPending ? "Applying…" : "Apply"}
    </button>
  );
}
