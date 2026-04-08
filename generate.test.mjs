import { describe, it, expect, beforeEach } from 'vitest';
import { Project } from 'ts-morph';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const gen = require('./generate');
const {
  ComponentRegistry,
  convertJsDocLinks,
  getInlineProps,
  hoistCommonProperties,
  dedup,
  convertUnion,
  convertIntersection,
  hasBinaryFields,
  mapTsTypeToOpenApi,
  computeSchemaShape,
} = gen;

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Create a fresh ts-morph project with strictNullChecks and resolve a type by name.
function resolveType(source, typeName) {
  const project = new Project({ compilerOptions: { strictNullChecks: true } });
  const file = project.createSourceFile('test.ts', source);
  const alias = file.getTypeAliasOrThrow(typeName);
  return { type: alias.getType(), node: alias };
}

// Shortcut: create a type alias and map it through the full pipeline.
function mapType(source, typeName) {
  gen.registry = new ComponentRegistry();
  const { type, node } = resolveType(source, typeName);
  return mapTsTypeToOpenApi(type, node, 0);
}

// Shortcut: compute the schema shape directly (bypasses component registration).
function shapeOf(source, typeName) {
  gen.registry = new ComponentRegistry();
  const { type, node } = resolveType(source, typeName);
  return computeSchemaShape(type, node, 0);
}

// ─── Pure Utilities ────────────────────────────────────────────────────────────

describe('convertJsDocLinks', () => {
  it('converts link with display text', () => {
    expect(convertJsDocLinks('{@link https://example.com Example}')).toBe(
      '[Example](https://example.com)',
    );
  });

  it('converts link without display text', () => {
    expect(convertJsDocLinks('{@link https://example.com}')).toBe(
      '[https://example.com](https://example.com)',
    );
  });

  it('passes through strings without links', () => {
    expect(convertJsDocLinks('no links here')).toBe('no links here');
  });

  it('handles multiple links', () => {
    const input = 'See {@link https://a.com A} and {@link https://b.com}';
    expect(convertJsDocLinks(input)).toBe(
      'See [A](https://a.com) and [https://b.com](https://b.com)',
    );
  });
});

describe('getInlineProps', () => {
  it('extracts from plain object', () => {
    const branch = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    };
    const result = getInlineProps(branch);
    expect(result.props).toEqual({ a: { type: 'string' } });
    expect(result.required).toEqual(new Set(['a']));
  });

  it('extracts from allOf wrapper', () => {
    const branch = {
      allOf: [
        {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x'],
        },
        { type: 'object', properties: { y: { type: 'string' } } },
      ],
    };
    const result = getInlineProps(branch);
    expect(result.props).toEqual({
      x: { type: 'number' },
      y: { type: 'string' },
    });
    expect(result.required).toEqual(new Set(['x']));
  });

  it('returns null for non-object branches', () => {
    expect(getInlineProps({ $ref: '#/components/schemas/Foo' })).toBeNull();
    expect(getInlineProps({ type: 'string' })).toBeNull();
  });
});

describe('dedup', () => {
  it('removes duplicate schemas', () => {
    const schemas = [{ type: 'string' }, { type: 'number' }, { type: 'string' }];
    expect(dedup(schemas)).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('preserves order', () => {
    const schemas = [{ type: 'number' }, { type: 'string' }, { type: 'number' }];
    expect(dedup(schemas)).toEqual([{ type: 'number' }, { type: 'string' }]);
  });

  it('handles empty array', () => {
    expect(dedup([])).toEqual([]);
  });
});

describe('hoistCommonProperties', () => {
  it('hoists common properties from multiple branches', () => {
    const branches = [
      {
        type: 'object',
        properties: { ok: { type: 'boolean' }, a: { type: 'string' } },
        required: ['ok'],
      },
      {
        type: 'object',
        properties: { ok: { type: 'boolean' }, b: { type: 'number' } },
        required: ['ok'],
      },
    ];
    const result = hoistCommonProperties(branches);
    expect(result).not.toBeNull();
    expect(result.hoisted.properties).toEqual({ ok: { type: 'boolean' } });
    expect(result.hoisted.required).toEqual(['ok']);
    expect(result.cleaned).toHaveLength(2);
  });

  it('returns null when no common properties exist', () => {
    const branches = [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'number' } } },
    ];
    expect(hoistCommonProperties(branches)).toBeNull();
  });

  it('returns null for single branch', () => {
    expect(
      hoistCommonProperties([{ type: 'object', properties: { a: { type: 'string' } } }]),
    ).toBeNull();
  });

  it('returns null when branches have no inline props', () => {
    expect(hoistCommonProperties([{ $ref: '#/A' }, { $ref: '#/B' }])).toBeNull();
  });

  it('does not hoist when required status differs', () => {
    const branches = [
      {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      { type: 'object', properties: { ok: { type: 'boolean' } } }, // ok is optional here
    ];
    expect(hoistCommonProperties(branches)).toBeNull();
  });
});

// ─── Schema Conversion (no ts-morph) ──────────────────────────────────────────

describe('convertUnion', () => {
  it('collapses string enums', () => {
    const types = [
      { type: 'string', enum: ['a'] },
      { type: 'string', enum: ['b'] },
    ];
    expect(convertUnion(types)).toEqual({ type: 'string', enum: ['a', 'b'] });
  });

  it('collapses number enums', () => {
    const types = [
      { type: 'number', enum: [1] },
      { type: 'number', enum: [2] },
    ];
    expect(convertUnion(types)).toEqual({ type: 'number', enum: [1, 2] });
  });

  it('collapses simple primitives into type array', () => {
    const types = [{ type: 'string' }, { type: 'null' }];
    expect(convertUnion(types)).toEqual({ type: ['string', 'null'] });
  });

  it('returns anyOf for mixed types', () => {
    const types = [
      { type: 'string', enum: ['a'] },
      { type: 'object', properties: { x: { type: 'number' } } },
    ];
    expect(convertUnion(types)).toEqual({ anyOf: types });
  });

  it('deduplicates identical branches', () => {
    const types = [{ type: 'string' }, { type: 'string' }, { type: 'number' }];
    expect(convertUnion(types)).toEqual({ type: ['string', 'number'] });
  });

  it('returns single type when all branches are identical', () => {
    expect(convertUnion([{ type: 'string' }, { type: 'string' }])).toEqual({
      type: 'string',
    });
  });

  it('hoists common $refs from allOf branches', () => {
    const types = [
      {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { type: 'object', properties: { a: { type: 'string' } } },
        ],
      },
      {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { type: 'object', properties: { b: { type: 'number' } } },
        ],
      },
    ];
    const result = convertUnion(types);
    expect(result.allOf[0]).toEqual({ $ref: '#/components/schemas/Base' });
    // The remaining branches should be in an anyOf
    expect(result.allOf[1].anyOf).toBeDefined();
  });

  it('does not collapse types with extra schema properties into type array', () => {
    // format should be preserved, not collapsed to just ["string", "string"]
    const types = [{ type: 'string' }, { type: 'string', format: 'binary' }];
    expect(convertUnion(types)).toEqual({
      anyOf: [{ type: 'string' }, { type: 'string', format: 'binary' }],
    });
  });

  it('does not collapse types with additionalProperties into type array', () => {
    const types = [
      { type: 'null' },
      { type: 'object', additionalProperties: { type: 'string' } },
    ];
    expect(convertUnion(types)).toEqual({ anyOf: types });
  });

  it('does not collapse types with maxItems into type array', () => {
    const types = [
      { type: 'null' },
      { type: 'object', additionalProperties: { type: 'string' } },
      { type: 'array', maxItems: 0 },
    ];
    expect(convertUnion(types)).toEqual({ anyOf: types });
  });

  it('hoists common inline properties from anyOf branches', () => {
    const types = [
      {
        type: 'object',
        properties: { ok: { type: 'boolean' }, a: { type: 'string' } },
        required: ['ok'],
      },
      {
        type: 'object',
        properties: { ok: { type: 'boolean' }, b: { type: 'number' } },
        required: ['ok'],
      },
    ];
    const result = convertUnion(types);
    // Should have hoisted ok into an allOf
    expect(result.allOf).toBeDefined();
    expect(result.allOf[0].properties.ok).toEqual({ type: 'boolean' });
  });
});

describe('convertIntersection', () => {
  it('squashes multiple inline objects', () => {
    const types = [
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      },
      { type: 'object', properties: { b: { type: 'number' } } },
    ];
    const result = convertIntersection(types);
    expect(result.type).toBe('object');
    expect(result.properties).toEqual({
      a: { type: 'string' },
      b: { type: 'number' },
    });
    expect(result.required).toEqual(['a']);
  });

  it('merges $ref with inline object via allOf', () => {
    const types = [
      { $ref: '#/components/schemas/Base' },
      { type: 'object', properties: { extra: { type: 'string' } } },
    ];
    const result = convertIntersection(types);
    expect(result.allOf).toEqual(types);
  });

  it('returns single type when only one valid', () => {
    const types = [
      {}, // empty — filtered out
      { type: 'object', properties: { a: { type: 'string' } } },
    ];
    expect(convertIntersection(types)).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
  });

  it('filters out empty objects', () => {
    const types = [{}, {}];
    expect(convertIntersection(types)).toBeUndefined();
  });

  it('deduplicates required array', () => {
    const types = [
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      },
      {
        type: 'object',
        properties: { b: { type: 'string' } },
        required: ['a', 'b'],
      },
    ];
    const result = convertIntersection(types);
    expect(result.required).toEqual(['a', 'b']);
  });
});

// ─── ComponentRegistry ─────────────────────────────────────────────────────────

describe('ComponentRegistry', () => {
  let reg;

  beforeEach(() => {
    reg = new ComponentRegistry();
  });

  it('registers a new type and returns $ref', () => {
    const result = reg.resolveRef('Foo', '/a.ts', () => ({
      type: 'object',
      properties: { x: { type: 'string' } },
    }));
    expect(result).toEqual({ $ref: '#/components/schemas/Foo' });
    expect(reg.schemas.Foo).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    });
  });

  it('returns cached $ref for same source', () => {
    reg.resolveRef('Foo', '/a.ts', () => ({ type: 'string' }));
    const computeFn = () => {
      throw new Error('should not be called');
    };
    const result = reg.resolveRef('Foo', '/a.ts', computeFn);
    expect(result).toEqual({ $ref: '#/components/schemas/Foo' });
  });

  it('deduplicates structurally identical types from different sources', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    reg.resolveRef('Auth', '/web-api/auth.ts', () => ({ ...schema }));
    const result = reg.resolveRef('Auth', '/bolt/auth.ts', () => ({
      ...schema,
    }));
    expect(result).toEqual({ $ref: '#/components/schemas/Auth' });
    // No Auth2 should exist
    expect(reg.schemas.Auth2).toBeUndefined();
  });

  it('disambiguates structurally different types from different sources', () => {
    reg.resolveRef('Auth', '/web-api/auth.ts', () => ({
      type: 'object',
      properties: { token: { type: 'string' } },
    }));
    const result = reg.resolveRef('Auth', '/bolt/auth.ts', () => ({
      type: 'object',
      properties: { team_id: { type: 'string' } },
    }));
    expect(result).toEqual({ $ref: '#/components/schemas/Auth2' });
    expect(reg.schemas.Auth).toBeDefined();
    expect(reg.schemas.Auth2).toBeDefined();
  });

  it('reuses existing numbered variant when shapes match', () => {
    reg.resolveRef('T', '/a.ts', () => ({ type: 'string' }));
    reg.resolveRef('T', '/b.ts', () => ({ type: 'number' }));
    // Third source with same shape as T2
    const result = reg.resolveRef('T', '/c.ts', () => ({ type: 'number' }));
    expect(result).toEqual({ $ref: '#/components/schemas/T2' });
    expect(reg.schemas.T3).toBeUndefined();
  });
});

// ─── hasBinaryFields ───────────────────────────────────────────────────────────

describe('hasBinaryFields', () => {
  beforeEach(() => {
    gen.registry = new ComponentRegistry();
  });

  it('detects direct binary format', () => {
    expect(hasBinaryFields({ type: 'string', format: 'binary' })).toBe(true);
  });

  it('detects binary in nested properties', () => {
    expect(
      hasBinaryFields({
        type: 'object',
        properties: { file: { type: 'string', format: 'binary' } },
      }),
    ).toBe(true);
  });

  it('detects binary in allOf', () => {
    expect(
      hasBinaryFields({
        allOf: [
          {
            type: 'object',
            properties: { data: { type: 'string', format: 'binary' } },
          },
        ],
      }),
    ).toBe(true);
  });

  it('detects binary in anyOf', () => {
    expect(
      hasBinaryFields({
        anyOf: [{ type: 'string' }, { type: 'string', format: 'binary' }],
      }),
    ).toBe(true);
  });

  it('detects binary in array items', () => {
    expect(
      hasBinaryFields({
        type: 'array',
        items: { type: 'string', format: 'binary' },
      }),
    ).toBe(true);
  });

  it('follows $ref to detect binary', () => {
    gen.registry.schemas.FileData = { type: 'string', format: 'binary' };
    expect(hasBinaryFields({ $ref: '#/components/schemas/FileData' })).toBe(true);
  });

  it('returns false for non-binary schemas', () => {
    expect(hasBinaryFields({ type: 'string' })).toBe(false);
    expect(
      hasBinaryFields({
        type: 'object',
        properties: { name: { type: 'string' } },
      }),
    ).toBe(false);
  });

  it('handles null/undefined input', () => {
    expect(hasBinaryFields(null)).toBe(false);
    expect(hasBinaryFields(undefined)).toBe(false);
  });

  it('handles circular $refs without infinite loop', () => {
    gen.registry.schemas.Circular = {
      type: 'object',
      properties: { self: { $ref: '#/components/schemas/Circular' } },
    };
    expect(hasBinaryFields({ $ref: '#/components/schemas/Circular' })).toBe(false);
  });
});

// ─── Type Mapping Integration (ts-morph) ───────────────────────────────────────

describe('type mapping integration', () => {
  beforeEach(() => {
    gen.registry = new ComponentRegistry();
  });

  describe('primitives', () => {
    it('maps string', () => {
      expect(shapeOf('type T = string;', 'T')).toEqual({ type: 'string' });
    });

    it('maps number', () => {
      expect(shapeOf('type T = number;', 'T')).toEqual({ type: 'number' });
    });

    it('maps boolean', () => {
      expect(shapeOf('type T = boolean;', 'T')).toEqual({ type: 'boolean' });
    });

    it('maps null', () => {
      expect(shapeOf('type T = null;', 'T')).toEqual({ type: 'null' });
    });

    it('maps any to empty schema', () => {
      expect(shapeOf('type T = any;', 'T')).toEqual({});
    });

    it('maps unknown to empty schema', () => {
      expect(shapeOf('type T = unknown;', 'T')).toEqual({});
    });
  });

  describe('literals', () => {
    it('maps string literal', () => {
      expect(shapeOf('type T = "hello";', 'T')).toEqual({
        type: 'string',
        enum: ['hello'],
      });
    });

    it('maps number literal', () => {
      expect(shapeOf('type T = 42;', 'T')).toEqual({
        type: 'number',
        enum: [42],
      });
    });

    it('maps true literal', () => {
      expect(shapeOf('type T = true;', 'T')).toEqual({
        type: 'boolean',
        enum: [true],
      });
    });

    it('maps false literal', () => {
      expect(shapeOf('type T = false;', 'T')).toEqual({
        type: 'boolean',
        enum: [false],
      });
    });
  });

  describe('unions', () => {
    it('collapses string literal union into enum', () => {
      expect(shapeOf('type T = "a" | "b" | "c";', 'T')).toEqual({
        type: 'string',
        enum: ['a', 'b', 'c'],
      });
    });

    it('produces type array for primitive union', () => {
      expect(shapeOf('type T = string | number;', 'T')).toEqual({
        type: ['string', 'number'],
      });
    });

    it('produces nullable type', () => {
      const result = shapeOf('type T = string | null;', 'T');
      expect(result.type).toHaveLength(2);
      expect(result.type).toContain('string');
      expect(result.type).toContain('null');
    });

    it('strips undefined from unions (optional-like)', () => {
      // With strictNullChecks, `string | undefined` should just be `string`
      expect(shapeOf('type T = string | undefined;', 'T')).toEqual({
        type: 'string',
      });
    });
  });

  describe('arrays', () => {
    it('maps string array', () => {
      expect(shapeOf('type T = string[];', 'T')).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });

    it('maps Array generic', () => {
      expect(shapeOf('type T = Array<number>;', 'T')).toEqual({
        type: 'array',
        items: { type: 'number' },
      });
    });
  });

  describe('tuples', () => {
    it('maps homogeneous tuple', () => {
      expect(shapeOf('type T = [string, string];', 'T')).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });

    it('maps heterogeneous tuple', () => {
      expect(shapeOf('type T = [string, number];', 'T')).toEqual({
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      });
    });

    it('maps empty tuple to array with maxItems 0', () => {
      expect(shapeOf('type T = [];', 'T')).toEqual({
        type: 'array',
        maxItems: 0,
      });
    });

    it('preserves empty tuple branch in union', () => {
      const result = shapeOf(
        'type T = { [key: string]: { value: string; alt: string } } | [] | null;',
        'T',
      );
      expect(result.anyOf).toBeDefined();
      expect(result.anyOf).toContainEqual({ type: 'null' });
      expect(result.anyOf).toContainEqual({ type: 'array', maxItems: 0 });
      const objBranch = result.anyOf.find((b) => b.type === 'object');
      expect(objBranch).toBeDefined();
      expect(objBranch.additionalProperties).toBeDefined();
    });
  });

  describe('objects', () => {
    it('maps simple object', () => {
      const result = shapeOf('type T = { name: string; age: number };', 'T');
      expect(result.type).toBe('object');
      expect(result.properties.name).toEqual({ type: 'string' });
      expect(result.properties.age).toEqual({ type: 'number' });
      expect(result.required).toEqual(['name', 'age']);
    });

    it('handles optional properties', () => {
      const result = shapeOf('type T = { name: string; nickname?: string };', 'T');
      expect(result.required).toEqual(['name']);
      expect(result.properties.nickname).toEqual({ type: 'string' });
    });

    it('handles index signatures', () => {
      const result = shapeOf('type T = { [key: string]: number };', 'T');
      expect(result.type).toBe('object');
      expect(result.additionalProperties).toEqual({ type: 'number' });
    });

    it('skips undefined-typed properties', () => {
      const result = shapeOf('type T = { name: string; gone: undefined };', 'T');
      expect(result.properties.gone).toBeUndefined();
      expect(result.properties.name).toEqual({ type: 'string' });
    });
  });

  describe('intersections', () => {
    it('squashes inline object intersections', () => {
      const result = shapeOf('type T = { a: string } & { b: number };', 'T');
      expect(result.type).toBe('object');
      expect(result.properties.a).toEqual({ type: 'string' });
      expect(result.properties.b).toEqual({ type: 'number' });
    });
  });

  describe('nested types', () => {
    it('maps nested objects', () => {
      const result = shapeOf('type T = { inner: { x: number } };', 'T');
      expect(result.properties.inner).toEqual({
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
      });
    });

    it('maps array of objects', () => {
      const result = shapeOf('type T = { id: string }[];', 'T');
      expect(result.type).toBe('array');
      expect(result.items.properties.id).toEqual({ type: 'string' });
    });
  });

  describe('depth limit', () => {
    it('returns opaque object at depth > 15', () => {
      gen.registry = new ComponentRegistry();
      const { type, node } = resolveType('type T = { a: string };', 'T');
      // Directly call with depth 16
      const result = mapTsTypeToOpenApi(type, node, 16);
      expect(result).toEqual({ type: 'object' });
    });
  });
});
