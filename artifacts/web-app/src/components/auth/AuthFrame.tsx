import { BrandMark } from "@/components/brand/BrandMark";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Navy backdrop + brand header shared by the sign-in, sign-up and password-reset screens. */
export function AuthFrame({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-gradient-to-br from-navy-900 via-navy-800 to-navy-950 px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-indigo-500/10 blur-3xl" />
      </div>
      <div className="relative flex w-full max-w-md flex-col items-center">
        <a href={basePath || "/"} className="mb-8 flex flex-col items-center text-center" aria-label="agencyBRIDGE home">
          <BrandMark size={64} tone="light" decorative className="mb-4 rounded-2xl shadow-lg shadow-blue-500/30" />
          <span className="font-display text-2xl font-bold tracking-tight text-white">
            agency<span className="font-extrabold">BRIDGE</span>
          </span>
          <span className="mt-1 text-sm text-blue-200/70">{subtitle}</span>
        </a>
        {children}
        <p className="mt-6 text-center text-xs text-blue-200/60">
          Your agency administrator manages who can sign in and what they can see.
        </p>
      </div>
    </div>
  );
}

/** Where to go after signing in: a same-site path from `redirect_url`, else the dashboard. */
export function redirectTarget(search: string): string {
  const raw = new URLSearchParams(search).get("redirect_url") ?? "";
  // Only a path on this site: no scheme, no protocol-relative "//host", no backslash tricks.
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw;
  return `${basePath}/dashboard`;
}
