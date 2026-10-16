import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/main/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
