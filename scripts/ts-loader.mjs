import { access } from "node:fs/promises";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js")) {
    const candidate = `${specifier.slice(0, -3)}.ts`;
    try {
      await access(new URL(candidate, context.parentURL));
      return nextResolve(candidate, context);
    } catch {
      // Let Node report the original resolution error.
    }
  }
  return nextResolve(specifier, context);
}
