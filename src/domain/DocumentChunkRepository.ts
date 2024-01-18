import * as ExperimentalRequestResolver from "@effect/experimental/RequestResolver"
import { TreeFormatter } from "@effect/schema"
import * as Schema from "@effect/schema/Schema"
import * as SQLite from "@sqlfx/sqlite/Client"
import type * as SqlError from "@sqlfx/sqlite/Error"
import { Inspectable } from "effect"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as DocumentChunk from "../domain/DocumentChunk.js"
import type * as OpenAI from "../OpenAI.js"
import * as Embedding from "./Embedding.js"

export class DocumentChunkRepositoryError extends Data.TaggedError("DocumentChunkRepositoryError")<{
  readonly method: string
  readonly error:
    | SqlError.SqlError
    | SqlError.SchemaError
    | OpenAI.OpenAIError
    | SqlError.ResultLengthMismatch
}> {
  get message() {
    const message = this.error._tag === "SchemaError"
      ? TreeFormatter.formatIssue(this.error.error)
      : "message" in this.error
      ? this.error.message
      : Inspectable.format(this.error)
    return `${this.method} failed: ${message}`
  }
}

export const DocumentChunkForInsert = DocumentChunk.DocumentChunk.struct.pipe(
  Schema.omit("id", "createdAt", "updatedAt")
)
export type ChunkForInsert = Schema.Schema.To<typeof DocumentChunkForInsert>

const make = Effect.gen(function*(_) {
  const embedding = yield* _(Embedding.Embedding)
  const sql = yield* _(SQLite.tag)

  const getEmbeddings = flow(
    sql.singleSchemaOption(
      Schema.number,
      Embedding.FromSql,
      (id) =>
        sql<{ embedding: Uint8Array }>`SELECT rowid, embedding FROM vss_chunks WHERE rowid = ${id}`
          .pipe(
            Effect.map((_) => _.map(({ embedding }) => embedding))
          )
    ),
    Effect.withSpan("DocumentChunkRepository.setEmbeddings")
  )

  const setEmbeddings = flow(
    sql.voidSchema(
      Schema.struct({
        id: Schema.number,
        embeddings: Embedding.FromSql
      }),
      ({ embeddings, id }) =>
        sql`INSERT INTO vss_chunks(rowid, embedding)
          VALUES (${id}, ${embeddings})`
    ),
    Effect.withSpan("DocumentChunkRepository.setEmbeddings")
  )

  const Upsert = sql.resolver("UpsertDocumentChunk", {
    request: DocumentChunkForInsert,
    result: DocumentChunk.DocumentChunk,
    run: (chunk) =>
      sql`INSERT INTO document_chunks ${sql.insert(chunk)}
          ON CONFLICT (content_hash) DO UPDATE
          SET content_hash = EXCLUDED.content_hash
          RETURNING *`
  })

  const upsertResolver = yield* _(ExperimentalRequestResolver.dataLoader(
    Upsert.Resolver,
    { window: "500 millis" }
  ))

  const upsertDebounced = Upsert.makeExecute(upsertResolver)

  const upsert = (chunk: ChunkForInsert) =>
    upsertDebounced(chunk).pipe(
      Effect.bindTo("chunk"),
      Effect.bind("embeddings", ({ chunk }) => getEmbeddings(chunk.id)),
      Effect.flatMap(({ chunk, embeddings }) =>
        Option.match(embeddings, {
          onNone: () =>
            Effect.log("Generating embeddings").pipe(
              Effect.zipRight(embedding.batched(chunk.fullContent)),
              Effect.flatMap((embeddings) => setEmbeddings({ id: chunk.id, embeddings })),
              Effect.as(chunk),
              Effect.annotateLogs("chunkId", chunk.id.toString())
            ),
          onSome: (_) => Effect.succeed(chunk)
        })
      ),
      Effect.mapError((error) => new DocumentChunkRepositoryError({ method: "upsert", error })),
      Effect.withSpan("DocumentChunkRepository.upsert", {
        attributes: {
          path: chunk.path,
          title: Option.getOrElse(chunk.title, () => "")
        }
      })
    )

  const removeExtraneous = (hashes: ReadonlyArray<number>) =>
    sql`
      DELETE FROM document_chunks
      WHERE content_hash NOT IN ${sql(hashes)}
    `.pipe(
      Effect.mapError(
        (error) => new DocumentChunkRepositoryError({ method: "removeExtranous", error })
      ),
      Effect.asUnit,
      Effect.withSpan("DocumentChunkRepository.removeExtraneous")
    )

  const searchByEmbedding = flow(
    sql.schema(
      Schema.struct({
        embedding: Embedding.FromSql,
        limit: Schema.optional(Schema.number)
      }),
      DocumentChunk.DocumentChunk,
      ({ embedding, limit = 35 }) =>
        sql`
        with matches as (
          select rowid, distance
          from vss_chunks
          where vss_search(embedding, ${embedding})
          order by distance
          limit ${limit}
        )
        select document_chunks.*
        from matches
        left join document_chunks on document_chunks.id = matches.rowid
      `
    ),
    Effect.withSpan("DocumentChunkRepository.searchByEmbedding")
  )

  const search = (query: string, limit?: number) =>
    embedding.single(query).pipe(
      Effect.flatMap((embedding) => searchByEmbedding({ embedding, limit })),
      Effect.withSpan("DocumentChunkRepository.search", {
        attributes: {
          query,
          limit
        }
      })
    )

  return {
    removeExtraneous,
    getEmbeddings,
    setEmbeddings,
    upsert,
    search
  } as const
})

export interface DocumentChunkRepository {
  readonly _: unique symbol
}

export const DocumentChunkRepository = Context.Tag<
  DocumentChunkRepository,
  Effect.Effect.Success<typeof make>
>()

export const DocumentChunkRepositoryLive = Layer.provide(
  Layer.scoped(DocumentChunkRepository, make),
  Embedding.EmbeddingLive
)
