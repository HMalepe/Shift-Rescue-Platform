import { router, publicProcedure } from "./trpc";
import { shiftsRouter } from "./routers/shifts";
import { bookingsRouter } from "./routers/bookings";

export const appRouter = router({
  /** Cheap authenticated-or-not probe, used by clients to decide on a refresh. */
  me: publicProcedure.query(({ ctx }) =>
    ctx.user
      ? { authenticated: true as const, id: ctx.user.id, role: ctx.user.role }
      : { authenticated: false as const },
  ),
  shifts: shiftsRouter,
  bookings: bookingsRouter,
});

/** Consumed by apps/web and apps/mobile for end-to-end type safety. */
export type AppRouter = typeof appRouter;
