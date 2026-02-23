import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Use DATABASE_URL if available (runtime), otherwise use a dummy URL for build
    url: env("DATABASE_URL", {
      default: "postgresql://dummy:dummy@localhost:5432/dummy?sslmode=disable",
    }),
  },
});
