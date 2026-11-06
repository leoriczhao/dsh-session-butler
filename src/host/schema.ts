/**
 * Author-facing parameter DSL and its raw JSON-Schema projection for Host tools.
 *
 * `ctx.tools.register()` consumes raw JSON-Schema `ToolDefinition`s: the model
 * receives `parameters` verbatim as the function argument schema. The per-property
 * `required: true` form is only the authoring DSL of `defineTool()`, which
 * first-party plugins compile before registering; published third-party plugins
 * cannot import `@deepseek-ai/dsh-tools`, so this module owns the same compile
 * step for Threadloom. Registering the property map directly made native
 * function calling fail with `Invalid schema for function ...: got 'type: null'`
 * because a bare property map has no outer `{type: 'object'}` root.
 *
 * The compiler emits only the JSON Schema subset DSH enforces
 * (`type/properties/required/additionalProperties/items/enum/description`), so
 * the projection also satisfies `assertSupportedJsonSchema` and PTC mode can
 * generate typed argument declarations from it.
 *
 * @module dsh-session-butler/host/schema
 */

/** One author-facing parameter node for a tool argument. */
export interface ButlerToolParameter {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  /** Human-readable description projected into JSON Schema. */
  readonly description?: string
  /** Marks this property as required in the enclosing parameter object. */
  readonly required?: true
  /** Allowed scalar values; valid only on scalar nodes. */
  readonly enum?: readonly (string | number | boolean | null)[]
  /** Item schema for array nodes. */
  readonly items?: ButlerToolParameter
  /** Nested property map for object nodes (property-level `required` applies inside). */
  readonly properties?: Readonly<Record<string, ButlerToolParameter>>
  /** Object openness; mandatory on object nodes, matching the DSH authoring DSL. */
  readonly additionalProperties?: boolean
}

/** Implicit parameter-root property map authors declare for one tool. */
export type ButlerParameterSpec = Readonly<Record<string, ButlerToolParameter>>

/** One compiled JSON-Schema node in the DSH-supported subset. */
export type ButlerJsonSchemaNode = Readonly<Record<string, unknown>>

/**
 * Object-rooted JSON Schema sent to the model as `ToolSchema.parameters`.
 * The implicit parameter root stays open (no `additionalProperties: false`),
 * matching `defineTool()`'s compiled output.
 */
export interface ButlerParameterJsonSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, ButlerJsonSchemaNode>>
  readonly required?: readonly string[]
}

/** Throw one author-schema misuse with the offending parameter path. */
function schemaError(path: string, message: string): never {
  throw new TypeError(`invalid tool parameter schema at ${path}: ${message}`)
}

/** Compile one property map, collecting property-level requiredness. */
function compilePropertyMap(
  spec: Readonly<Record<string, ButlerToolParameter>>,
  path: string,
): { properties: Record<string, ButlerJsonSchemaNode>; required: string[] } {
  const properties: Record<string, ButlerJsonSchemaNode> = {}
  const required: string[] = []
  for (const [name, parameter] of Object.entries(spec)) {
    properties[name] = compileValueNode(parameter, `${path}.${name}`, true)
    if (parameter.required === true) required.push(name)
  }
  return { properties, required }
}

/** Compile one node without turning `required` into a schema keyword. */
function compileValueNode(parameter: ButlerToolParameter, path: string, allowRequired: boolean): ButlerJsonSchemaNode {
  if (parameter.required === true && !allowRequired) schemaError(path, 'required is only meaningful on a property')
  const node: Record<string, unknown> = { type: parameter.type }
  if (parameter.description !== undefined) node.description = parameter.description
  switch (parameter.type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      if (parameter.items !== undefined) schemaError(path, `items is not valid on ${parameter.type}`)
      if (parameter.properties !== undefined) schemaError(path, `properties is not valid on ${parameter.type}`)
      if (parameter.additionalProperties !== undefined) schemaError(path, `additionalProperties is not valid on ${parameter.type}`)
      if (parameter.enum !== undefined) {
        if (parameter.enum.length === 0) schemaError(path, 'enum must not be empty')
        node.enum = [...parameter.enum]
      }
      break
    case 'array':
      if (parameter.properties !== undefined) schemaError(path, 'properties is not valid on array')
      if (parameter.additionalProperties !== undefined) schemaError(path, 'additionalProperties is not valid on array')
      if (parameter.enum !== undefined) schemaError(path, 'enum is not valid on array')
      if (parameter.items !== undefined) node.items = compileValueNode(parameter.items, `${path}[]`, false)
      break
    case 'object': {
      if (parameter.items !== undefined) schemaError(path, 'items is not valid on object')
      if (parameter.enum !== undefined) schemaError(path, 'enum is not valid on object')
      if (parameter.additionalProperties === undefined) {
        schemaError(path, 'object nodes must declare additionalProperties: true | false')
      }
      const compiled = compilePropertyMap(parameter.properties ?? {}, `${path}{}`)
      node.properties = compiled.properties
      if (compiled.required.length > 0) node.required = compiled.required
      node.additionalProperties = parameter.additionalProperties
      break
    }
  }
  return node
}

/**
 * Compile an author-facing property map into the object-rooted JSON Schema the
 * Host sends to the model as the tool's `parameters`.
 * @param spec - per-property parameter declarations.
 * @returns Raw object schema accepted by `ctx.tools.register()`.
 */
export function compileParameterSchema(spec: ButlerParameterSpec): ButlerParameterJsonSchema {
  const compiled = compilePropertyMap(spec, 'parameters')
  return {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required.length === 0 ? {} : { required: compiled.required }),
  }
}
