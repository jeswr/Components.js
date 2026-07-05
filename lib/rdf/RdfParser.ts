import { createReadStream, promises as fs } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import type * as RDF from '@rdfjs/types';
import type { ParseOptions } from 'rdf-parse';
import { rdfParser } from 'rdf-parse';
import type { Logger } from 'winston';
import { isJsonLdFastPathCandidate, tryParseJsonLdFastPath } from './JsonLdFastPath';
import { PrefetchedDocumentLoader } from './PrefetchedDocumentLoader';
import { RdfStreamIncluder } from './RdfStreamIncluder';

/**
 * Parses a data stream to a triple stream.
 */
export class RdfParser {
  /**
   * The maximum number of bytes {@link RdfParser.parseViaFastPath} may buffer.
   * Documents larger than this cap are streamed through the generic parser.
   */
  public static fastPathBufferCap = 8 * 1_024 * 1_024;

  /**
   * Parses the given stream into RDF quads.
   * @param textStream A text stream.
   * @param options Parsing options.
   */
  public parse(textStream: NodeJS.ReadableStream, options: RdfParserOptions): RDF.Stream & Readable {
    // Parsing libraries don't work as expected if path contains backslashes
    options.path = options.path.replaceAll(/\\+/gu, '/');

    if (!options.baseIRI) {
      // Try converting path to URL using defined import paths
      if (options.importPaths) {
        for (const [ url, file ] of Object.entries(options.importPaths)) {
          if (options.path.startsWith(file)) {
            options.baseIRI = `${url}${options.path.slice(file.length)}`;
            break;
          }
        }
      }

      // Fallback to a baseIRI using the file scheme
      if (!options.baseIRI) {
        options.baseIRI = options.path;
        // Windows paths always contain a ':'
        if (!options.baseIRI.includes(':') || /^[A-Za-z]:[/\\][^/]/u.test(options.baseIRI)) {
          options.baseIRI = `file://${options.baseIRI}`;
        }
      }
    }

    // Set JSON-LD parser options
    (<any> options)['@comunica/actor-rdf-parse-jsonld:parserOptions'] = {
      // Override the JSON-LD document loader
      documentLoader: new PrefetchedDocumentLoader({
        contexts: options.contexts ?? {},
        logger: options.logger,
        path: options.path,
        remoteContextLookups: options.remoteContextLookups,
      }),
      // Enable strict parsing of JSON-LD to error on potential user config errors
      strictValues: true,
      // If JSON-LD context validation should be skipped
      skipContextValidation: options.skipContextValidation,
    };

    // Execute parsing
    const includedQuadStream = new RdfStreamIncluder(options);
    if (isJsonLdFastPathCandidate(options)) {
      // Buffer the document and attempt the specialized JSON-LD fast path,
      // falling back to the generic parser for anything outside its subset.
      this.parseViaFastPath(textStream, options, includedQuadStream);
    } else {
      this.parseGeneric(textStream, options, includedQuadStream);
    }
    return includedQuadStream;
  }

  /**
   * Parse the given stream with the generic parsing pipeline.
   * @param textStream A text stream.
   * @param options Parsing options.
   * @param includedQuadStream The output stream.
   */
  protected parseGeneric(
    textStream: NodeJS.ReadableStream,
    options: RdfParserOptions,
    includedQuadStream: RdfStreamIncluder,
  ): void {
    const quadStream = rdfParser.parse(textStream, options);
    quadStream.pipe(includedQuadStream);
    quadStream.on('error', (error: Error) => includedQuadStream
      .emit('error', RdfParser.addPathToError(error, options.path)));
  }

  /**
   * Buffer the given JSON-LD document stream, and parse it via {@link JsonLdFastPath} when possible,
   * or via the generic parsing pipeline otherwise.
   * @param textStream A text stream.
   * @param options Parsing options.
   * @param includedQuadStream The output stream.
   */
  protected parseViaFastPath(
    textStream: NodeJS.ReadableStream,
    options: RdfParserOptions,
    includedQuadStream: RdfStreamIncluder,
  ): void {
    const chunks: (Buffer | string)[] = [];
    let bufferedLength = 0;
    let streamedThrough = false;
    textStream.on('data', (chunk: Buffer | string) => {
      if (streamedThrough) {
        return;
      }
      chunks.push(chunk);
      bufferedLength += chunk.length;
      if (bufferedLength > RdfParser.fastPathBufferCap) {
        // The document is too large to buffer; replay what was consumed and stream the rest
        // directly into the generic parser.
        streamedThrough = true;
        const replayStream = new PassThrough();
        for (const bufferedChunk of chunks) {
          replayStream.write(bufferedChunk);
        }
        textStream.pipe(replayStream);
        this.parseGeneric(replayStream, options, includedQuadStream);
      }
    });
    textStream.on('error', (error: Error) => includedQuadStream
      .emit('error', RdfParser.addPathToError(error, options.path)));
    // eslint-disable-next-line ts/no-misused-promises
    textStream.on('end', async() => {
      if (streamedThrough) {
        return;
      }
      try {
        const text = Buffer
          .concat(chunks.map(chunk => typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk))
          .toString('utf8');
        const quads = await tryParseJsonLdFastPath(text, options);
        if (quads) {
          for (const quad of quads) {
            includedQuadStream.write(quad);
          }
          includedQuadStream.end();
        } else {
          this.parseGeneric(Readable.from([ text ]), options, includedQuadStream);
        }
      } catch (error: unknown) {
        includedQuadStream.emit('error', RdfParser.addPathToError(<Error> error, options.path));
      }
    });
  }

  /**
   * Get the file contents from a file path or URL.
   * @param pathOrUrl The file path or url.
   * @returns {Promise<T>} A promise resolving to the data stream.
   */
  public static async fetchFileOrUrl(pathOrUrl: string): Promise<Readable> {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      return <any> (await fetch(pathOrUrl)).body;
    }
    if (pathOrUrl.startsWith('file://')) {
      pathOrUrl = pathOrUrl.slice(7);
    }
    if (!(await fs.stat(pathOrUrl)).isFile()) {
      throw new Error(`Path does not refer to a valid file: ${pathOrUrl}`);
    }
    return createReadStream(pathOrUrl);
  }

  /**
   * Add the path to an error message.
   * @param error The original error message.
   * @param path The file path or URL.
   * @returns {Error} The new error with file path context.
   */
  public static addPathToError(error: Error, path: string): Error {
    return new Error(`Error while parsing file "${path}": ${error.message}`);
  }
}

export type RdfParserOptions = ParseOptions & {
  /**
   * If imports in the RDF document should be ignored.
   */
  ignoreImports?: boolean;
  /**
   * The file name or URL that is being parsed.
   */
  path: string;
  /**
   * The cached JSON-LD contexts.
   */
  contexts?: Record<string, any>;
  /**
   * The cached import paths. (URL -> file)
   */
  importPaths?: Record<string, string>;
  /**
   * The path this file has been imported from.
   * Undefined if this file is the root file.
   */
  importedFromPath?: string;
  /**
   * An optional logger.
   */
  logger?: Logger;
  /**
   * If JSON-LD context validation should be skipped.
   */
  skipContextValidation?: boolean;
  /**
   * If remote context lookups are allowed.
   * If not allowed, an error is thrown if a remote lookup occurs.
   * If allowed, only a warning is emitted.
   */
  remoteContextLookups?: boolean;
  /**
   * If the specialized JSON-LD fast path must be disabled,
   * so that all documents are parsed with the generic parsing pipeline.
   */
  disableJsonLdFastPath?: boolean;
};
