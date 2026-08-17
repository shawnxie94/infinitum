import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Compile the current Prisma data model into a SQLite DDL snapshot.
// This does not read or create migration history and is not a deployment migration.
const root = process.cwd();
const prismaCliPath = path.resolve(root, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
const schemaPath = path.resolve(root, "prisma", "schema.prisma");
const outputPath = path.resolve(root, "prisma", "schema.sql");

if (!existsSync(prismaCliPath)) {
  throw new Error(`Prisma CLI not found at ${prismaCliPath}; run npm install first.`);
}

mkdirSync(path.dirname(outputPath), { recursive: true });

const sql = execFileSync(
  prismaCliPath,
  ["migrate", "diff", "--from-empty", "--to-schema-datamodel", schemaPath, "--script"],
  {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  },
);

writeFileSync(outputPath, sql, "utf8");
console.log(`SQLite schema snapshot generated: ${path.relative(root, outputPath)}`);
