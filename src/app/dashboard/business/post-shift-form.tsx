"use client";

import { useActionState } from "react";
import { postShift } from "@/lib/shifts/actions";

export function PostShiftForm() {
  const [state, formAction, pending] = useActionState(postShift, undefined);

  return (
    <form action={formAction} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input
          name="title"
          required
          placeholder="Weekend line cook"
          className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Location
        <input
          name="location"
          required
          placeholder="Downtown, Cape Town"
          className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Starts at
        <input
          name="startsAt"
          type="datetime-local"
          required
          className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Ends at
        <input
          name="endsAt"
          type="datetime-local"
          required
          className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Hourly rate (USD)
        <input
          name="hourlyRate"
          type="number"
          min={0}
          step="0.01"
          required
          className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
        Description
        <textarea
          name="description"
          rows={3}
          className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
        />
      </label>
      {state?.error && (
        <p className="text-sm text-red-600 sm:col-span-2">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50 sm:col-span-2 sm:w-fit"
      >
        {pending ? "Posting…" : "Post shift"}
      </button>
    </form>
  );
}
