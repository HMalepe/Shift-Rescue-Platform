import Link from "next/link";

const features = [
  {
    title: "Plug-and-Play Staffing",
    description:
      "Fully qualified and experienced professionals ready to step in seamlessly when regular staff are absent, sick, or on leave.",
  },
  {
    title: "Fully Registered & Verified",
    description:
      "Rigorous background, credential, and identity checks ensure complete compliance and quality assurance.",
  },
  {
    title: "Readily Available",
    description:
      "On-demand access to temporary talent to ensure zero workflow disruption or operational downtime.",
  },
  {
    title: "Cross-Industry Coverage",
    description:
      "Built to support diverse sectors needing reliable shift relief at short notice.",
  },
  {
    title: "High Reliability",
    description:
      "A dependable talent pool engineered for speed, trust, and minimal onboarding overhead.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <section className="text-center">
        <h1 className="text-4xl font-semibold sm:text-5xl">
          Emergency shift coverage, sorted in minutes.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-black/60 dark:text-white/60">
          Shift Rescue connects businesses with fully qualified, verified, and
          readily available plug-and-play staff for instant shift coverage.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <Link
            href="/signup"
            className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background"
          >
            Post a shift
          </Link>
          <Link
            href="/signup"
            className="rounded-md border border-black/10 px-5 py-2.5 text-sm font-medium dark:border-white/20"
          >
            Find shifts
          </Link>
        </div>
      </section>

      <section className="mt-20 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="rounded-lg border border-black/10 p-5 dark:border-white/20"
          >
            <h2 className="font-medium">{feature.title}</h2>
            <p className="mt-2 text-sm text-black/60 dark:text-white/60">
              {feature.description}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
