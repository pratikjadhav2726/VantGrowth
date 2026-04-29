import { loginAction } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const hasError = params.error === "invalid_credentials";

  return (
    <div className="mx-auto max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-bold text-gray-900">Sign in</h1>
      <p className="mt-1 text-sm text-gray-500">
        GrowthOS founder console access.
      </p>

      <form action={loginAction} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            placeholder="founder@example.com"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Password</span>
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            placeholder="••••••••"
          />
        </label>

        {hasError && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            Invalid credentials. Please try again.
          </p>
        )}

        <button
          type="submit"
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
