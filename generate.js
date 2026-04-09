const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { Project, SyntaxKind } = require('ts-morph');

// Encapsulates the OpenAPI component registry — tracks schemas, their source declarations,
// and handles disambiguation when different types share the same name.
class ComponentRegistry {
  constructor() {
    this.schemas = {};
    // componentName → source file path (tracks origin for disambiguation)
    this._declarations = {};
    // "TypeName:sourcePath" → resolved component name (avoids re-computation)
    this._sourceCache = {};
  }

  // Resolve a type to a $ref, registering it as a new component if needed.
  // `cleanTypeName` is the sanitized OpenAPI-safe name, `currentDeclPath` is the
  // source file the type was declared in, and `computeFn` is a lazy thunk that
  // produces the schema shape (called only when a new entry is needed).
  resolveRef(cleanTypeName, currentDeclPath, computeFn) {
    const sourceKey = `${cleanTypeName}:${currentDeclPath}`;
    const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

    // Fast path: we've already resolved this exact source before
    if (this._sourceCache[sourceKey]) {
      return ref(this._sourceCache[sourceKey]);
    }

    // First time seeing this type name — register it
    if (!this.schemas[cleanTypeName]) {
      this._declarations[cleanTypeName] = currentDeclPath;
      this._sourceCache[sourceKey] = cleanTypeName;
      this.schemas[cleanTypeName] = { type: 'object' }; // placeholder to break cycles
      this.schemas[cleanTypeName] = computeFn();
      return ref(cleanTypeName);
    }

    // Name exists from the same source file
    if (this._declarations[cleanTypeName] === currentDeclPath) {
      this._sourceCache[sourceKey] = cleanTypeName;
      return ref(cleanTypeName);
    }

    // Check existing numbered variants for a matching source file
    let counter = 2;
    while (this.schemas[`${cleanTypeName}${counter}`]) {
      if (this._declarations[`${cleanTypeName}${counter}`] === currentDeclPath) {
        this._sourceCache[sourceKey] = `${cleanTypeName}${counter}`;
        return ref(this._sourceCache[sourceKey]);
      }
      counter++;
    }

    // New source file — compute schema, then check for structural duplicates
    const candidateName = `${cleanTypeName}${counter}`;
    this._declarations[candidateName] = currentDeclPath;
    this.schemas[candidateName] = { type: 'object' }; // placeholder to break cycles
    const newSchema = computeFn();
    this.schemas[candidateName] = newSchema;

    const newSchemaStr = JSON.stringify(newSchema);

    // Check if it matches the base type or any existing numbered variant
    if (JSON.stringify(this.schemas[cleanTypeName]) === newSchemaStr) {
      delete this.schemas[candidateName];
      delete this._declarations[candidateName];
      this._sourceCache[sourceKey] = cleanTypeName;
      return ref(cleanTypeName);
    }
    for (let i = 2; i < counter; i++) {
      const variantName = `${cleanTypeName}${i}`;
      if (JSON.stringify(this.schemas[variantName]) === newSchemaStr) {
        delete this.schemas[candidateName];
        delete this._declarations[candidateName];
        this._sourceCache[sourceKey] = variantName;
        return ref(variantName);
      }
    }

    // Structurally different — keep the disambiguated entry
    this._sourceCache[sourceKey] = candidateName;
    return ref(candidateName);
  }
}

// SDK-only types that don't correspond to real API parameters (e.g., TokenOverridable adds a `token`
// property that is handled via the Authorization header, not the request body)
const sdkOnlyTypes = new Set(['TokenOverridable']);

// Utility and wrapper type sets (module-level to avoid re-creation per call)
const utilityTypes = new Set(['Partial', 'Pick', 'Omit', 'Required', 'Readonly', 'Record']);
const wrapperTypes = new Set(['Array', 'Promise']);

// Module-level registry instance (replaced per generate() call in tests)
let registry = new ComponentRegistry();

// Convert JSDoc {@link url text} to markdown [text](url)
function convertJsDocLinks(str) {
  // codeql[js/polynomial-redos] Input is from OpenAPI spec descriptions, not user-controlled
  return str.replace(/\{@link\s+(\S+?)(?:\s+([^}]*))?\}/g, (_, url, text) =>
    text ? `[${text.trim()}](${url})` : `[${url}](${url})`,
  );
}

// Extract inline properties + required from a branch (plain object or allOf wrapper)
function getInlineProps(branch) {
  const sources = [];
  if (branch.type === 'object' && branch.properties) {
    sources.push(branch);
  } else if (Array.isArray(branch.allOf)) {
    for (const item of branch.allOf) {
      if (item.type === 'object' && item.properties) sources.push(item);
    }
  }
  if (sources.length === 0) return null;
  const props = {};
  const required = new Set();
  for (const src of sources) {
    Object.assign(props, src.properties);
    for (const r of src.required || []) required.add(r);
  }
  return { props, required };
}

// Given an array of schema branches, hoist out common inline properties.
// Returns null if nothing could be hoisted, otherwise { hoisted, cleaned }.
function hoistCommonProperties(branches) {
  if (branches.length < 2) return null;

  const branchProps = branches.map(getInlineProps);
  if (!branchProps.every((b) => b !== null)) return null;

  const firstProps = branchProps[0];
  const commonProps = Object.keys(firstProps.props).filter((propName) => {
    const firstSchema = JSON.stringify(firstProps.props[propName]);
    const firstRequired = firstProps.required.has(propName);
    return branchProps.every((bp) => {
      if (!(propName in bp.props)) return false;
      if (JSON.stringify(bp.props[propName]) !== firstSchema) return false;
      return bp.required.has(propName) === firstRequired;
    });
  });

  if (commonProps.length === 0) return null;

  // Build the hoisted common object
  const hoistedObject = { type: 'object', properties: {} };
  const hoistedRequired = commonProps.filter((p) => firstProps.required.has(p));
  for (const propName of commonProps) {
    hoistedObject.properties[propName] = firstProps.props[propName];
  }
  if (hoistedRequired.length > 0) hoistedObject.required = hoistedRequired;

  // Remove hoisted properties from each branch
  const commonSet = new Set(commonProps);
  const cleanedBranches = branches
    .map((branch) => {
      if (branch.type === 'object' && branch.properties) {
        const remainingProps = {};
        for (const [k, v] of Object.entries(branch.properties)) {
          if (!commonSet.has(k)) remainingProps[k] = v;
        }
        if (Object.keys(remainingProps).length === 0) return null;
        const cleaned = { type: 'object', properties: remainingProps };
        const remainingRequired = (branch.required || []).filter((r) => !commonSet.has(r));
        if (remainingRequired.length > 0) cleaned.required = remainingRequired;
        return cleaned;
      }
      if (Array.isArray(branch.allOf)) {
        const cleanedAllOf = branch.allOf
          .map((item) => {
            if (!(item.type === 'object' && item.properties)) return item;
            const remainingProps = {};
            for (const [k, v] of Object.entries(item.properties)) {
              if (!commonSet.has(k)) remainingProps[k] = v;
            }
            if (Object.keys(remainingProps).length === 0) return null;
            const cleaned = { type: 'object', properties: remainingProps };
            const remainingRequired = (item.required || []).filter((r) => !commonSet.has(r));
            if (remainingRequired.length > 0) cleaned.required = remainingRequired;
            return cleaned;
          })
          .filter((item) => item !== null);
        if (cleanedAllOf.length === 0) return null;
        if (cleanedAllOf.length === 1) return cleanedAllOf[0];
        return { allOf: cleanedAllOf };
      }
      return branch;
    })
    .filter((b) => b !== null);

  return { hoisted: hoistedObject, cleaned: cleanedBranches };
}

// Deduplicate an array of schema objects by JSON.stringify
function dedup(schemas) {
  const unique = [];
  const seen = new Set();
  for (const s of schemas) {
    const str = JSON.stringify(s);
    if (!seen.has(str)) {
      seen.add(str);
      unique.push(s);
    }
  }
  return unique;
}

// Combine an array of already-mapped OpenAPI schemas from a TypeScript union into a
// single schema, applying optimizations: enum collapsing, primitive type arrays,
// $ref hoisting, and common property hoisting.
function convertUnion(mappedTypes) {
  // If every branch is an 'allOf' (intersection), hoist common $refs
  if (mappedTypes.length > 1 && mappedTypes.every((t) => t.allOf)) {
    const firstBranchRefs = mappedTypes[0].allOf
      .filter((item) => item.$ref)
      .map((item) => item.$ref);
    const commonRefs = firstBranchRefs.filter((ref) =>
      mappedTypes.every((branch) => branch.allOf.some((item) => item.$ref === ref)),
    );

    if (commonRefs.length > 0) {
      const hoisted = commonRefs.map((ref) => ({ $ref: ref }));
      const cleanedBranches = mappedTypes.map((branch) => {
        const remaining = branch.allOf.filter(
          (item) => !item.$ref || !commonRefs.includes(item.$ref),
        );
        return remaining.length === 1 ? remaining[0] : { allOf: remaining };
      });

      const propHoist = hoistCommonProperties(cleanedBranches);
      if (propHoist) {
        const dedupedCleaned = dedup(propHoist.cleaned);
        const variant =
          dedupedCleaned.length === 0
            ? propHoist.hoisted
            : dedupedCleaned.length === 1
              ? { allOf: [propHoist.hoisted, dedupedCleaned[0]] }
              : { allOf: [propHoist.hoisted, { anyOf: dedupedCleaned }] };
        return { allOf: [...hoisted, variant] };
      }

      return { allOf: [...hoisted, { anyOf: cleanedBranches }] };
    }
  }

  // Deduplicate identical mapped types
  const uniqueTypes = dedup(mappedTypes);
  if (uniqueTypes.length === 1) return uniqueTypes[0];

  // Collapse string/number enums
  if (uniqueTypes.every((t) => t.type === 'string' && Array.isArray(t.enum))) {
    return { type: 'string', enum: uniqueTypes.flatMap((t) => t.enum) };
  }
  if (uniqueTypes.every((t) => t.type === 'number' && Array.isArray(t.enum))) {
    return { type: 'number', enum: uniqueTypes.flatMap((t) => t.enum) };
  }

  // OpenAPI 3.1: Collapse simple primitives into a type array (e.g., ["string", "null"])
  if (uniqueTypes.every((t) => typeof t.type === 'string' && Object.keys(t).length === 1)) {
    return { type: [...new Set(uniqueTypes.map((t) => t.type))] };
  }

  // Hoist common inline properties out of anyOf branches
  const propHoist = hoistCommonProperties(uniqueTypes);
  if (propHoist) {
    const dedupedCleaned = dedup(propHoist.cleaned);
    if (dedupedCleaned.length === 0) return propHoist.hoisted;
    const variant = dedupedCleaned.length === 1 ? dedupedCleaned[0] : { anyOf: dedupedCleaned };
    return { allOf: [propHoist.hoisted, variant] };
  }

  return { anyOf: uniqueTypes };
}

// Combine an array of already-mapped OpenAPI schemas from a TypeScript intersection
// into a single schema, squashing inline objects and merging $refs via allOf.
function convertIntersection(mappedTypes) {
  const validTypes = mappedTypes.filter((t) => Object.keys(t).length > 0);

  const refsAndOthers = validTypes.filter((t) => t.$ref || !t.properties);
  const inlineObjects = validTypes.filter((t) => !t.$ref && t.properties);

  if (inlineObjects.length > 1) {
    // Squash all inline properties, required arrays, and additionalProperties together
    const merged = { type: 'object', properties: {}, required: [] };
    let mergedAdditionalProps = null;

    for (const obj of inlineObjects) {
      Object.assign(merged.properties, obj.properties);
      if (obj.required) merged.required.push(...obj.required);
      if (obj.additionalProperties) mergedAdditionalProps = obj.additionalProperties;
    }

    if (merged.required.length > 0) {
      merged.required = [...new Set(merged.required)];
    } else {
      delete merged.required;
    }
    if (mergedAdditionalProps) merged.additionalProperties = mergedAdditionalProps;

    const finalTypes = [...refsAndOthers, merged];
    if (finalTypes.length === 1) return finalTypes[0];
    return { allOf: finalTypes };
  }

  if (validTypes.length === 1) return validTypes[0];
  if (validTypes.length > 1) return { allOf: validTypes };
}

// Extract description and deprecation status from a property's JSDoc comments.
function extractJsDocMeta(propDeclaration) {
  let description = '';
  let isDeprecated = false;

  if (propDeclaration && typeof propDeclaration.getJsDocs === 'function') {
    const jsDocs = propDeclaration.getJsDocs();
    if (jsDocs.length > 0) {
      const rawDoc = jsDocs[0].getText();
      if (rawDoc.includes('@deprecated')) isDeprecated = true;
      description = rawDoc
        .replace(/^\/\*\*|\*\/$/g, '')
        .replace(/^[ \t]*\* ?/gm, '')
        .replace(/@description\s*/g, '')
        .replace(/@deprecated.*/g, '')
        .replace(/@see\s+(\{@link[^}]+\})/g, (_, link) => convertJsDocLinks(link))
        .replace(/@see\s.*/g, '')
        .replace(/\{@link[^}]+\}/g, (m) => convertJsDocLinks(m))
        .replace(/@example\s+(.+)/g, (_, val) => `e.g. \`${val.trim()}\``)
        .trim();
    }
  }

  return { description, isDeprecated };
}

// Convert a TypeScript object type's properties to an OpenAPI object schema.
function convertObjectType(tsType, referenceNode, depth, mapFn) {
  const props = tsType.getProperties();
  if (props.length === 0) return null;

  const schema = { type: 'object', properties: {}, required: [] };

  for (const prop of props) {
    const propName = prop.getName();
    if (propName.startsWith('__')) continue;

    const propDeclaration = prop.getValueDeclaration() || prop.getDeclarations()?.[0];
    const nodeForContext = propDeclaration || referenceNode;

    let propTsType;
    try {
      propTsType = prop.getTypeAtLocation(nodeForContext);
    } catch (e) {
      continue;
    }

    // Skip properties typed as bare `undefined` — they represent absent fields
    if (propTsType.isUndefined()) continue;

    const propSchema = mapFn(propTsType, nodeForContext, depth + 1);

    const { description, isDeprecated } = extractJsDocMeta(propDeclaration);
    if (description) propSchema.description = description;
    if (isDeprecated) propSchema.deprecated = true;

    // Check if property is optional: via declaration syntax (`?` token), symbol flags
    // (catches mapped types like Partial<T>), or a union type that includes undefined
    const isOptional =
      (propDeclaration &&
        typeof propDeclaration.hasQuestionToken === 'function' &&
        propDeclaration.hasQuestionToken()) ||
      !!(prop.getFlags() & ts.SymbolFlags.Optional) ||
      (propTsType.isUnion() && propTsType.getUnionTypes().some((t) => t.isUndefined()));

    schema.properties[propName] = propSchema;
    if (!isOptional) schema.required.push(propName);
  }

  if (schema.required.length === 0) delete schema.required;

  // Handle string index signatures (e.g., [key: string]: SomeType)
  const indexType = tsType.getStringIndexType();
  if (indexType) {
    schema.additionalProperties = mapFn(indexType, referenceNode, depth + 1);
  }

  return schema;
}

// Core type-to-schema dispatcher. Converts a TypeScript type into an OpenAPI schema
// object by dispatching on the type's kind (literal, primitive, union, intersection,
// array, tuple, object).
function computeSchemaShape(tsType, referenceNode, depth) {
  // Exact literals
  if (tsType.isBooleanLiteral()) return { type: 'boolean', enum: [tsType.getText() === 'true'] };
  if (tsType.isStringLiteral()) return { type: 'string', enum: [tsType.getLiteralValue()] };
  if (tsType.isNumberLiteral()) return { type: 'number', enum: [Number(tsType.getText())] };

  // Primitives
  if (tsType.isNull()) return { type: 'null' };
  if (tsType.isBoolean()) return { type: 'boolean' };
  if (tsType.isString()) return { type: 'string' };
  if (tsType.isNumber()) return { type: 'number' };
  if (tsType.isAny() || tsType.isUnknown()) return {};

  // Unions
  if (tsType.isUnion()) {
    const validTypes = tsType.getUnionTypes().filter((t) => !t.isUndefined());
    return convertUnion(validTypes.map((t) => mapTsTypeToOpenApi(t, referenceNode, depth)));
  }

  // Intersections
  if (tsType.isIntersection()) {
    return convertIntersection(
      tsType.getIntersectionTypes().map((t) => mapTsTypeToOpenApi(t, referenceNode, depth + 1)),
    );
  }

  // Arrays
  if (tsType.isArray()) {
    return {
      type: 'array',
      items: mapTsTypeToOpenApi(tsType.getArrayElementType(), referenceNode, depth + 1),
    };
  }

  // Tuples
  if (tsType.isTuple()) {
    const mapped = tsType
      .getTupleElements()
      .map((t) => mapTsTypeToOpenApi(t, referenceNode, depth + 1));
    const unique = [...new Map(mapped.map((item) => [JSON.stringify(item), item])).values()];
    if (unique.length === 0) {
      return { type: 'array', maxItems: 0 };
    }
    return {
      type: 'array',
      items: unique.length === 1 ? unique[0] : { anyOf: unique },
    };
  }

  // Objects with named properties
  const objectSchema = convertObjectType(tsType, referenceNode, depth, mapTsTypeToOpenApi);
  if (objectSchema) return objectSchema;

  // Bare index signature (e.g., { [key: string]: Foo })
  const indexType = tsType.getStringIndexType();
  if (indexType) {
    return {
      type: 'object',
      additionalProperties: mapTsTypeToOpenApi(indexType, referenceNode, depth + 1),
    };
  }

  return { type: 'object' };
}

// Resolve the name for a TypeScript type, handling utility type synthesis, anonymous
// types, generic type parameters, wrapper types, non-Slack types, and SDK-only types.
// Returns one of:
//   { name, cleanName, declPath } — named type suitable for $ref registration
//   { schema }                    — type resolved to a concrete schema (early exit)
//   null                          — anonymous type, fall through to shape computation
function resolveTypeName(tsType, referenceNode, depth) {
  const symbol = tsType.getAliasSymbol() || tsType.getSymbol();
  let typeName = symbol ? symbol.getName() : null;
  let synthesized = false;

  // Synthesize names for utility types (Partial, Pick, Omit, etc.)
  if (typeName && utilityTypes.has(typeName)) {
    typeName = tsType
      .getText(referenceNode)
      .replace(/import\([^)]+\)\./g, '')
      .replace(/<|>/g, '_')
      .replace(/['"\s]/g, '')
      .replace(/\|/g, 'Or')
      .replace(/,/g, '_')
      .replace(/_+$/, '');
    synthesized = true;
  }

  if (!synthesized && typeName) {
    // Skip anonymous compiler-generated types (e.g., __type)
    if (typeName.startsWith('__')) return null;

    const decl = symbol.getDeclarations()?.[0];

    // Generic type parameters: prefer default, then constraint, then opaque object
    if (decl?.getKind() === SyntaxKind.TypeParameter) {
      const defaultType = tsType.getDefault();
      if (defaultType)
        return {
          schema: mapTsTypeToOpenApi(defaultType, referenceNode, depth + 1),
        };
      const constraint = tsType.getConstraint();
      if (constraint)
        return {
          schema: mapTsTypeToOpenApi(constraint, referenceNode, depth + 1),
        };
      return { schema: { type: 'object' } };
    }

    // Wrapper types (Array, Promise) need to fall through for element type traversal
    if (wrapperTypes.has(typeName)) return null;

    // Non-Slack types (JS/Node built-ins like Buffer, Stream) — treat as binary
    const declPath = decl?.getSourceFile()?.getFilePath() || '';
    if (!declPath.includes('@slack/')) return { schema: { type: 'string', format: 'binary' } };
  }

  if (!typeName) return null;

  // SDK-only types contribute nothing to the API schema
  if (sdkOnlyTypes.has(typeName)) return { schema: {} };

  const cleanName = typeName.replace(/<([^>]+)>/g, '_$1_').replace(/[^a-zA-Z0-9.\-_]/g, '');
  const declPath = symbol?.getDeclarations()?.[0]?.getSourceFile()?.getFilePath() || '';
  return { name: typeName, cleanName, declPath };
}

// Main mapper: resolves TypeScript types to OpenAPI schemas, registering named
// types as reusable $ref components in the registry.
function mapTsTypeToOpenApi(tsType, referenceNode, depth = 0) {
  if (depth > 15) return { type: 'object' };

  const resolved = resolveTypeName(tsType, referenceNode, depth);

  if (resolved === null) {
    return computeSchemaShape(tsType, referenceNode, depth);
  }
  if (resolved.schema) {
    return resolved.schema;
  }

  return registry.resolveRef(resolved.cleanName, resolved.declPath, () =>
    computeSchemaShape(tsType, referenceNode, depth),
  );
}

// Check if a schema (or any nested schema it references) contains format: "binary" fields
function hasBinaryFields(schema, visited = new Set()) {
  if (!schema) return false;
  if (schema.format === 'binary') return true;
  if (schema.properties) {
    return Object.values(schema.properties).some((p) => hasBinaryFields(p, visited));
  }
  if (schema.allOf) return schema.allOf.some((s) => hasBinaryFields(s, visited));
  if (schema.anyOf) return schema.anyOf.some((s) => hasBinaryFields(s, visited));
  if (schema.items) return hasBinaryFields(schema.items, visited);
  if (schema.$ref) {
    if (visited.has(schema.$ref)) return false;
    visited.add(schema.$ref);
    const refName = schema.$ref.replace('#/components/schemas/', '');
    return hasBinaryFields(registry.schemas[refName], visited);
  }
  return false;
}

// Extract endpoint summary and deprecation info from JSDoc comment ranges on a property.
function extractEndpointDocs(propertySignature, methodName) {
  let summary = `Call the ${methodName} method`;
  let description = undefined;
  let deprecated = false;

  const commentRanges = propertySignature.getLeadingCommentRanges();
  if (commentRanges.length > 0) {
    const rawDoc = commentRanges[commentRanges.length - 1].getText();

    const descMatch = rawDoc.match(/@description\s*([\s\S]+?)(?=@\w|$)/);
    if (descMatch) {
      summary = descMatch[1]
        .replace(/\*\/$/, '')
        .replace(/^[ \t]*\* ?/gm, '')
        .replace(/\n/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();
    }

    const depMatch = rawDoc.match(/@deprecated\s*([^\n]+)/);
    if (depMatch) {
      deprecated = true;
      const depText = convertJsDocLinks(depMatch[1]).replace(/\*\/$/, '').trim();
      description = `**DEPRECATED:** ${depText}`;
    }
  }

  return { summary, description, deprecated };
}

// Build an OpenAPI POST operation for a single Web API endpoint.
function buildEndpointOperation(
  propertySignature,
  methodName,
  aliasName,
  requestType,
  responseType,
) {
  const requestSchema = mapTsTypeToOpenApi(requestType, propertySignature, 0);
  const responseSchema = mapTsTypeToOpenApi(responseType, propertySignature, 0);

  const { summary, description, deprecated } = extractEndpointDocs(propertySignature, methodName);

  const responseSymbol = responseType.getAliasSymbol() || responseType.getSymbol();
  const responseTypeName = responseSymbol ? responseSymbol.getName() : 'WebAPICallResult';

  const requestContent = {
    'application/json': { schema: requestSchema },
    'application/x-www-form-urlencoded': { schema: requestSchema },
  };
  if (hasBinaryFields(requestSchema)) {
    requestContent['multipart/form-data'] = { schema: requestSchema };
  }

  const operation = {
    operationId: methodName,
    tags: [methodName.split('.')[0]],
    summary,
    description: description || summary,
    requestBody: {
      required: aliasName === 'MethodWithRequiredArgument',
      content: requestContent,
    },
    responses: {
      200: {
        description: `Successful response. Returns a strongly-typed \`${responseTypeName}\` object. Note: Slack API errors also return HTTP 200 with \`ok: false\` and an \`error\` field.`,
        content: { 'application/json': { schema: responseSchema } },
      },
    },
  };

  if (deprecated) operation.deprecated = true;
  return operation;
}

// Recursively walk the nested property structure of the Methods class to discover
// endpoints. Leaf properties are typed as MethodWith(Required|Optional)Argument.
function walkProperties(propertySignature, pathParts, paths) {
  const tsType = propertySignature.getType();
  const aliasSymbol = tsType.getAliasSymbol();
  const aliasName = aliasSymbol ? aliasSymbol.getName() : null;

  if (aliasName === 'MethodWithRequiredArgument' || aliasName === 'MethodWithOptionalArgument') {
    const methodName = pathParts.join('.');

    // files.uploadV2 is a client-side SDK helper, not a real Slack API endpoint
    if (methodName === 'files.uploadV2') return;

    const typeArgs = tsType.getAliasTypeArguments();
    if (typeArgs.length < 2) return;

    paths[`/api/${methodName}`] = {
      post: buildEndpointOperation(
        propertySignature,
        methodName,
        aliasName,
        typeArgs[0],
        typeArgs[1],
      ),
    };
    return;
  }

  // Namespace object — recurse into its properties
  for (const prop of tsType.getProperties()) {
    const propDecl = prop.getValueDeclaration() || prop.getDeclarations()?.[0];
    if (!propDecl) continue;
    walkProperties(propDecl, [...pathParts, prop.getName()], paths);
  }
}

// Parse the Web API Methods class into OpenAPI path operations.
function parseWebApi(project) {
  const methodsFile = project.getSourceFileOrThrow('methods.d.ts');
  const methodsClass = methodsFile.getClassOrThrow('Methods');

  const paths = {};
  for (const prop of methodsClass.getProperties()) {
    if (prop.getName().startsWith('_')) continue;
    walkProperties(prop, [prop.getName()], paths);
  }
  return paths;
}

// Parse Events, Actions, and Shortcuts into OpenAPI webhook operations.
function parseEventsApi(project) {
  const allInterfaces = project.getSourceFiles().flatMap((f) => f.getInterfaces());

  // Build a set of abstract base types used as generic constraints/defaults
  const abstractBaseTypes = new Set();
  for (const iface of allInterfaces) {
    for (const tp of iface.getTypeParameters()) {
      const constraint = tp.getConstraint();
      if (constraint) abstractBaseTypes.add(constraint.getText().replace(/<.*>$/, ''));
      const defaultType = tp.getDefault();
      if (defaultType) abstractBaseTypes.add(defaultType.getText().replace(/<.*>$/, ''));
    }
  }

  const webhooks = {};
  for (const interfaceNode of allInterfaces) {
    const interfaceName = interfaceNode.getName();
    const filePath = interfaceNode.getSourceFile().getFilePath();

    const isEvent = filePath.includes('/events/') && interfaceName.endsWith('Event');
    const isAction =
      (filePath.includes('/actions/') || filePath.includes('/view/')) &&
      interfaceName.endsWith('Action');
    const isShortcut = filePath.includes('/shortcuts/') && interfaceName.endsWith('Shortcut');
    if (!isEvent && !isAction && !isShortcut) continue;
    if (abstractBaseTypes.has(interfaceName)) continue;

    // Register the type as a component (even generic wrappers like EnvelopedEvent)
    const eventSchema = mapTsTypeToOpenApi(interfaceNode.getType(), interfaceNode, 0);

    // Skip generic types — they aren't concrete Slack payloads
    if (interfaceNode.getTypeParameters().length > 0) continue;

    const eventName = interfaceName
      .replace(/(Event|Action|Shortcut)$/, '')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase();
    const payloadType = isEvent ? 'Event' : isAction ? 'Action' : 'Shortcut';

    const bodySchema = isEvent
      ? {
          allOf: [
            { $ref: '#/components/schemas/EnvelopedEvent' },
            {
              type: 'object',
              properties: { event: eventSchema },
              required: ['event'],
            },
          ],
        }
      : eventSchema;

    webhooks[eventName] = {
      post: {
        operationId: `webhook.${eventName}`,
        tags: [payloadType.toLowerCase() + 's'],
        summary: `Slack sends a ${eventName} ${payloadType.toLowerCase()}`,
        description: `Triggered when the \`${eventName}\` ${payloadType.toLowerCase()} occurs in Slack.`,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: bodySchema } },
        },
        responses: {
          200: { description: 'Acknowledge the event successfully.' },
        },
      },
    };
  }
  return webhooks;
}

// Assemble the final OpenAPI 3.1 spec from paths, webhooks, and the component registry.
function assembleSpec(paths, webhooks) {
  // Remove SDK-only types that may have been registered via a different code path
  for (const name of sdkOnlyTypes) {
    delete registry.schemas[name];
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Slack Web API & Events API (Strict SDK Generation)',
      version: new Date().toISOString().split('T')[0],
      description:
        'Generated 100% offline directly from the TypeScript AST of the official Node SDK.',
    },
    servers: [{ url: 'https://slack.com' }],
    security: [{ slackAuth: [] }],
    paths,
    webhooks,
    components: {
      schemas: registry.schemas,
      securitySchemes: {
        slackAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'token',
          description: 'Slack OAuth token (e.g., xoxb-... or xoxp-...)',
        },
      },
    },
  };
}

// Main generator pipeline
async function generate() {
  const outputPath = path.resolve(process.argv[2] || './slack-openapi-spec.json');
  console.log(`🎯 Output target set to: ${outputPath}`);

  console.log('📂 Loading Slack SDK TypeScript files into memory...');
  const project = new Project({
    compilerOptions: { strictNullChecks: true },
  });
  project.addSourceFilesAtPaths('./node_modules/@slack/web-api/dist/**/*.d.ts');
  project.addSourceFilesAtPaths('./node_modules/@slack/types/dist/**/*.d.ts');
  project.addSourceFilesAtPaths('./node_modules/@slack/bolt/dist/**/*.d.ts');

  console.log('⚙️  Parsing Web API Endpoints...');
  const paths = parseWebApi(project);

  console.log('⚙️  Parsing Events API Webhooks...');
  const webhooks = parseEventsApi(project);

  const finalSpec = assembleSpec(paths, webhooks);

  fs.writeFileSync(outputPath, JSON.stringify(finalSpec, null, 2));
  console.log(`\n📊 Generation Summary:`);
  console.log(`✅ Successfully mapped: ${Object.keys(paths).length} Web API Endpoints`);
  console.log(`✅ Successfully mapped: ${Object.keys(webhooks).length} Events API Webhooks`);
  console.log(`🎉 Success! Wrote beautiful OpenAPI 3.1 spec to ${outputPath}`);
}

// Run the generator when executed directly (not when imported by tests)
if (require.main === module) {
  generate().catch(console.error);
}

module.exports = {
  ComponentRegistry,
  convertJsDocLinks,
  getInlineProps,
  hoistCommonProperties,
  dedup,
  convertUnion,
  convertIntersection,
  extractJsDocMeta,
  convertObjectType,
  computeSchemaShape,
  resolveTypeName,
  mapTsTypeToOpenApi,
  hasBinaryFields,
  // Allow tests to swap the module-level registry
  get registry() {
    return registry;
  },
  set registry(r) {
    registry = r;
  },
};
