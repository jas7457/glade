/**
 * Plain JSON Schema (the flat objects Glade's tool specs use: string / number / boolean
 * properties, `required`) → a zod raw shape for the Claude Agent SDK's `tool()` (I-173).
 * Anything else becomes `z.unknown()`.
 */
import { z } from "zod";

type Schema = Record<string, unknown>;

function field(schema: Schema): z.ZodType {
  const description = typeof schema.description === "string" ? schema.description : undefined;
  let type: z.ZodType;
  switch (schema.type) {
    case "string":
      type = z.string();
      break;
    case "number":
    case "integer":
      type = z.number();
      break;
    case "boolean":
      type = z.boolean();
      break;
    default:
      type = z.unknown();
  }
  return description ? type.describe(description) : type;
}

export function jsonSchemaShape(schema: Schema): Record<string, z.ZodType> {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, prop] of Object.entries(properties)) {
    const type = field(prop);
    shape[name] = required.has(name) ? type : type.optional();
  }
  return shape;
}
