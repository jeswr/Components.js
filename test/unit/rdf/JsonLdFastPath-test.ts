import { PassThrough, Readable } from 'node:stream';
import type * as RDF from '@rdfjs/types';
import { JsonLdContextNormalized } from 'jsonld-context-parser';
import { rdfParser } from 'rdf-parse';
import * as JsonLdFastPath from '../../../lib/rdf/JsonLdFastPath';
import type { RdfParserOptions } from '../../../lib/rdf/RdfParser';
import { RdfParser } from '../../../lib/rdf/RdfParser';
import 'jest-rdf';

const arrayifyStream = require('arrayify-stream');
const quad = require('rdf-quad');
const streamifyString = require('streamify-string');

const CTX_URL = 'http://example.org/context.jsonld';
const VOC = 'http://example.org/voc/';

// A context exercising every term-definition shape the fast path classifies.
const RICH_CONTEXTS: Record<string, any> = {
  [CTX_URL]: {
    '@context': {
      ex: VOC,
      name: `${VOC}name`,
      typedString: { '@id': `${VOC}typedString`, '@type': `${VOC}dt` },
      ref: { '@id': `${VOC}ref`, '@type': '@id' },
      jsonVal: { '@id': `${VOC}jsonVal`, '@type': '@json' },
      myList: { '@id': `${VOC}myList`, '@container': '@list' },
      refList: { '@id': `${VOC}refList`, '@container': '@list', '@type': '@id' },
      setTerm: { '@id': `${VOC}setTerm`, '@container': '@set' },
      doubleVal: { '@id': `${VOC}doubleVal`, '@type': 'http://www.w3.org/2001/XMLSchema#double' },
      floatVal: { '@id': `${VOC}floatVal`, '@type': 'http://www.w3.org/2001/XMLSchema#float' },
      // Terms below carry features outside the fast path subset: documents using them fall back.

      Scoped: { '@id': `${VOC}Scoped`, '@context': { nick: `${VOC}nick` }},
      scopedProp: { '@id': `${VOC}scopedProp`, '@context': { nick: `${VOC}nick` }},
      rev: { '@reverse': `${VOC}rev` },
      idxMap: { '@id': `${VOC}idxMap`, '@container': '@index' },
      idxDef: { '@id': `${VOC}idxDef`, '@index': `${VOC}idx` },
      nestDef: { '@id': `${VOC}nestDef`, '@nest': '@nest' },
      langDef: { '@id': `${VOC}langDef`, '@language': 'en' },
      dirDef: { '@id': `${VOC}dirDef`, '@direction': 'ltr' },
      vocabRef: { '@id': `${VOC}vocabRef`, '@type': '@vocab' },
      arrayType: { '@id': `${VOC}arrayType`, '@type': null },
      aliasId: '@id',
      aliasObj: { '@id': '@type' },
      nulled: null,
      idNull: { '@id': null },
    },
  },
};

function makeOptions(
  disableJsonLdFastPath: boolean,
  contexts: Record<string, any> | undefined,
  extra: Partial<RdfParserOptions> = {},
): RdfParserOptions {
  return {
    path: 'file.jsonld',
    contexts,
    skipContextValidation: true,
    remoteContextLookups: false,
    disableJsonLdFastPath,
    ...extra,
  };
}

interface IParityResult {
  tookFast: boolean;
  quads?: RDF.Quad[];
  error?: Error;
}

async function parseQuads(
  docText: string,
  disable: boolean,
  contexts: Record<string, any> | undefined,
  extra: Partial<RdfParserOptions> = {},
): Promise<{ quads?: RDF.Quad[]; error?: Error }> {
  try {
    return {
      quads: await arrayifyStream(new RdfParser()
        .parse(streamifyString(docText), makeOptions(disable, contexts, extra))),
    };
  } catch (error: unknown) {
    return { error: <Error> error };
  }
}

/**
 * Parse the document with the fast path enabled and disabled,
 * expect identical outcomes (isomorphic quads, or equal errors),
 * and report whether the fast path was actually taken.
 */
async function expectParity(
  doc: any,
  contexts: Record<string, any> | undefined = RICH_CONTEXTS,
  extra: Partial<RdfParserOptions> = {},
): Promise<IParityResult> {
  const docText = typeof doc === 'string' ? doc : JSON.stringify(doc);
  const generic = await parseQuads(docText, true, contexts, extra);
  const spy = jest.spyOn(rdfParser, 'parse');
  const fast = await parseQuads(docText, false, contexts, extra);
  const tookFast = spy.mock.calls.length === 0;
  spy.mockRestore();
  if (generic.error) {
    expect(fast.error?.message).toEqual(generic.error.message);
  } else {
    expect(fast.error).toBeUndefined();
    expect(fast.quads).toBeRdfIsomorphic(generic.quads!);
  }
  return { tookFast, quads: fast.quads, error: fast.error };
}

function ctxDoc(body: any): any {
  return { '@context': CTX_URL, ...body };
}

describe('JsonLdFastPath', () => {
  describe('emitting documents inside the supported subset', () => {
    it.each(<[string, any][]> [
      [ 'plain string values', ctxDoc({ '@id': 'ex:s', name: 'Alice' }) ],
      [ 'multiple string values', ctxDoc({ '@id': 'ex:s', name: [ 'Alice', 'Bob' ]}) ],
      [ 'full-IRI and compact-IRI keys', ctxDoc({ '@id': 'ex:s', [`${VOC}p`]: 'a', 'ex:q': 'b' }) ],
      [ 'a single type', ctxDoc({ '@id': 'ex:s', '@type': 'ex:T' }) ],
      [ 'multiple types', ctxDoc({ '@id': 'ex:s', '@type': [ 'ex:T1', `${VOC}T2` ]}) ],
      [ 'an empty type array', ctxDoc({ '@id': 'ex:s', '@type': []}) ],
      [ 'a type expanding to a keyword', ctxDoc({ '@id': 'ex:s', '@type': '@id', name: 'x' }) ],
      [ 'nested nodes with only a keyword-expanding type', ctxDoc({ '@id': 'ex:s', name: { '@type': '@json' }}) ],
      [ 'a type with a null term definition id', ctxDoc({ '@id': 'ex:s', '@type': 'idNull', name: 'x' }) ],
      [ '@id-coerced references', ctxDoc({ '@id': 'ex:s', ref: 'ex:o' }) ],
      [ '@id-coerced blank node references', ctxDoc({ '@id': 'ex:s', ref: '_:b0' }) ],
      [ 'a blank node subject', ctxDoc({ '@id': '_:root', name: 'x' }) ],
      [ 'nested anonymous node objects', ctxDoc({ '@id': 'ex:s', ref: { name: 'inner' }}) ],
      [ 'nested identified node objects', ctxDoc({ '@id': 'ex:s', ref: { '@id': 'ex:o', name: 'inner' }}) ],
      [ 'empty object values', ctxDoc({ '@id': 'ex:s', ref: {}}) ],
      [ 'node reference objects', ctxDoc({ '@id': 'ex:s', name: { '@id': 'ex:o' }}) ],
      [ 'a root node without any quads', ctxDoc({ '@id': 'ex:s' }) ],
      [ 'a root node without @id', ctxDoc({ name: 'x' }) ],
      [ 'plain value objects', ctxDoc({ '@id': 'ex:s', name: { '@value': 'x' }}) ],
      [ 'typed value objects', ctxDoc({ '@id': 'ex:s', name: { '@value': 'x', '@type': `${VOC}dt` }}) ],
      [ 'compact-IRI-typed value objects', ctxDoc({ '@id': 'ex:s', name: { '@value': 'x', '@type': 'ex:dt' }}) ],
      [ 'null value objects', ctxDoc({ '@id': 'ex:s', name: { '@value': null }, ref: 'ex:o' }) ],
      [
        'type-first JSON value objects with flat scalar maps',
        ctxDoc({ '@id': 'ex:s', name: { '@type': '@json', '@value': { b: 1, a: true, c: 'x', d: null }}}),
      ],
      [
        'type-first JSON value objects with scalars',
        ctxDoc({ '@id': 'ex:s', name: { '@type': '@json', '@value': 1.5 }}),
      ],
      [ 'numeric value objects', ctxDoc({ '@id': 'ex:s', name: [{ '@value': 1 }, { '@value': 1.5 }]}) ],
      [ 'boolean value objects', ctxDoc({ '@id': 'ex:s', name: [{ '@value': true }, { '@value': false, '@type': `${VOC}dt` }]}) ],
      [ 'integers', ctxDoc({ '@id': 'ex:s', name: [ 0, 7, -42 ]}) ],
      [ 'doubles', ctxDoc({ '@id': 'ex:s', name: [ 1.5, -0.25 ]}) ],
      [ 'huge integers becoming doubles', ctxDoc({ '@id': 'ex:s', name: 1e22 }) ],
      [ 'double-coerced integers', ctxDoc({ '@id': 'ex:s', doubleVal: 5 }) ],
      [ 'float-coerced numbers', ctxDoc({ '@id': 'ex:s', floatVal: [ 5, 5.5 ]}) ],
      [ 'datatype-coerced strings', ctxDoc({ '@id': 'ex:s', typedString: 'x' }) ],
      [ 'datatype-coerced booleans', ctxDoc({ '@id': 'ex:s', typedString: true, floatVal: false }) ],
      [ '@id-coerced numbers (coercion ignored)', ctxDoc({ '@id': 'ex:s', ref: 5 }) ],
      [ 'booleans', ctxDoc({ '@id': 'ex:s', name: [ true, false ]}) ],
      [ 'null values (dropped)', ctxDoc({ '@id': 'ex:s', name: null, ref: 'ex:o' }) ],
      [ 'null in arrays (dropped)', ctxDoc({ '@id': 'ex:s', name: [ 'a', null ]}) ],
      [ 'JSON-typed terms with objects', ctxDoc({ '@id': 'ex:s', jsonVal: { b: 1, a: 'x' }}) ],
      [ 'JSON-typed terms with arrays', ctxDoc({ '@id': 'ex:s', jsonVal: [ 1, { a: true }]}) ],
      [ 'JSON-typed terms with null', ctxDoc({ '@id': 'ex:s', jsonVal: null }) ],
      [ 'JSON-typed terms with scalars', ctxDoc({ '@id': 'ex:s', jsonVal: 1.5 }) ],
      [ 'list containers', ctxDoc({ '@id': 'ex:s', myList: [ 'a', 1, true ]}) ],
      [ 'list containers with a single value', ctxDoc({ '@id': 'ex:s', myList: 'a' }) ],
      [ 'empty list containers', ctxDoc({ '@id': 'ex:s', myList: []}) ],
      [ 'list containers with nulls (dropped)', ctxDoc({ '@id': 'ex:s', myList: [ 'a', null ]}) ],
      [ '@id-coerced list containers', ctxDoc({ '@id': 'ex:s', refList: [ 'ex:a', 'ex:b' ]}) ],
      [ 'explicit @list objects', ctxDoc({ '@id': 'ex:s', name: { '@list': [ 'a', 'b' ]}}) ],
      [ 'explicit empty @list objects', ctxDoc({ '@id': 'ex:s', name: { '@list': []}}) ],
      [ 'lists of node objects', ctxDoc({ '@id': 'ex:s', myList: [{ '@id': 'ex:o', name: 'x' }]}) ],
      [ 'set containers', ctxDoc({ '@id': 'ex:s', setTerm: [ 'a', 'b' ]}) ],
      [ 'an array context with a single URL', { '@context': [ CTX_URL ], '@id': 'ex:s', name: 'x' }],
    ])('should fast-path %s identically to the generic parser', async(label, doc) => {
      const { tookFast } = await expectParity(doc);
      expect(tookFast).toBe(true);
    });

    it('should emit canonical lexical forms for numbers', async() => {
      const { tookFast, quads } = await expectParity(ctxDoc({
        '@id': `${VOC}s`,
        doubleVal: 5,
        floatVal: 5.5,
        name: [ 7, 2.5, 1e22 ],
      }));
      expect(tookFast).toBe(true);
      expect(quads).toBeRdfIsomorphic([
        quad(`${VOC}s`, `${VOC}doubleVal`, '"5.0E0"^^http://www.w3.org/2001/XMLSchema#double'),
        quad(`${VOC}s`, `${VOC}floatVal`, '"5.5E0"^^http://www.w3.org/2001/XMLSchema#float'),
        quad(`${VOC}s`, `${VOC}name`, '"7"^^http://www.w3.org/2001/XMLSchema#integer'),
        quad(`${VOC}s`, `${VOC}name`, '"2.5E0"^^http://www.w3.org/2001/XMLSchema#double'),
        quad(`${VOC}s`, `${VOC}name`, '"1.0E22"^^http://www.w3.org/2001/XMLSchema#double'),
      ]);
    });

    it('should reuse cached context analyses across documents', async() => {
      const parseContextSpy = jest.spyOn(JsonLdFastPath, 'tryParseJsonLdFastPath');
      expect((await expectParity(ctxDoc({ '@id': 'ex:s', name: 'a' }))).tookFast).toBe(true);
      expect((await expectParity(ctxDoc({ '@id': 'ex:s', name: 'b' }))).tookFast).toBe(true);
      expect(parseContextSpy).toHaveBeenCalledTimes(2);
      parseContextSpy.mockRestore();
    });
  });

  describe('falling back for documents outside the supported subset', () => {
    it.each(<[string, any][]> [
      [ '@graph documents', ctxDoc({ '@graph': [{ '@id': 'ex:s', name: 'x' }]}) ],
      [ '@language value objects', ctxDoc({ '@id': 'ex:s', name: { '@value': 'x', '@language': 'en' }}) ],
      [ '@reverse usage', ctxDoc({ '@id': 'ex:s', '@reverse': { name: { '@id': 'ex:o' }}}) ],
      [ '@index usage', ctxDoc({ '@id': 'ex:s', name: { '@value': 'x', '@index': 'i' }}) ],
      [ '@set value objects', ctxDoc({ '@id': 'ex:s', name: { '@set': [ 'x' ]}}) ],
      [ 'non-root contexts', ctxDoc({ '@id': 'ex:s', name: { '@context': {}, '@id': 'ex:o' }}) ],
      [ 'inline object contexts', { '@context': { p: `${VOC}p` }, '@id': 'ex:s', p: 'x' }],
      [ 'array contexts with inline objects', { '@context': [{ p: `${VOC}p` }], '@id': 'ex:s', p: 'x' }],
      [ 'empty array contexts', { '@context': [], '@id': `${VOC}s`, [`${VOC}p`]: 'x' }],
      [ 'documents without a context', { '@id': `${VOC}s`, [`${VOC}p`]: 'x' }],
      [ 'root arrays', [{ '@context': CTX_URL, '@id': 'ex:s', name: 'x' }]],
      [ 'non-object roots', '"just a string"' ],
      [ 'null roots', 'null' ],
      [ 'unsafe terms: type-scoped contexts as key', ctxDoc({ '@id': 'ex:s', Scoped: 'x' }) ],
      [ 'unsafe terms: type-scoped contexts as type', ctxDoc({ '@id': 'ex:s', '@type': 'Scoped', name: 'x' }) ],
      [ 'unsafe terms: property-scoped contexts', ctxDoc({ '@id': 'ex:s', scopedProp: { name: 'x' }}) ],
      [ 'unsafe terms: reverse terms', ctxDoc({ '@id': 'ex:s', rev: { '@id': 'ex:o' }}) ],
      [ 'unsafe terms: index containers', ctxDoc({ '@id': 'ex:s', idxMap: { i: 'x' }}) ],
      [ 'unsafe terms: index definitions', ctxDoc({ '@id': 'ex:s', idxDef: 'x' }) ],
      [ 'unsafe terms: nest definitions', ctxDoc({ '@id': 'ex:s', nestDef: 'x' }) ],
      [ 'unsafe terms: language definitions', ctxDoc({ '@id': 'ex:s', langDef: 'x' }) ],
      [ 'unsafe terms: direction definitions', ctxDoc({ '@id': 'ex:s', dirDef: 'x' }) ],
      [ 'unsafe terms: @vocab coercion', ctxDoc({ '@id': 'ex:s', vocabRef: 'name' }) ],
      [ 'unsafe terms: non-string type coercion', ctxDoc({ '@id': 'ex:s', arrayType: 'x' }) ],
      [ 'unsafe terms: keyword aliases', ctxDoc({ aliasId: 'ex:s', name: 'x' }) ],
      [ 'unsafe terms: object keyword aliases', ctxDoc({ '@id': 'ex:s', aliasObj: 'ex:T' }) ],
      [ 'unsafe terms: nulled terms', ctxDoc({ '@id': 'ex:s', nulled: 'x' }) ],
      [ 'unsafe terms: nulled types', ctxDoc({ '@id': 'ex:s', '@type': 'nulled' }) ],
      [ 'terms dropped by a null definition id', ctxDoc({ '@id': 'ex:s', idNull: 'x', name: 'y' }) ],
      [ 'unknown keywords', ctxDoc({ '@id': 'ex:s', '@fake': 'x', name: 'y' }) ],
      [ 'blank node predicates', ctxDoc({ '@id': 'ex:s', '_:p': 'x', name: 'y' }) ],
      [ 'non-string @id values', ctxDoc({ '@id': 42, name: 'x' }) ],
      [ 'non-string @type values', ctxDoc({ '@id': 'ex:s', '@type': 42 }) ],
      [ 'blank node @type values', ctxDoc({ '@id': 'ex:s', '@type': '_:T' }) ],
      [ 'nested arrays', ctxDoc({ '@id': 'ex:s', name: [[ 'x' ]]}) ],
      [ 'nested arrays in list containers', ctxDoc({ '@id': 'ex:s', myList: [[ 'x' ]]}) ],
      [ 'nested arrays in explicit lists', ctxDoc({ '@id': 'ex:s', name: { '@list': [[ 'x' ]]}}) ],
      [ '@list objects with other keys', ctxDoc({ '@id': 'ex:s', name: { '@list': [ 'x' ], 'ex:p': 'y' }}) ],
      [ 'value objects with node keys', ctxDoc({ '@id': 'ex:s', name: { '@value': 'x', '@id': 'ex:o' }}) ],
      [ 'value objects with non-string types', ctxDoc({ '@id': 'ex:s', name: { '@value': 'x', '@type': 42 }}) ],
      [ 'value objects with keyword types', ctxDoc({ '@id': 'ex:s', name: { '@value': 'x', '@type': '@vocab' }}) ],
      [
        'value-first @json value objects',
        ctxDoc({ '@id': 'ex:s', name: { '@value': { b: 1, a: [ true, null ]}, '@type': '@json' }}),
      ],
      [
        '@json value objects with array values',
        ctxDoc({ '@id': 'ex:s', name: { '@type': '@json', '@value': [ 1, 2 ]}}),
      ],
      [
        '@json value objects with nested structures',
        ctxDoc({ '@id': 'ex:s', name: { '@type': '@json', '@value': { out: { inn: 1 }}}}),
      ],
      [
        'value objects with explicitly typed numbers',
        ctxDoc({ '@id': 'ex:s', name: { '@value': 2, '@type': 'http://www.w3.org/2001/XMLSchema#double' }}),
      ],
      [
        'value objects with unexpandable types',
        ctxDoc({ '@id': 'ex:s', name: { '@value': 'x', '@type': 'unknownTerm' }}),
      ],
      [ 'value objects with object values', ctxDoc({ '@id': 'ex:s', name: { '@value': { a: 1 }}}) ],
      [ 'value objects with array values', ctxDoc({ '@id': 'ex:s', name: { '@value': [ 1 ]}}) ],
      [ 'typed null value objects', ctxDoc({ '@id': 'ex:s', name: { '@value': null, '@type': `${VOC}dt` }}) ],
      [ 'huge negative integers', ctxDoc({ '@id': 'ex:s', name: -1e21 }) ],
      [ 'relative @id values', ctxDoc({ '@id': 'relative', name: 'x' }) ],
      [ 'relative @id-coerced references', ctxDoc({ '@id': 'ex:s', ref: 'relative' }) ],
      [ 'unexpandable types', ctxDoc({ '@id': 'ex:s', '@type': 'unknownTerm' }) ],
      [ 'unexpandable keys', ctxDoc({ '@id': 'ex:s', unknownTerm: 'x' }) ],
      [ 'invalid JSON', '{"@context": "http://example.org/context.jsonld", "name": ' ],
    ])('should fall back for %s with identical results', async(label, doc) => {
      const { tookFast } = await expectParity(doc);
      expect(tookFast).toBe(false);
    });

    it('should fall back for contexts declaring a context-level @vocab', async() => {
      const contexts = { 'http://example.org/vocab.jsonld': { '@context': { '@vocab': VOC }}};
      const { tookFast } = await expectParity(
        { '@context': 'http://example.org/vocab.jsonld', '@id': `${VOC}s`, p: 'x' },
        contexts,
      );
      expect(tookFast).toBe(false);
    });

    it('should fast-path contexts declaring only @version', async() => {
      const contexts = { 'http://example.org/versioned.jsonld': { '@context': { '@version': 1.1, p: `${VOC}p` }}};
      const { tookFast } = await expectParity(
        { '@context': 'http://example.org/versioned.jsonld', '@id': `${VOC}s`, p: 'x' },
        contexts,
      );
      expect(tookFast).toBe(true);
    });

    it('should fall back for unresolvable contexts', async() => {
      const { tookFast } = await expectParity(
        { '@context': 'http://example.org/unknown-context.jsonld', '@id': `${VOC}s`, p: 'x' },
      );
      expect(tookFast).toBe(false);
    });

    it('should fall back when vocab-mode term expansion errors', async() => {
      const contexts = { 'http://example.org/expand.jsonld': { '@context': { p: `${VOC}p` }}};
      const original = JsonLdContextNormalized.prototype.expandTerm;
      const spy = jest.spyOn(JsonLdContextNormalized.prototype, 'expandTerm')
        .mockImplementation(<any> function(this: any, ...args: any[]) {
          if (args[0] === 'zzz') {
            throw new Error(`expansion failure for ${args[0]}`);
          }
          return original.apply(this, <any> args);
        });
      try {
        const { tookFast } = await expectParity(
          { '@context': 'http://example.org/expand.jsonld', '@id': `${VOC}s`, zzz: 'x' },
          contexts,
        );
        expect(tookFast).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('should fall back when base-mode term expansion errors', async() => {
      const contexts = { 'http://example.org/expand2.jsonld': { '@context': { p: `${VOC}p` }}};
      const original = JsonLdContextNormalized.prototype.expandTerm;
      const spy = jest.spyOn(JsonLdContextNormalized.prototype, 'expandTerm')
        .mockImplementation(<any> function(this: any, ...args: any[]) {
          if (args[0] === 'zzz2' && !args[1]) {
            throw new Error(`expansion failure for ${args[0]}`);
          }
          return original.apply(this, <any> args);
        });
      try {
        const { tookFast } = await expectParity(
          { '@context': 'http://example.org/expand2.jsonld', '@id': 'zzz2', p: 'x' },
          contexts,
        );
        expect(tookFast).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('should fall back for unresolvable contexts consistently across documents', async() => {
      // The (negative) analysis must also be cached and shared.
      const contexts = { ...RICH_CONTEXTS };
      const doc = { '@context': 'http://example.org/unknown-context.jsonld', '@id': `${VOC}s`, p: 'x' };
      expect((await expectParity(doc, contexts)).tookFast).toBe(false);
      expect((await expectParity(doc, contexts)).tookFast).toBe(false);
    });
  });

  describe('candidate detection', () => {
    it('should not attempt the fast path without prefetched contexts', async() => {
      const { tookFast } = await expectParity({ '@id': `${VOC}s`, [`${VOC}p`]: 'x' }, undefined);
      expect(tookFast).toBe(false);
    });

    it('should not attempt the fast path when disabled explicitly', async() => {
      const spy = jest.spyOn(rdfParser, 'parse');
      const quads = await arrayifyStream(new RdfParser().parse(
        streamifyString(JSON.stringify(ctxDoc({ '@id': 'ex:s', name: 'x' }))),
        makeOptions(true, RICH_CONTEXTS),
      ));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(quads).toHaveLength(1);
      spy.mockRestore();
    });

    it('should not attempt the fast path for non-JSON-LD paths', async() => {
      const spy = jest.spyOn(rdfParser, 'parse');
      const quads = await arrayifyStream(new RdfParser().parse(
        streamifyString(`<${VOC}s> <${VOC}p> <${VOC}o>.`),
        makeOptions(false, RICH_CONTEXTS, { path: 'file.ttl' }),
      ));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(quads).toHaveLength(1);
      spy.mockRestore();
    });

    it('should not attempt the fast path for non-JSON-LD content types', async() => {
      const spy = jest.spyOn(rdfParser, 'parse');
      const quads = await arrayifyStream(new RdfParser().parse(
        streamifyString(`<${VOC}s> <${VOC}p> <${VOC}o>.`),
        makeOptions(false, RICH_CONTEXTS, <any> { contentType: 'text/turtle' }),
      ));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(quads).toHaveLength(1);
      spy.mockRestore();
    });

    it('should attempt the fast path for JSON-LD content types regardless of path', async() => {
      const spy = jest.spyOn(rdfParser, 'parse');
      const quads = await arrayifyStream(new RdfParser().parse(
        streamifyString(JSON.stringify(ctxDoc({ '@id': 'ex:s', name: 'x' }))),
        makeOptions(false, RICH_CONTEXTS, <any> { path: 'file.txt', contentType: 'application/ld+json' }),
      ));
      expect(spy).not.toHaveBeenCalled();
      expect(quads).toHaveLength(1);
      spy.mockRestore();
    });
  });

  describe('document buffering', () => {
    it('should stream documents larger than the buffer cap through the generic parser', async() => {
      const originalCap = RdfParser.fastPathBufferCap;
      RdfParser.fastPathBufferCap = 10;
      try {
        const spy = jest.spyOn(rdfParser, 'parse');
        const stream = new PassThrough();
        const outputPromise = arrayifyStream(new RdfParser()
          .parse(stream, makeOptions(false, RICH_CONTEXTS)));
        const docText = JSON.stringify(ctxDoc({ '@id': 'ex:s', name: 'x' }));
        stream.write(docText.slice(0, 20));
        stream.write(docText.slice(20));
        stream.end();
        const quads = await outputPromise;
        expect(spy).toHaveBeenCalledTimes(1);
        expect(quads).toBeRdfIsomorphic([ quad(`${VOC}s`, `${VOC}name`, '"x"') ]);
        spy.mockRestore();
      } finally {
        RdfParser.fastPathBufferCap = originalCap;
      }
    });

    it('should support Buffer chunks', async() => {
      const stream = new PassThrough();
      const outputPromise = arrayifyStream(new RdfParser()
        .parse(stream, makeOptions(false, RICH_CONTEXTS)));
      stream.write(Buffer.from(JSON.stringify(ctxDoc({ '@id': 'ex:s', name: 'x' }))));
      stream.end();
      const quads = await outputPromise;
      expect(quads).toBeRdfIsomorphic([ quad(`${VOC}s`, `${VOC}name`, '"x"') ]);
    });

    it('should support string chunks', async() => {
      const docText = JSON.stringify(ctxDoc({ '@id': 'ex:s', name: 'x' }));
      const stream = Readable.from([ docText.slice(0, 20), docText.slice(20) ]);
      const quads = await arrayifyStream(new RdfParser()
        .parse(stream, makeOptions(false, RICH_CONTEXTS)));
      expect(quads).toBeRdfIsomorphic([ quad(`${VOC}s`, `${VOC}name`, '"x"') ]);
    });

    it('should wrap errors emitted while buffering', async() => {
      const stream = new PassThrough();
      const outputPromise = arrayifyStream(new RdfParser()
        .parse(stream, makeOptions(false, RICH_CONTEXTS)));
      stream.emit('error', new Error('buffer failure'));
      await expect(outputPromise).rejects
        .toThrow('Error while parsing file "file.jsonld": buffer failure');
    });

    it('should wrap errors thrown synchronously by the generic parser after fallback', async() => {
      const spy = jest.spyOn(rdfParser, 'parse').mockImplementation(() => {
        throw new Error('sync parser failure');
      });
      const outputPromise = arrayifyStream(new RdfParser().parse(
        streamifyString('{"@graph": []}'),
        makeOptions(false, RICH_CONTEXTS),
      ));
      await expect(outputPromise).rejects
        .toThrow('Error while parsing file "file.jsonld": sync parser failure');
      spy.mockRestore();
    });
  });

  describe('interaction with imports', () => {
    it('should follow imports emitted by fast-pathed documents', async() => {
      const importTarget = JSON.stringify(ctxDoc({ '@id': 'ex:other', name: 'imported' }));
      globalThis.fetch = <any> jest.fn(async() => ({
        body: streamifyString(importTarget),
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/ld+json' }),
        statusText: 'OK',
      }));
      const doc = ctxDoc({
        '@id': 'ex:s',
        name: 'root',
        'http://www.w3.org/2000/01/rdf-schema#seeAlso': { '@id': 'http://example.org/imported.jsonld' },
      });
      const spy = jest.spyOn(rdfParser, 'parse');
      const quads = await arrayifyStream(new RdfParser().parse(
        streamifyString(JSON.stringify(doc)),
        makeOptions(false, RICH_CONTEXTS, { path: 'http://example.org/root.jsonld' }),
      ));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(quads).toBeRdfIsomorphic([
        quad('http://example.org/voc/s', `${VOC}name`, '"root"'),
        quad(
          'http://example.org/voc/s',
          'http://www.w3.org/2000/01/rdf-schema#seeAlso',
          'http://example.org/imported.jsonld',
        ),
        quad('http://example.org/voc/other', `${VOC}name`, '"imported"'),
      ]);
    });
  });
});
