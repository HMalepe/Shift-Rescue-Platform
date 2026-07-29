import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { logout } from "@/lib/auth/actions";

export async function Nav() {
  const { user, profile } = await getCurrentUser();

  return (
    <header className="border-b border-black/10 dark:border-white/20">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <Link href="/" className="font-semibold">
          Shift Rescue
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          {user ? (
            <>
              <Link href="/dashboard" className="hover:underline">
                Dashboard
              </Link>
              <span className="text-black/60 dark:text-white/60">
                {profile?.full_name}
              </span>
              <form action={logout}>
                <button className="rounded-md border border-black/10 px-3 py-1.5 dark:border-white/20">
                  Log out
                </button>
              </form>
            </>
          ) : (
            <>
              <Link href="/login" className="hover:underline">
                Log in
              </Link>
              <Link
                href="/signup"
                className="rounded-md bg-foreground px-3 py-1.5 text-background"
              >
                Sign up
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
