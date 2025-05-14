import {
  Pinecone, // Class for Pinecone client instances
  Index,    // Generic type for Index instances
  // IndexModel, // Removed due to runtime import error with CJS/ESM interop
  // PineconeRecord // Removed due to runtime import error with CJS/ESM interop
} from "@pinecone-database/pinecone";

import { createEmbedding } from "./openai.ts";
import { ensureServer } from "./env.ts";

export const RESPONSES_INDEX = "responses";
const EXPECTED_EMBEDDING_DIMENSION = 1536;

// --- Official Pinecone Metadata Types (based on SDK v6.0.0) ---
export type PineconeMetadataValue = string | boolean | number | string[];
export type BasePineconeMetadata = Record<string, PineconeMetadataValue>;

// --- Local PineconeRecord Interface ---
// Define a local interface for PineconeRecord as a workaround for CJS/ESM interop issues.
// This should match the structure of the SDK's PineconeRecord.
export interface LocalPineconeRecord<TMetadata extends BasePineconeMetadata = BasePineconeMetadata> {
  id: string;
  values: number[]; // Assuming embedding values are always number[]
  metadata?: TMetadata;
  sparseValues?: { // Added based on typical PineconeRecord structure
    indices: number[];
    values: number[];
  };
}

// --- Custom Metadata Interfaces ---

// Define specific known properties for StorableMetadata
interface StorableMetadataSpecificProps {
    type: string;
    name: string;
    originalText: string;
}
// StorableMetadata combines BasePineconeMetadata with its specific known string properties
export interface StorableMetadata extends BasePineconeMetadata, StorableMetadataSpecificProps {}


// Define specific known properties for FormSpecificMetadata
interface FormSpecificMetadataSpecificProps {
    type: string;
    name: string;
    originalText: string;
    form_id: string;
    response_id: string;
    respondent_name: string;
}
// FormSpecificMetadata combines BasePineconeMetadata with its specific known string properties
export interface FormSpecificMetadata extends BasePineconeMetadata, FormSpecificMetadataSpecificProps {}


// --- Pinecone Client Initialization ---
let _pineconeClient: Pinecone | null = null; // _pineconeClient is an instance of Pinecone

function getPineconeClient(): Pinecone { // This function returns an instance of Pinecone
  ensureServer("getPineconeClient");
  if (!_pineconeClient) {
    if (!process.env.PINECONE_API_KEY) {
      console.error("[getPineconeClient] PINECONE_API_KEY is not set.");
      throw new Error("PINECONE_API_KEY environment variable is not set");
    }
    _pineconeClient = new Pinecone({ // new Pinecone() creates an instance
      apiKey: process.env.PINECONE_API_KEY,
    });
    console.log("[getPineconeClient] Pinecone client initialized.");
  }
  return _pineconeClient;
}

// Local minimal interface for IndexModel due to import issues.
interface IndexModel {
  name: string;
  // Other properties like dimension, metric, status, spec could be added if used.
}

// --- Index Initialization and Management ---
export async function initializeIndex() {
  console.log(`[initializeIndex] Checking for Pinecone index: "${RESPONSES_INDEX}"`);
  const client = getPineconeClient();
  try {
    const { indexes } = await client.listIndexes();
    // Using the locally defined IndexModel interface
    const indexExists = indexes?.some((index: IndexModel) => index.name === RESPONSES_INDEX);

    if (!indexExists) {
      console.log(`[initializeIndex] Index "${RESPONSES_INDEX}" does not exist. Creating now...`);
      await client.createIndex({
        name: RESPONSES_INDEX,
        dimension: EXPECTED_EMBEDDING_DIMENSION,
        metric: 'cosine',
        spec: {
          serverless: { cloud: 'aws', region: 'us-east-1' }
        }
      });
      console.log(`[initializeIndex] Index "${RESPONSES_INDEX}" created. It may take moments to be ready.`);
    } else {
      console.log(`[initializeIndex] Index "${RESPONSES_INDEX}" already exists.`);
    }
  } catch (error) {
    console.error("[initializeIndex] Error initializing Pinecone index:", error);
    throw error;
  }
}

// getIndex returns an instance of the SDK's Index type, parameterized by TMetadata
const getIndex = <TMetadata extends BasePineconeMetadata = StorableMetadata>(): Index<TMetadata> =>
  getPineconeClient().Index<TMetadata>(RESPONSES_INDEX);

export async function clearPineconeIndex(indexName: string = RESPONSES_INDEX) {
  ensureServer("clearPineconeIndex");
  console.log(`[clearPineconeIndex] Clearing index: "${indexName}"`);
  try {
    const index = getPineconeClient().Index<BasePineconeMetadata>(indexName);
    await index.deleteAll();
    console.log(`[clearPineconeIndex] Successfully cleared index: "${indexName}".`);
  } catch (error) {
    console.error(`[clearPineconeIndex] Error clearing index "${indexName}":`, error);
    if (error instanceof Error && error.message.includes("not found")) {
        console.warn(`[clearPineconeIndex] Index "${indexName}" not found.`);
    } else {
        throw error;
    }
  }
}

// --- Embedding Storage ---
type InputStorableMetadata = {
    type: string;
    name: string;
} & Omit<BasePineconeMetadata, 'type' | 'name' | 'originalText'>;

export async function storeResponseEmbedding(
  text: string,
  metadata: InputStorableMetadata
) {
  console.log(`[storeResponseEmbedding] Storing embedding for ${metadata.type}: "${metadata.name}"`);
  if (!text || text.trim() === "") {
    console.warn(`[storeResponseEmbedding] Empty text for "${metadata.name}", skipping.`);
    return;
  }

  const index = getIndex<StorableMetadata>();
  let embedding: number[];

  try {
    embedding = await createEmbedding(text);
    if (embedding.length !== EXPECTED_EMBEDDING_DIMENSION) {
      throw new Error(`Embedding dimension mismatch for "${metadata.name}". Expected ${EXPECTED_EMBEDDING_DIMENSION}, got ${embedding.length}.`);
    }
  } catch (error) {
    console.error(`[storeResponseEmbedding] Failed to create embedding for "${metadata.name}":`, error);
    throw error;
  }

  const idSuffix = metadata.name.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase();
  const generatedId = `${metadata.type}-${idSuffix}`;

  const fullMetadata: StorableMetadata = {
    ...(metadata as BasePineconeMetadata),
    type: metadata.type,
    name: metadata.name,
    originalText: text.substring(0, 1000)
  };

  // Use the locally defined LocalPineconeRecord type
  const recordToUpsert: LocalPineconeRecord<StorableMetadata> = {
    id: generatedId,
    values: embedding,
    metadata: fullMetadata
  };

  try {
    // The upsert method expects an array of objects matching the SDK's record structure.
    // Our LocalPineconeRecord should be compatible.
    await index.upsert([recordToUpsert]);
    console.log(`[storeResponseEmbedding] Upserted ID "${generatedId}" for "${metadata.name}".`);
  } catch (error)
 {
    console.error(`[storeResponseEmbedding] Failed to upsert data for "${metadata.name}" (ID: "${generatedId}"):`, error);
    throw error;
  }
}

// --- Querying and Similarity ---
export type PineconeFilterValue = PineconeMetadataValue | { [key: string]: PineconeMetadataValue | PineconeMetadataValue[] | object };
export type PineconeQueryFilter = Record<string, PineconeFilterValue>;

interface InternalQueryOptions {
    vector: number[];
    id?: string;
    sparseValues?: { indices: number[]; values: number[]; };
    topK: number;
    filter?: PineconeQueryFilter;
    includeMetadata?: boolean;
    includeValues?: boolean;
    namespace?: string;
}

// PineconeMatch now extends the locally defined LocalPineconeRecord type
export interface PineconeMatch<TMetadata extends BasePineconeMetadata = StorableMetadata> extends LocalPineconeRecord<TMetadata> {
  score?: number;
}

export async function findSimilarResponses<TMetadata extends BasePineconeMetadata = StorableMetadata>(
  queryText: string,
  limit: number = 5,
  filter?: PineconeQueryFilter
): Promise<PineconeMatch<TMetadata>[]> {
  console.log(`[findSimilarResponses] Searching for query: "${queryText.substring(0, 60)}...", topK: ${limit}`);
  if (filter) console.log(`[findSimilarResponses]   Applying filter: ${JSON.stringify(filter)}`);

  if (!queryText || queryText.trim() === "") {
    console.warn("[findSimilarResponses] Empty query text. Returning empty array.");
    return [];
  }

  const index = getIndex<TMetadata>();
  let queryEmbedding: number[];

  try {
    queryEmbedding = await createEmbedding(queryText);
    if (queryEmbedding.length !== EXPECTED_EMBEDDING_DIMENSION) {
        throw new Error(`Query embedding dimension mismatch! Expected ${EXPECTED_EMBEDDING_DIMENSION}, got ${queryEmbedding.length}.`);
    }
  } catch (error) {
    console.error("[findSimilarResponses] Failed to create embedding for query:", error);
    throw error;
  }

  try {
    const queryOptions: InternalQueryOptions = {
      vector: queryEmbedding,
      topK: limit,
      includeMetadata: true,
      includeValues: false,
    };

    if (filter) {
      queryOptions.filter = filter;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await index.query(queryOptions as any);

    // The matches from the SDK query should be compatible with LocalPineconeRecord structure
    return (results.matches as PineconeMatch<TMetadata>[]) || [];
  } catch (error) {
    console.error("[findSimilarResponses] Failed to query Pinecone:", error);
    throw error;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same length for cosine similarity.");
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

export async function getSimilarity(pointId1: string, pointId2: string): Promise<number> {
  ensureServer("getSimilarity");
  console.log(`[getSimilarity] Calculating similarity between: "${pointId1}" and "${pointId2}"`);
  try {
    const index = getIndex<BasePineconeMetadata>();
    const fetchResult = await index.fetch([pointId1, pointId2]);

    const record1 = fetchResult.records?.[pointId1]; // This will be of the SDK's internal record type
    const record2 = fetchResult.records?.[pointId2];

    // Ensure values exist on the fetched records
    const vector1 = record1?.values;
    const vector2 = record2?.values;

    if (!vector1 || !vector2) {
      const missing = !vector1 ? pointId1 : pointId2;
      throw new Error(`Failed to retrieve vector for point: ${missing}`);
    }
    return cosineSimilarity(vector1, vector2);
  } catch (error) {
    console.error(`[getSimilarity] Error for "${pointId1}" vs "${pointId2}":`, error);
    throw error;
  }
}

interface Connection {
  response1Id: string;
  response2Id: string;
  response1Name: string;
  response2Name: string;
  similarityScore: number;
}

export async function generateFormConnections(formId: string): Promise<Connection[]> {
  ensureServer("generateFormConnections");
  const namespace = 'ns1';
  console.log(`[generateFormConnections] Generating for formId: "${formId}" in namespace "${namespace}"`);
  try {
    const index = getIndex<FormSpecificMetadata>();

    const queryOptions: InternalQueryOptions = {
      vector: new Array(EXPECTED_EMBEDDING_DIMENSION).fill(0),
      topK: 100,
      includeMetadata: true,
      includeValues: true,
      filter: { form_id: { $eq: formId } } as PineconeQueryFilter,
      namespace: namespace,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await index.query(queryOptions as any);
    const points: PineconeMatch<FormSpecificMetadata>[] = (result.matches as PineconeMatch<FormSpecificMetadata>[]) || [];
    console.log(`[generateFormConnections] Found ${points.length} points.`);
    const connections: Connection[] = [];

    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const p1 = points[i];
        const p2 = points[j];

        if (!p1.metadata || !p2.metadata || !p1.values || !p2.values) {
          console.warn(`[generateFormConnections] Skipping pair due to missing data: ${p1.id}, ${p2.id}`);
          continue;
        }
        connections.push({
          response1Id: p1.metadata.response_id,
          response2Id: p2.metadata.response_id,
          response1Name: p1.metadata.respondent_name,
          response2Name: p2.metadata.respondent_name,
          similarityScore: cosineSimilarity(p1.values, p2.values),
        });
      }
    }
    console.log(`[generateFormConnections] Generated ${connections.length} connections.`);
    return connections.sort((a, b) => b.similarityScore - a.similarityScore);
  } catch (error) {
    console.error(`[generateFormConnections] Error for formId "${formId}":`, error);
    throw error;
  }
}