/**
 * Provider-neutral tool input/output schema abstraction.
 *
 * A tiny, dependency-free JSON-Schema subset: enough to describe required
 * fields, optional fields, field types, enums, string lengths, numeric
 * ranges, array items, and nested objects - and to REJECT missing required
 * fields, wrong types, malformed input, and unexpected fields.
 *
 * Deliberately NOT coupled to any schema library (Ajv, Zod, ...): the core
 * stays dependency-free, and the fastify API layer keeps its own request
 * validation. If a richer vocabulary is ever needed, this module is the one
 * place to extend.
 *
 * SECURITY: validation problem messages name FIELDS and expected types -
 * never the actual values, because input values are untrusted and could
 * contain secrets.
 */

export type ToolValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export const TOOL_VALUE_TYPES: readonly ToolValueType[] = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
];

export function isToolValueType(value: unknown): value is ToolValueType {
  return typeof value === 'string' && (TOOL_VALUE_TYPES as readonly string[]).includes(value);
}

/** Schema of a single field (or a whole nested value). */
export interface ToolFieldSchema {
  /** The JSON-like type this field must have. */
  readonly type: ToolValueType;
  /** Human explanation of the field (documentation only). */
  readonly description?: string;
  /** Allowed literal values (any type). */
  readonly enum?: readonly unknown[];
  /** Strings: minimum length. */
  readonly minLength?: number;
  /** Strings: maximum length. */
  readonly maxLength?: number;
  /** Numbers: minimum. */
  readonly minimum?: number;
  /** Numbers: maximum. */
  readonly maximum?: number;
  /** Arrays: schema every item must satisfy. */
  readonly items?: ToolFieldSchema;
  /** Objects: nested fields. */
  readonly properties?: Readonly<Record<string, ToolFieldSchema>>;
  /** Objects: names of nested required fields. */
  readonly requiredFields?: readonly string[];
  /** Objects: whether fields not in `properties` are rejected (default: true). */
  readonly additionalProperties?: boolean;
}

/** Schema of a tool's input or output - always a top-level object. */
export interface ToolObjectSchema {
  readonly type: 'object';
  readonly description?: string;
  readonly properties: Readonly<Record<string, ToolFieldSchema>>;
  /** Top-level required field names. */
  readonly required?: readonly string[];
  /** Reject top-level fields not in `properties` (default: true). */
  readonly additionalProperties?: boolean;
}

export interface DefineObjectSchemaInput {
  readonly description?: string;
  readonly properties: Readonly<Record<string, ToolFieldSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/** Validates the schema itself and creates an immutable object schema. */
export function defineObjectSchema(input: DefineObjectSchemaInput): ToolObjectSchema {
  const reasons: string[] = [];
  if (input === null || typeof input !== 'object') {
    throw new Error('Object schema must be defined with a properties map.');
  }
  if (input.properties === undefined || typeof input.properties !== 'object') {
    throw new Error('Object schema must provide a properties map.');
  }
  const propertyNames = Object.keys(input.properties);
  if (propertyNames.length === 0) {
    reasons.push('properties must declare at least one field');
  }
  for (const [name, field] of Object.entries(input.properties)) {
    const fieldProblems = validateFieldSchema(name, field);
    reasons.push(...fieldProblems);
  }
  for (const requiredName of input.required ?? []) {
    if (!propertyNames.includes(requiredName)) {
      reasons.push(`required field "${requiredName}" is not declared in properties`);
    }
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid object schema: ${reasons.join('; ')}.`);
  }
  return {
    type: 'object',
    ...(input.description !== undefined ? { description: input.description } : {}),
    properties: input.properties,
    ...(input.required !== undefined ? { required: [...input.required] } : {}),
    additionalProperties: input.additionalProperties ?? true,
  };
}

function validateFieldSchema(name: string, field: unknown): readonly string[] {
  const reasons: string[] = [];
  if (field === null || typeof field !== 'object') {
    return [`field "${name}" must be a schema object`];
  }
  const schema = field as Partial<ToolFieldSchema>;
  if (!isToolValueType(schema.type)) {
    reasons.push(`field "${name}" has an unknown type`);
  }
  if (schema.type === 'array' && schema.items === undefined) {
    reasons.push(`array field "${name}" must declare an items schema`);
  }
  if (schema.type === 'object' && schema.properties === undefined) {
    reasons.push(`object field "${name}" must declare a properties map`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    reasons.push(`field "${name}" enum must be an array`);
  }
  return reasons;
}

/** Returns the JS type of a value in schema terms. */
function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Validates a value against a field schema, appending human-readable problems. */
export function validateToolValue(
  schema: ToolFieldSchema,
  path: string,
  value: unknown,
  problems: string[],
): void {
  const actual = typeOf(value);
  const expected = schema.type;
  const matchesType =
    expected === 'null'
      ? value === null
      : expected === 'array'
        ? Array.isArray(value)
        : expected === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : typeof value === expected;
  if (!matchesType) {
    problems.push(`${path}: expected ${expected}, got ${actual}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value)) {
    problems.push(`${path}: value is not in the allowed set`);
    return;
  }
  if (expected === 'string' && typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${path}: string is too short (minimum ${schema.minLength})`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`${path}: string is too long (maximum ${schema.maxLength})`);
    }
  }
  if (expected === 'number' && typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path}: number is below the minimum`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${path}: number is above the maximum`);
    }
  }
  if (expected === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) =>
      validateToolValue(schema.items as ToolFieldSchema, `${path}[${index}]`, item, problems),
    );
  }
  if (
    expected === 'object' &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    validateNestedObject(schema, path, value as Record<string, unknown>, problems);
  }
}

function validateNestedObject(
  schema: ToolFieldSchema,
  path: string,
  value: Record<string, unknown>,
  problems: string[],
): void {
  const properties = schema.properties ?? {};
  const additionalAllowed = schema.additionalProperties ?? true;
  for (const key of Object.keys(value)) {
    if (!(key in properties) && !additionalAllowed) {
      problems.push(`${path}.${key}: unexpected field`);
    }
  }
  for (const requiredName of schema.requiredFields ?? []) {
    if (!(requiredName in value)) {
      problems.push(`${path}.${requiredName}: required field is missing`);
    }
  }
  for (const [name, fieldSchema] of Object.entries(properties)) {
    if (name in value) {
      validateToolValue(fieldSchema, `${path}.${name}`, value[name], problems);
    }
  }
}

/**
 * Validates tool input (or output) against a top-level object schema.
 * Returns every problem found - callers decide how to surface them.
 * Problems never contain the input values themselves.
 */
export function validateToolObject(schema: ToolObjectSchema, input: unknown): readonly string[] {
  const problems: string[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    problems.push('input: expected an object');
    return problems;
  }
  const record = input as Record<string, unknown>;
  const additionalAllowed = schema.additionalProperties ?? true;
  for (const key of Object.keys(record)) {
    if (!(key in schema.properties) && !additionalAllowed) {
      problems.push(`input.${key}: unexpected field`);
    }
  }
  for (const requiredName of schema.required ?? []) {
    if (!(requiredName in record)) {
      problems.push(`input.${requiredName}: required field is missing`);
    }
  }
  for (const [name, fieldSchema] of Object.entries(schema.properties)) {
    if (name in record) {
      validateToolValue(fieldSchema, `input.${name}`, record[name], problems);
    }
  }
  return problems;
}
