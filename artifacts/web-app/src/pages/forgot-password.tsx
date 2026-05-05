import { useState } from "react";
import { useSignIn } from "@clerk/react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, Mail, KeyRound, Eye, EyeOff, CheckCircle } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type Stage = "email" | "verify" | "password" | "done";

export default function ForgotPasswordPage() {
  const { signIn, fetchStatus } = useSignIn();
  const isReady = fetchStatus === "idle" && signIn != null;

  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function extractError(err: unknown): string {
    if (err && typeof err === "object" && "errors" in err) {
      const errs = (err as { errors: Array<{ message: string }> }).errors;
      return errs?.[0]?.message ?? "An unexpected error occurred.";
    }
    if (err && typeof err === "object" && "message" in err) {
      return (err as { message: string }).message;
    }
    return "An unexpected error occurred. Please try again.";
  }

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    if (!isReady) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      // Step 1: Initialize sign-in with the user's identifier
      await signIn.create({ identifier: email });
      // Step 2: Send the password-reset code to their email
      const { error } = await signIn.resetPasswordEmailCode.sendCode();
      if (error) {
        setErrorMsg(error.message ?? "Failed to send reset code.");
      } else {
        setStage("verify");
      }
    } catch (err) {
      setErrorMsg(extractError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (!isReady) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      // Step 3: Verify the code — on success status transitions to 'needs_new_password'
      const { error } = await signIn.resetPasswordEmailCode.verifyCode({ code });
      if (error) {
        setErrorMsg(error.message ?? "Invalid or expired code.");
      } else {
        setStage("password");
      }
    } catch (err) {
      setErrorMsg(extractError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!isReady) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      // Step 4: Submit the new password — on success status transitions to 'complete'
      const { error } = await signIn.resetPasswordEmailCode.submitPassword({
        password,
        signOutOfOtherSessions: true,
      });
      if (error) {
        setErrorMsg(error.message ?? "Failed to update password.");
      } else {
        setStage("done");
      }
    } catch (err) {
      setErrorMsg(extractError(err));
    } finally {
      setLoading(false);
    }
  }

  const stageTitle: Record<Stage, string> = {
    email: "Reset your password",
    verify: "Check your email",
    password: "Set a new password",
    done: "Password updated",
  };

  const stageDescription: Record<Stage, string> = {
    email: "Enter your email and we'll send a reset code.",
    verify: `We sent a 6-digit code to ${email}. Enter it below.`,
    password: "Your code was verified. Choose a strong new password.",
    done: "You can now sign in with your new password.",
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 px-4">
      <div className="bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl">
        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-border">
          <div className="flex justify-center mb-4">
            <img src={`${basePath}/logo.svg`} alt="MediFlow" className="h-10 w-10" />
          </div>
          <h1 className="text-xl font-semibold text-center text-foreground">
            {stageTitle[stage]}
          </h1>
          <p className="text-sm text-muted-foreground text-center mt-1">
            {stageDescription[stage]}
          </p>
        </div>

        <div className="px-8 py-6">
          {errorMsg && (
            <Alert className="mb-4 border-destructive/50 bg-destructive/5">
              <AlertDescription className="text-destructive text-sm">
                {errorMsg}
              </AlertDescription>
            </Alert>
          )}

          {stage === "email" && (
            <form onSubmit={handleRequestCode} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email address</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                    disabled={loading || !isReady}
                    className="pl-9"
                  />
                </div>
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={loading || !email || !isReady}
              >
                {loading ? "Sending…" : "Send reset code"}
              </Button>
            </form>
          )}

          {stage === "verify" && (
            <form onSubmit={handleVerifyCode} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="code">Reset code</Label>
                <Input
                  id="code"
                  type="text"
                  placeholder="Enter 6-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoFocus
                  inputMode="numeric"
                  maxLength={8}
                  disabled={loading}
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={loading || code.length < 6}
              >
                {loading ? "Verifying…" : "Verify code"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => {
                  setCode("");
                  setErrorMsg(null);
                  setStage("email");
                }}
              >
                Change email or resend
              </Button>
            </form>
          )}

          {stage === "password" && (
            <form onSubmit={handleSubmitPassword} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="password">New password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Min. 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoFocus
                    minLength={8}
                    disabled={loading}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword((v) => !v)}
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={loading || password.length < 8}
              >
                {loading ? "Updating…" : "Set new password"}
              </Button>
            </form>
          )}

          {stage === "done" && (
            <div className="text-center space-y-4">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <p className="text-sm text-muted-foreground">
                Your password has been updated. Sign in to continue.
              </p>
              <Button asChild className="w-full">
                <Link href={`${basePath}/sign-in`}>Go to Sign In</Link>
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        {stage !== "done" && (
          <div className="px-8 pb-6 border-t border-border pt-4 bg-muted/30">
            <Link href={`${basePath}/sign-in`}>
              <span className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Sign In
              </span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
