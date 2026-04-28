import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  // Keep existing migrations in the drizzle/ folder; drizzle-kit will append.
  migrations: {
    table: "__drizzle_migrations",
    schema: "growthos",
  },
  verbose: true,
  strict: true,
});
