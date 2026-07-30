import { useState, type FormEvent } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import {
  useAddresses,
  useChangePassword,
  useCreateAddress,
  useDeleteAddress,
  useProfile,
  useSetDefaultAddress,
  useUpdateProfile,
  type AddressInput,
} from "@/hooks/queries";
import { useAuth } from "@/store/auth";
import { useToast } from "@/store/toast";
import { ApiError } from "@/lib/api";
import { classNames, formatDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  PageSpinner,
  Select,
  TextInput,
} from "@/components/ui";

export function AccountLayout() {
  const { user, initialising } = useAuth();

  if (initialising) return <PageSpinner />;
  if (!user) {
    return (
      <EmptyState
        icon="🔐"
        title="Sign in to manage your account"
        action={
          <Link to="/signin?next=/account">
            <Button>Sign in</Button>
          </Link>
        }
      />
    );
  }

  const tabs = [
    { to: "/account", label: "Profile", end: true },
    { to: "/account/addresses", label: "Addresses", end: false },
    { to: "/account/security", label: "Security", end: false },
  ];

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold tracking-tight">Account</h1>

      <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Account sections">
          <ul className="space-y-1">
            {tabs.map((tab) => (
              <li key={tab.to}>
                <NavLink
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) =>
                    classNames(
                      "block rounded-lg px-3 py-2 text-sm font-medium transition",
                      isActive
                        ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                        : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                    )
                  }
                >
                  {tab.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- profile -------------------------------- */

export function ProfilePage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const { data: profile, isLoading } = useProfile(Boolean(user));
  const updateProfile = useUpdateProfile();

  const [form, setForm] = useState<{
    username?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
  }>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (isLoading || !profile) return <PageSpinner />;

  const value = (key: keyof typeof form, fallback: string) => form[key] ?? fallback;
  const dirty = Object.keys(form).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    updateProfile.mutate(form, {
      onSuccess: () => {
        notify("Profile updated.", "success");
        setForm({});
      },
      onError: (err) => {
        if (err instanceof ApiError) {
          notify(err.message, "error");
          // The API uses snake_case field names; map them to the inputs.
          const errors = err.fieldErrors;
          setFieldErrors({
            username: errors.username ?? "",
            email: errors.email ?? "",
            firstName: errors.first_name ?? "",
            lastName: errors.last_name ?? "",
          });
        } else {
          notify("Could not update your profile.", "error");
        }
      },
    });
  };

  return (
    <Card className="p-6">
      <h2 className="mb-1 font-semibold">Profile</h2>
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        Member since {formatDate(profile.createdAt)}
      </p>

      <form onSubmit={submit} className="max-w-md space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" htmlFor="firstName" error={fieldErrors.firstName || undefined}>
            <TextInput
              id="firstName"
              value={value("firstName", profile.firstName)}
              onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
            />
          </Field>
          <Field label="Last name" htmlFor="lastName" error={fieldErrors.lastName || undefined}>
            <TextInput
              id="lastName"
              value={value("lastName", profile.lastName)}
              onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
            />
          </Field>
        </div>

        <Field
          label="Username"
          htmlFor="account-username"
          error={fieldErrors.username || undefined}
        >
          <TextInput
            id="account-username"
            value={value("username", profile.username)}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
          />
        </Field>

        <Field label="Email" htmlFor="account-email" error={fieldErrors.email || undefined}>
          <TextInput
            id="account-email"
            type="email"
            value={value("email", profile.email)}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </Field>

        <div className="flex gap-3">
          <Button type="submit" loading={updateProfile.isPending} disabled={!dirty}>
            Save changes
          </Button>
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setForm({})}>
              Discard
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

/* ------------------------------- security -------------------------------- */

export function SecurityPage() {
  const { notify } = useToast();
  const { signOut } = useAuth();
  const changePassword = useChangePassword();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const mismatch = confirm.length > 0 && newPassword !== confirm;

  return (
    <Card className="p-6">
      <h2 className="mb-1 font-semibold">Change password</h2>
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        Changing your password signs you out of every device.
      </p>

      <form
        className="max-w-md space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          changePassword.mutate(
            { currentPassword, newPassword },
            {
              onSuccess: async () => {
                notify("Password updated. Please sign in again.", "success");
                await signOut();
              },
              onError: (err) =>
                notify(
                  err instanceof ApiError ? err.message : "Could not change password.",
                  "error",
                ),
            },
          );
        }}
      >
        <Field label="Current password" htmlFor="current-password" required>
          <TextInput
            id="current-password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </Field>

        <Field
          label="New password"
          htmlFor="new-password"
          required
          hint="At least 10 characters, with upper and lower case, a number and a symbol."
        >
          <TextInput
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>

        <Field
          label="Confirm new password"
          htmlFor="confirm-password"
          required
          error={mismatch ? "Passwords do not match." : undefined}
        >
          <TextInput
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            invalid={mismatch}
          />
        </Field>

        <Button
          type="submit"
          loading={changePassword.isPending}
          disabled={mismatch || newPassword.length < 10 || currentPassword.length === 0}
        >
          Change password
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------- addresses ------------------------------- */

const EMPTY_ADDRESS: AddressInput = {
  addressType: "home",
  recipientName: "",
  addressLine1: "",
  addressLine2: null,
  city: "",
  state: null,
  country: "",
  zip: "",
  phone: null,
  isDefault: false,
};

export function AddressesPage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const { data: addresses, isLoading } = useAddresses(Boolean(user));
  const createAddress = useCreateAddress();
  const deleteAddress = useDeleteAddress();
  const setDefault = useSetDefaultAddress();

  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<AddressInput>(EMPTY_ADDRESS);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (isLoading) return <PageSpinner />;

  const update = (key: keyof AddressInput) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    createAddress.mutate(draft, {
      onSuccess: () => {
        notify("Address added.", "success");
        setDraft(EMPTY_ADDRESS);
        setShowForm(false);
      },
      onError: (err) => {
        if (err instanceof ApiError) {
          notify(err.message, "error");
          setFieldErrors(err.fieldErrors);
        }
      },
    });
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Saved addresses</h2>
          <Button size="sm" variant="secondary" onClick={() => setShowForm((open) => !open)}>
            {showForm ? "Cancel" : "Add address"}
          </Button>
        </div>

        {!addresses || addresses.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            You have no saved addresses yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {addresses.map((address) => (
              <li
                key={address.addressId}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700"
              >
                <div className="text-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-medium">{address.recipientName}</span>
                    {address.isDefault && <Badge tone="info">Default</Badge>}
                    <Badge>{address.addressType}</Badge>
                  </div>
                  <address className="not-italic text-slate-600 dark:text-slate-400">
                    {address.addressLine1}
                    {address.addressLine2 ? `, ${address.addressLine2}` : ""}
                    <br />
                    {address.zip} {address.city}, {address.country}
                    {address.phone && (
                      <>
                        <br />
                        {address.phone}
                      </>
                    )}
                  </address>
                </div>

                <div className="flex gap-2">
                  {!address.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={setDefault.isPending}
                      onClick={() =>
                        setDefault.mutate(address.addressId, {
                          onSuccess: () => notify("Default address updated.", "success"),
                        })
                      }
                    >
                      Make default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      if (!window.confirm("Delete this address?")) return;
                      deleteAddress.mutate(address.addressId, {
                        onSuccess: () => notify("Address deleted.", "success"),
                        onError: (err) =>
                          notify(
                            err instanceof ApiError ? err.message : "Could not delete.",
                            "error",
                          ),
                      });
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {showForm && (
        <Card className="p-6">
          <h2 className="mb-4 font-semibold">New address</h2>
          <form onSubmit={submit} className="max-w-lg space-y-4" noValidate>
            <Field
              label="Recipient name"
              htmlFor="recipient"
              required
              error={fieldErrors.recipient_name}
            >
              <TextInput
                id="recipient"
                required
                value={draft.recipientName}
                onChange={update("recipientName")}
                autoComplete="name"
              />
            </Field>

            <Field
              label="Address line 1"
              htmlFor="line1"
              required
              error={fieldErrors.address_line1}
            >
              <TextInput
                id="line1"
                required
                value={draft.addressLine1}
                onChange={update("addressLine1")}
                autoComplete="address-line1"
              />
            </Field>

            <Field label="Address line 2" htmlFor="line2">
              <TextInput
                id="line2"
                value={draft.addressLine2 ?? ""}
                onChange={update("addressLine2")}
                autoComplete="address-line2"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="City" htmlFor="city" required error={fieldErrors.city}>
                <TextInput
                  id="city"
                  required
                  value={draft.city}
                  onChange={update("city")}
                  autoComplete="address-level2"
                />
              </Field>
              <Field label="Postal code" htmlFor="zip" required error={fieldErrors.zip}>
                <TextInput
                  id="zip"
                  required
                  value={draft.zip}
                  onChange={update("zip")}
                  autoComplete="postal-code"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="State / region" htmlFor="state">
                <TextInput
                  id="state"
                  value={draft.state ?? ""}
                  onChange={update("state")}
                  autoComplete="address-level1"
                />
              </Field>
              <Field label="Country" htmlFor="country" required error={fieldErrors.country}>
                <TextInput
                  id="country"
                  required
                  value={draft.country}
                  onChange={update("country")}
                  autoComplete="country-name"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone" htmlFor="phone">
                <TextInput
                  id="phone"
                  type="tel"
                  value={draft.phone ?? ""}
                  onChange={update("phone")}
                  autoComplete="tel"
                />
              </Field>
              <Field label="Type" htmlFor="address-type">
                <Select
                  id="address-type"
                  value={draft.addressType}
                  onChange={update("addressType")}
                >
                  <option value="home">Home</option>
                  <option value="work">Work</option>
                  <option value="billing">Billing</option>
                  <option value="shipping">Shipping</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(e) => setDraft((c) => ({ ...c, isDefault: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              Use as my default address
            </label>

            {Object.keys(fieldErrors).length > 0 && (
              <Alert kind="error">Please correct the highlighted fields.</Alert>
            )}

            <Button type="submit" loading={createAddress.isPending}>
              Save address
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
