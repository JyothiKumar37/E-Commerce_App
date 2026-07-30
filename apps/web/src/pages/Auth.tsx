import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/store/auth";
import { ApiError } from "@/lib/api";
import { Alert, Button, Card, Field, PageSpinner, TextInput } from "@/components/ui";

/** Mirrors the gateway's Joi rules so the user gets feedback before submitting. */
const PASSWORD_RULES = [
  { test: (v: string) => v.length >= 10, label: "At least 10 characters" },
  { test: (v: string) => /[a-z]/.test(v), label: "A lowercase letter" },
  { test: (v: string) => /[A-Z]/.test(v), label: "An uppercase letter" },
  { test: (v: string) => /\d/.test(v), label: "A number" },
  { test: (v: string) => /[^A-Za-z0-9]/.test(v), label: "A symbol" },
];

export function SignInPage() {
  const { signIn, user, initialising } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (initialising) return <PageSpinner />;
  if (user) return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Card className="p-8">
        <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          New here?{" "}
          <Link
            to={`/signup?next=${encodeURIComponent(next)}`}
            className="text-brand-600 hover:underline"
          >
            Create an account
          </Link>
        </p>

        {error && (
          <div className="mt-6">
            <Alert kind="error">{error}</Alert>
          </div>
        )}

        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          <Field label="Email" htmlFor="email" required>
            <TextInput
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="Password" htmlFor="password" required>
            <TextInput
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Button type="submit" fullWidth size="lg" loading={submitting}>
            Sign in
          </Button>
        </form>

        <p className="mt-6 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          Demo account: <code>demo@example.com</code> / <code>Password123!</code>
        </p>
      </Card>
    </div>
  );
}

export function SignUpPage() {
  const { signUp, user, initialising } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") ?? "/";

  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    username: "",
    email: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  if (initialising) return <PageSpinner />;
  if (user) return <Navigate to={next} replace />;

  const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const passwordOk = PASSWORD_RULES.every((rule) => rule.test(form.password));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      await signUp(form);
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        // Server-side field errors map straight onto the inputs.
        setFieldErrors(err.fieldErrors);
      } else {
        setError("Could not create your account. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Card className="p-8">
        <h1 className="text-2xl font-bold tracking-tight">Create an account</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Already have one?{" "}
          <Link
            to={`/signin?next=${encodeURIComponent(next)}`}
            className="text-brand-600 hover:underline"
          >
            Sign in
          </Link>
        </p>

        {error && (
          <div className="mt-6">
            <Alert kind="error">{error}</Alert>
          </div>
        )}

        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" htmlFor="first_name" required error={fieldErrors.first_name}>
              <TextInput
                id="first_name"
                autoComplete="given-name"
                required
                value={form.first_name}
                onChange={update("first_name")}
                invalid={Boolean(fieldErrors.first_name)}
              />
            </Field>
            <Field label="Last name" htmlFor="last_name" required error={fieldErrors.last_name}>
              <TextInput
                id="last_name"
                autoComplete="family-name"
                required
                value={form.last_name}
                onChange={update("last_name")}
                invalid={Boolean(fieldErrors.last_name)}
              />
            </Field>
          </div>

          <Field
            label="Username"
            htmlFor="username"
            required
            error={fieldErrors.username}
            hint="Letters and numbers only, 3–30 characters."
          >
            <TextInput
              id="username"
              autoComplete="username"
              required
              value={form.username}
              onChange={update("username")}
              invalid={Boolean(fieldErrors.username)}
            />
          </Field>

          <Field label="Email" htmlFor="signup-email" required error={fieldErrors.email}>
            <TextInput
              id="signup-email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={update("email")}
              invalid={Boolean(fieldErrors.email)}
            />
          </Field>

          <Field label="Password" htmlFor="signup-password" required error={fieldErrors.password}>
            <TextInput
              id="signup-password"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={update("password")}
              invalid={Boolean(fieldErrors.password)}
            />
          </Field>

          {form.password.length > 0 && (
            <ul className="space-y-1 text-xs">
              {PASSWORD_RULES.map((rule) => {
                const passed = rule.test(form.password);
                return (
                  <li
                    key={rule.label}
                    className={passed ? "text-emerald-600" : "text-slate-500 dark:text-slate-400"}
                  >
                    <span aria-hidden="true">{passed ? "✓" : "○"}</span> {rule.label}
                  </li>
                );
              })}
            </ul>
          )}

          <Button type="submit" fullWidth size="lg" loading={submitting} disabled={!passwordOk}>
            Create account
          </Button>
        </form>
      </Card>
    </div>
  );
}
