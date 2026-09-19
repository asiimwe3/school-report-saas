import { PrismaClient } from "@prisma/client";

/** Lazy singleton — never instantiated at import time (build-safe). */
let _prisma: PrismaClient | null = null;

export function prisma(): PrismaClient {
  if (!_prisma) _prisma = new PrismaClient();
  return _prisma;
}
