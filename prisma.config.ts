import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Default fallback for build time when DATABASE_URL isn't set yet
    url: process.env.DATABASE_URL || "postgresql://localhost:5432/dummy",
  },
});
