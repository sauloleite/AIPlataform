/**
 * The client for the platform's canonical API.
 *
 * Two implementations of one interface: `AiaClient` over HTTP, and `FakeAia` in
 * memory. A consumer's tests take the fake and need no credential, no container
 * and no network -- which is the question this package's design has to answer,
 * not a convenience it happens to offer.
 */
export { AiaClient } from './client.js';
export { FakeAia, type FakeOptions } from './fake.js';
export { PlatformError } from './errors.js';
export type {
  Aia,
  AiaOptions,
  Approval,
  ChatEvent,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  ModelAlias,
  RoutingMetadata,
  Run,
  RunInput,
  SearchQuery,
  SearchResult,
  TokenSource,
  Usage,
} from './types.js';
