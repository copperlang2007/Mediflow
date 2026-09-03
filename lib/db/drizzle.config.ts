import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Relative, not `path.join(__dirname, ...)`. drizzle-kit 0.31 prefixes the
  // configured `out` with "./" when it reads the meta folder, so an absolute
  // path becomes ".//home/.../migrations" and `generate` dies on ENOENT before
  // it does anything. Run drizzle-kit from this package directory.
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    table: "__drizzle_migrations",
    schema: "public",
  },
});
