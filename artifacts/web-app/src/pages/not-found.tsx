import { Link } from "wouter";
import { ArrowLeft, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandLockup } from "@/components/brand/BrandMark";

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] w-full flex-col bg-background">
      <header className="flex h-16 items-center border-b border-border bg-card px-4 sm:px-6">
        <Link href="/" aria-label="agencyBRIDGE home">
          <BrandLockup size={32} wordmarkClassName="text-base text-foreground" />
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-accent">
            <Compass className="h-7 w-7" />
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight">We couldn't find that page</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The link may be old, or the page may have moved. Nothing is wrong with your account —
            head back to your dashboard and pick up from there.
          </p>
          <Button asChild className="mt-6">
            <Link href="/dashboard">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to my dashboard
            </Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
