import type * as RDF from '@rdfjs/types';

// eslint-disable-next-line ts/no-require-imports
import canonicalizeJsonModule = require('canonicalize');
import type { JsonLdContextNormalized } from 'jsonld-context-parser';
import { ContextParser, Util as ContextUtil } from 'jsonld-context-parser';
import { DataFactory } from 'rdf-data-factory';
import { IRIS_RDF, IRIS_XSD, PREFIX_RDF } from './Iris';
import { PrefetchedDocumentLoader } from './PrefetchedDocumentLoader';
import type { RdfParserOptions } from './RdfParser';

const IRI_RDF_FIRST = PREFIX_RDF('first');
const IRI_RDF_REST = PREFIX_RDF('rest');
const IRI_RDF_NIL = PREFIX_RDF('nil');

// The canonicalize module is a callable CommonJS export,
// but its type declarations only describe an ES default export.
const canonicalizeJson: (input: unknown) => string | undefined = <any> canonicalizeJsonModule;

/**
 * The term expansion options that {@link https://www.npmjs.com/package/jsonld-streaming-parser|jsonld-streaming-parser}
 * applies in its default JSON-LD 1.1 processing mode.
 * These MUST be mirrored here so that the fast path expands terms identically to the generic parser.
 */
const EXPAND_OPTIONS = {
  allowPrefixForcing: true,
  allowPrefixNonGenDelims: false,
  allowVocabRelativeToBase: true,
};

/**
 * Document-level JSON-LD keywords that the fast path does not implement.
 * Any (potential) use of one of these in a document makes the document fall back to the generic parser.
 * This is intentionally over-eager (e.g. a matching substring inside a string literal also triggers a fallback):
 * a false positive merely costs performance, never correctness.
 */
// eslint-disable-next-line max-len
const UNSUPPORTED_DOC_PATTERN = /"@(?:graph|reverse|index|nest|included|direction|base|vocab|language|set|container|prefix|version|propagate|protected|import|annotation|none)"\s*:/u;

/**
 * Matches all occurrences of the `@context` keyword, used to detect (unsupported) non-root contexts.
 */
const CONTEXT_KEY_PATTERN = /"@context"\s*:/gu;

/**
 * Internal signal to abort fast-path conversion and fall back to the generic parser.
 */
class FastPathBailout extends Error {
  public constructor() {
    super('JSON-LD fast path bailout');
  }
}

/**
 * The pre-analyzed state of a normalized JSON-LD context, reused across all documents sharing that context.
 */
interface IFastPathContextEntry {
  /**
   * The normalized context.
   */
  context: JsonLdContextNormalized;
  /**
   * The raw normalized context map (the result of {@link JsonLdContextNormalized.getContextRaw}).
   */
  dict: Record<string, any>;
  /**
   * Terms whose definitions carry JSON-LD features the fast path cannot honour
   * (property-/type-scoped contexts, reverse properties, non-list containers, ...).
   * Any document using one of these terms as a key or `@type` value falls back to the generic parser.
   */
  unsafeTerms: Set<string>;
  /**
   * Memoized vocab-mode term-to-IRI expansions (`expandTerm(term, true)`).
   * `null` means the term expands to nothing (dropped);
   * `false` means expansion errored (the generic parser reproduces the error).
   */
  vocabIris: Map<string, string | null | false>;
  /**
   * Memoized base-mode term-to-IRI expansions (`expandTerm(term, false)`).
   */
  baseIris: Map<string, string | null | false>;
  /**
   * Memoized `@type`-value expansions (vocab-mode with base-mode fallback).
   */
  typeIris: Map<string, string | null>;
}

/**
 * Normalized-context caches, keyed (weakly) on the prefetched-contexts record that a
 * ComponentsManager threads through all of its parse invocations.
 * Entries are promises to deduplicate concurrent normalizations of the same context.
 */
const contextCaches =
  new WeakMap<Record<string, any>, Map<string, Promise<IFastPathContextEntry | undefined>>>();

/**
 * A monotonic counter to give every converted document a distinct blank node label namespace.
 */
let documentCounter = 0;

/**
 * Check if the given parse options allow attempting the fast path at all.
 * @param options RDF parser options.
 */
export function isJsonLdFastPathCandidate(options: RdfParserOptions): boolean {
  if (options.disableJsonLdFastPath) {
    return false;
  }
  if (!options.contexts) {
    return false;
  }
  const contentType: string | undefined = (<any> options).contentType;
  if (contentType) {
    return contentType === 'application/ld+json' || contentType === 'application/json';
  }
  return options.path.endsWith('.jsonld') || options.path.endsWith('.json');
}

/**
 * Attempt to convert the given JSON-LD document text into quads via a specialized,
 * synchronous fast path for the fixed-shape, known-context documents
 * that componentsjs itself generates and consumes.
 *
 * Motivation: a Components.js-based application load parses hundreds of small JSON-LD documents
 * that all share a handful of well-known contexts and a rigidly regular structure.
 * The generic streaming pipeline pays per-value async handler dispatch and per-document parser
 * construction for flexibility these documents never use.
 * This fast path normalizes each distinct context ONCE (with the real, spec-compliant
 * {@link ContextParser}), and then converts documents with a plain synchronous recursive walk.
 *
 * Correctness contract: this is NOT a general JSON-LD processor.
 * This function inspects each document (and its context) and returns `undefined`
 * whenever the document could use any feature outside the implemented subset,
 * in which case the caller MUST fall back to the generic parser.
 * Term-to-IRI expansion is delegated to (memoized) jsonld-context-parser `expandTerm` calls,
 * so IRI semantics are identical to the generic parser by construction.
 *
 * The implemented subset: root-level `@context` (URLs resolvable from the prefetched contexts),
 * `@id`, `@type`, `@value` (with `@type`, including `@json`), `@list` (and `@container: @list` terms),
 * `@type: @id` term coercion, datatype coercion, compact IRIs, blank nodes, numbers, booleans and null.
 * Documents (potentially) using anything else — `@graph`, `@reverse`, `@language`, `@index`, `@nest`,
 * `@base`, `@vocab`, nested contexts, scoped contexts, relative IRIs, ... — fall back.
 * @param text The full document text.
 * @param options RDF parser options.
 * @returns The document's quads, or `undefined` if the document is outside the supported
 *          subset and MUST be parsed with the generic parser instead.
 */
export async function tryParseJsonLdFastPath(text: string, options: RdfParserOptions): Promise<RDF.Quad[] | undefined> {
  // Reject documents that may use unsupported keywords, or that have non-root contexts.
  if (UNSUPPORTED_DOC_PATTERN.test(text) || (text.match(CONTEXT_KEY_PATTERN) ?? []).length > 1) {
    return;
  }

  // Parse the JSON; syntax errors are reported by the generic parser for identical error behaviour.
  let document: any;
  try {
    document = JSON.parse(text);
  } catch {
    return;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return;
  }

  const entry = await getContextEntry(document['@context'], options);
  if (!entry) {
    return;
  }

  try {
    return new FastPathConverter(entry, documentCounter++).convertDocument(document);
  } catch {
    // A bailout: the document goes outside the supported subset somewhere,
    // so it must be (re-)parsed with the generic parser.

  }
}

/**
 * Obtain (or build and cache) the analyzed context entry for the given root `@context` value.
 * @param contextValue The document's root `@context` value.
 * @param options RDF parser options.
 * @returns The analyzed context entry,
 *          or `undefined` if the context is outside the supported subset.
 */
async function getContextEntry(
  contextValue: any,
  options: RdfParserOptions,
): Promise<IFastPathContextEntry | undefined> {
  // Only string contexts (single or array) are supported,
  // as the cache is keyed on their URLs.
  const urls: string[] = typeof contextValue === 'string' ? [ contextValue ] : contextValue;
  if (!Array.isArray(urls) || urls.length === 0 || urls.some(url => typeof url !== 'string')) {
    return;
  }

  let cache = contextCaches.get(options.contexts!);
  if (!cache) {
    cache = new Map();
    contextCaches.set(options.contexts!, cache);
  }
  const key = urls.join('\n');
  let entryPromise = cache.get(key);
  if (!entryPromise) {
    entryPromise = buildContextEntry(contextValue, options);
    cache.set(key, entryPromise);
  }
  return entryPromise;
}

/**
 * Normalize and analyze a context.
 * @param contextValue The document's root `@context` value.
 * @param options RDF parser options.
 */
async function buildContextEntry(
  contextValue: any,
  options: RdfParserOptions,
): Promise<IFastPathContextEntry | undefined> {
  let context: JsonLdContextNormalized;
  try {
    // Remote lookups are never allowed here; contexts requiring them fall back to
    // the generic parser, which implements the configured remote lookup behaviour.
    context = await new ContextParser({
      documentLoader: new PrefetchedDocumentLoader({
        contexts: options.contexts!,
        remoteContextLookups: false,
      }),
      skipValidation: options.skipContextValidation,
    }).parse(contextValue);
  } catch {
    return;
  }

  const dict = context.getContextRaw();
  const unsafeTerms = new Set<string>();
  for (const term of Object.keys(dict)) {
    if (term.startsWith('@')) {
      // Context-level keywords: only the processing-mode version marker is supported.
      if (term !== '@version') {
        return;
      }
      continue;
    }
    const definition = dict[term];
    if (definition === null || typeof definition === 'string') {
      // Nullified terms are dropped silently by JSON-LD processors; keyword aliases change
      // document structure. Both are out of subset: fall back when such a term is used.
      if (definition === null || definition.startsWith('@')) {
        unsafeTerms.add(term);
      }
      continue;
    }
    if (
      typeof definition !== 'object' ||
      // Scoped contexts, reverse properties, language/direction defaults,
      // and index/nest maps are out of subset.
      '@context' in definition || '@reverse' in definition || '@language' in definition ||
      '@direction' in definition || '@index' in definition || '@nest' in definition ||
      // Only @list (and the semantically transparent @set) containers are supported.
      (definition['@container'] &&
        Object.keys(definition['@container']).some(container => container !== '@list' && container !== '@set')) ||
      // Type coercion: only @id, @json, and datatype IRIs are supported.
      ('@type' in definition && (typeof definition['@type'] !== 'string' ||
        (definition['@type'].startsWith('@') &&
          definition['@type'] !== '@id' && definition['@type'] !== '@json'))) ||
      // Keyword aliasing through expanded term definitions is out of subset.
      (typeof definition['@id'] === 'string' && definition['@id'].startsWith('@'))
    ) {
      unsafeTerms.add(term);
    }
  }

  return {
    context,
    dict,
    unsafeTerms,
    vocabIris: new Map(),
    baseIris: new Map(),
    typeIris: new Map(),
  };
}

/**
 * Converts a single guarded JSON-LD document to quads. See {@link tryParseJsonLdFastPath}.
 */
class FastPathConverter {
  private readonly entry: IFastPathContextEntry;
  private readonly dataFactory: DataFactory;
  private readonly blankNodePrefix: string;
  private readonly quads: RDF.Quad[] = [];
  private blankNodeCounter = 0;

  public constructor(entry: IFastPathContextEntry, documentId: number) {
    this.entry = entry;
    this.dataFactory = new DataFactory();
    this.blankNodePrefix = `cjsfp-${documentId}-`;
  }

  /**
   * Convert the given document, throwing {@link FastPathBailout} if it is outside the supported subset.
   * @param document A parsed JSON-LD document (a root node object).
   */
  public convertDocument(document: any): RDF.Quad[] {
    // The root context was already consumed by the context analysis.
    delete document['@context'];
    this.convertNode(document);
    return this.quads;
  }

  /**
   * Emit all quads for the given node object, and return the term identifying it.
   * @param node A node object.
   */
  private convertNode(node: Record<string, any>): RDF.NamedNode | RDF.BlankNode {
    const id = node['@id'];
    if (id !== undefined && typeof id !== 'string') {
      throw new FastPathBailout();
    }
    const subject = id === undefined ? this.blankNode() : this.termForId(id);

    for (const key of Object.keys(node)) {
      if (key === '@id') {
        continue;
      }
      if (key === '@type') {
        this.emitTypes(subject, node[key]);
        continue;
      }
      if (key.startsWith('@') || this.entry.unsafeTerms.has(key)) {
        // Any other keyword (or keyword-like key), and any term whose definition is out of
        // subset (e.g. a property-scoped context), aborts to the generic parser.
        throw new FastPathBailout();
      }
      const predicateIri = this.expandVocab(key);
      if (!predicateIri || predicateIri.startsWith('@') || predicateIri.startsWith('_:') ||
        !ContextUtil.isValidIri(predicateIri)) {
        // The generic parser drops or errors on these; it decides.
        throw new FastPathBailout();
      }
      const definition = this.entry.dict[key];
      this.emitProperty(
        subject,
        this.dataFactory.namedNode(predicateIri),
        node[key],
        typeof definition === 'object' ? definition : undefined,
      );
    }
    return subject;
  }

  /**
   * Emit `rdf:type` quads for the given `@type` value.
   * @param subject The node's subject term.
   * @param types The raw `@type` value.
   */
  private emitTypes(subject: RDF.NamedNode | RDF.BlankNode, types: any): void {
    for (const type of Array.isArray(types) ? types : [ types ]) {
      if (typeof type !== 'string' || type.startsWith('_:') || this.entry.unsafeTerms.has(type)) {
        // Blank node types and types that would activate a type-scoped context
        // are handled by the generic parser.
        throw new FastPathBailout();
      }
      const iri = this.expandTypeIri(type);
      if (iri === null || iri.startsWith('@')) {
        // Mirrors the generic parser: types expanding to keywords are skipped silently.
        continue;
      }
      if (!ContextUtil.isValidIri(iri)) {
        throw new FastPathBailout();
      }
      this.quads.push(this.dataFactory.quad(
        subject,
        this.dataFactory.namedNode(IRIS_RDF.type),
        this.dataFactory.namedNode(iri),
      ));
    }
  }

  /**
   * Emit the quad(s) for a single property of a node.
   * @param subject The node's subject term.
   * @param predicate The property's predicate term.
   * @param value The property's raw value.
   * @param definition The property's term definition, if it is an expanded term definition.
   */
  private emitProperty(
    subject: RDF.NamedNode | RDF.BlankNode,
    predicate: RDF.NamedNode,
    value: any,
    definition: Record<string, any> | undefined,
  ): void {
    // JSON-typed terms capture their full raw value as a single JSON literal.
    if (definition && definition['@type'] === '@json') {
      this.quads.push(this.dataFactory.quad(subject, predicate, this.jsonLiteral(value)));
      return;
    }
    if (value === null) {
      // Null values are dropped.
      return;
    }
    if (definition && definition['@container'] && definition['@container']['@list']) {
      this.quads.push(this.dataFactory.quad(subject, predicate, this.listToTerm(value, definition)));
      return;
    }
    if (Array.isArray(value)) {
      for (const element of value) {
        if (Array.isArray(element)) {
          // Nested-array flattening is left to the generic parser.
          throw new FastPathBailout();
        }
        const term = this.valueToTerm(element, definition);
        if (term) {
          this.quads.push(this.dataFactory.quad(subject, predicate, term));
        }
      }
      return;
    }
    const term = this.valueToTerm(value, definition);
    if (term) {
      this.quads.push(this.dataFactory.quad(subject, predicate, term));
    }
  }

  /**
   * Convert a single (non-array) property value into a term,
   * emitting quads for nested node objects and lists along the way.
   * @param value A raw property value.
   * @param definition The property's term definition, if it is an expanded term definition.
   * @returns The value's term, or `undefined` if the value is dropped (JSON-LD null semantics).
   */
  private valueToTerm(
    value: any,
    definition: Record<string, any> | undefined,
  ): RDF.NamedNode | RDF.BlankNode | RDF.Literal | undefined {
    const coercion: string | undefined = definition ? definition['@type'] : undefined;
    switch (typeof value) {
      case 'string':
        if (coercion === '@id') {
          return this.termForId(value);
        }
        return coercion === undefined ?
          this.dataFactory.literal(value) :
          this.dataFactory.literal(value, this.dataFactory.namedNode(coercion));
      case 'number':
        return this.numberToTerm(value, coercion);
      case 'boolean':
        return this.dataFactory.literal(
          String(value),
          this.dataFactory.namedNode(coercion !== undefined && coercion !== '@id' ? coercion : IRIS_XSD.boolean),
        );
      default:
        // Case 'object', the only other type JSON.parse can produce.
        if (value === null) {
          return;
        }
        // Note: value is never an array here; all callers handle (and pre-check) arrays.
        if ('@value' in value) {
          return this.valueObjectToTerm(value);
        }
        if ('@list' in value) {
          if (Object.keys(value).length > 1) {
            throw new FastPathBailout();
          }
          return this.listToTerm(value['@list'], definition);
        }
        return this.convertNode(value);
    }
  }

  /**
   * Convert a value object (`@value`) into a term.
   * @param value A value object.
   * @returns The value's term, or `undefined` if the value is dropped (JSON-LD null semantics).
   */
  private valueObjectToTerm(value: Record<string, any>): RDF.Literal | undefined {
    const keys = Object.keys(value);
    if (value['@type'] === '@json') {
      // The generic (streaming) parser only reliably recognizes JSON values when the `@type`
      // arrives before the `@value`, and only for scalars and flat scalar maps
      // (deeper structures interact with its strict-mode key processing);
      // mirror that sensitivity exactly and leave everything else to it.
      if (keys.length === 2 && keys[0] === '@type' && keys[1] === '@value' &&
        FastPathConverter.isScalarOrFlatScalarMap(value['@value'])) {
        return this.jsonLiteral(value['@value']);
      }
      throw new FastPathBailout();
    }
    let typeIri: string | undefined;
    for (const key of keys) {
      if (key === '@value') {
        continue;
      }
      if (key !== '@type') {
        throw new FastPathBailout();
      }
      const type = value[key];
      // The generic parser has intricate `@type`-specific behaviour here
      // (keyword types): it implements those cases.
      if (typeof type !== 'string' || type.startsWith('@')) {
        throw new FastPathBailout();
      }
      const iri = this.expandTypeIri(type);
      if (!iri || !ContextUtil.isValidIri(iri)) {
        throw new FastPathBailout();
      }
      typeIri = iri;
    }

    const rawValue = value['@value'];
    switch (typeof rawValue) {
      case 'string':
        return typeIri === undefined ?
          this.dataFactory.literal(rawValue) :
          this.dataFactory.literal(rawValue, this.dataFactory.namedNode(typeIri));
      case 'number':
        // The generic parser does not canonicalize explicitly-typed numeric values;
        // it implements that case.
        if (typeIri !== undefined) {
          throw new FastPathBailout();
        }
        return this.numberToTerm(rawValue, typeIri);
      case 'boolean':
        return this.dataFactory.literal(
          String(rawValue),
          this.dataFactory.namedNode(typeIri ?? IRIS_XSD.boolean),
        );
      default:
        // Null values are dropped; object/array values are invalid — in both cases,
        // the generic parser implements the exact behaviour.
        if (rawValue === null && typeIri === undefined) {
          return;
        }
        throw new FastPathBailout();
    }
  }

  /**
   * Convert a JSON number into a literal, mirroring the generic parser's
   * datatype selection and canonical lexical forms.
   * @param value A number.
   * @param coercion The term definition's `@type` value, if any.
   */
  private numberToTerm(value: number, coercion: string | undefined): RDF.Literal {
    if (value % 1 === 0 && value <= -1e21) {
      // The generic pipeline emits a non-canonical xsd:integer lexical form for these;
      // let it decide rather than replicating that behaviour.
      throw new FastPathBailout();
    }
    let datatype = value % 1 === 0 && value < 1e21 ? IRIS_XSD.integer : IRIS_XSD.double;
    if (coercion !== undefined && coercion !== '@id') {
      datatype = coercion;
    }
    const lexicalForm = value % 1 === 0 && datatype !== IRIS_XSD.double ?
      String(value) :
      value.toExponential(15).replace(/(\d)0*e\+?/u, '$1E');
    return this.dataFactory.literal(lexicalForm, this.dataFactory.namedNode(datatype));
  }

  /**
   * Build an RDF list for the given raw `@list` value, and return its head term.
   * @param value The raw list value.
   * @param definition The property's term definition, if it is an expanded term definition.
   */
  private listToTerm(value: any, definition: Record<string, any> | undefined): RDF.NamedNode | RDF.BlankNode {
    const elements = Array.isArray(value) ? value : [ value ];
    let head: RDF.NamedNode | RDF.BlankNode = this.dataFactory.namedNode(IRI_RDF_NIL);
    for (let i = elements.length - 1; i >= 0; i--) {
      if (Array.isArray(elements[i])) {
        // Lists of lists are left to the generic parser.
        throw new FastPathBailout();
      }
      const term = this.valueToTerm(elements[i], definition);
      if (!term) {
        // Null list elements are dropped.
        continue;
      }
      const cell = this.blankNode();
      this.quads.push(this.dataFactory.quad(cell, this.dataFactory.namedNode(IRI_RDF_FIRST), term));
      this.quads.push(this.dataFactory.quad(cell, this.dataFactory.namedNode(IRI_RDF_REST), head));
      head = cell;
    }
    return head;
  }

  /**
   * Check whether the given JSON value is a scalar, or an object whose values are all scalars.
   * @param value Any JSON value.
   */
  private static isScalarOrFlatScalarMap(value: any): boolean {
    if (value === null || typeof value !== 'object') {
      return true;
    }
    if (Array.isArray(value)) {
      return false;
    }
    return Object.values(value).every(entry => entry === null || typeof entry !== 'object');
  }

  /**
   * Create a canonical `rdf:JSON` literal for the given raw JSON value,
   * using the same canonicalization as the generic parser.
   * @param value Any JSON value.
   */
  private jsonLiteral(value: any): RDF.Literal {
    return this.dataFactory.literal(canonicalizeJson(value)!, this.dataFactory.namedNode(IRIS_RDF.JSON));
  }

  /**
   * Convert an `@id` (or `@type: @id`-coerced) string into a term.
   * @param value An identifier string.
   */
  private termForId(value: string): RDF.NamedNode | RDF.BlankNode {
    if (value.startsWith('_:')) {
      return this.dataFactory.blankNode(value.slice(2));
    }
    const iri = this.expandBase(value);
    if (!iri || !ContextUtil.isValidIri(iri)) {
      // Notably: relative IRIs, which the generic parser resolves against the base IRI.
      throw new FastPathBailout();
    }
    return this.dataFactory.namedNode(iri);
  }

  /**
   * Create a fresh blank node with a label that cannot collide with the labels of any other
   * document (fast-pathed or not) parsed into the same object graph.
   */
  private blankNode(): RDF.BlankNode {
    return this.dataFactory.blankNode(`${this.blankNodePrefix}${this.blankNodeCounter++}`);
  }

  /**
   * Memoized vocab-mode term expansion, mirroring the generic parser's predicate expansion.
   * @param term A term.
   * @returns The expanded IRI, or `null` when expansion fails
   *          (in which case the generic parser implements the exact drop/error behaviour).
   */
  private expandVocab(term: string): string | null {
    let iri = this.entry.vocabIris.get(term);
    if (iri === undefined) {
      try {
        iri = this.entry.context.expandTerm(term, true, EXPAND_OPTIONS);
      } catch {
        iri = false;
      }
      this.entry.vocabIris.set(term, iri);
    }
    if (iri === false) {
      throw new FastPathBailout();
    }
    return iri;
  }

  /**
   * Memoized base-mode term expansion, mirroring the generic parser's resource expansion.
   * @param term A term.
   * @returns The expanded IRI, or `null` when expansion fails.
   */
  private expandBase(term: string): string | null {
    let iri = this.entry.baseIris.get(term);
    if (iri === undefined) {
      try {
        iri = this.entry.context.expandTerm(term, false, EXPAND_OPTIONS);
      } catch {
        iri = false;
      }
      this.entry.baseIris.set(term, iri);
    }
    if (iri === false) {
      throw new FastPathBailout();
    }
    return iri;
  }

  /**
   * Memoized `@type`-value expansion, mirroring the generic parser's
   * vocab-mode-with-base-mode-fallback expansion of type IRIs.
   * @param term A term.
   * @returns The expanded IRI, or `null` when expansion fails.
   */
  private expandTypeIri(term: string): string | null {
    let iri = this.entry.typeIris.get(term);
    if (iri === undefined) {
      iri = this.expandVocab(term);
      if (iri === term) {
        iri = this.expandBase(term);
      }
      this.entry.typeIris.set(term, iri);
    }
    return iri;
  }
}
