import * as ExperimentalRequestResolver from "@effect/experimental/RequestResolver"
import * as ParseResult from "@effect/schema/ParseResult"
import * as Schema from "@effect/schema/Schema"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Request from "effect/Request"
import * as RequestResolver from "effect/RequestResolver"
import * as Schedule from "effect/Schedule"
import * as OpenAI from "../OpenAI.js"

export const Embeddings = Schema.array(Schema.number)

const parseEmbeddings = Schema.parse(Embeddings)

export const FromSql = Schema.transformOrFail(
  Schema.string,
  Schema.array(Schema.number),
  (sql) =>
    Effect.try({
      try: () => JSON.parse(sql),
      catch: () =>
        ParseResult.parseError(
          ParseResult.type(
            Schema.string.ast,
            sql,
            "Could not parse embedding"
          )
        )
    }).pipe(Effect.flatMap(parseEmbeddings)),
  (_) => ParseResult.succeed(JSON.stringify(_))
)

const retryPolicy = Schedule.fixed(Duration.millis(100)).pipe(
  Schedule.compose(Schedule.recurs(3))
)

const make = Effect.gen(function*(_) {
  const openai = yield* _(OpenAI.OpenAI)
  const cache = yield* _(Request.makeCache({ capacity: 5000, timeToLive: "1 days" }))

  interface EmbeddingRequest extends Request.Request<OpenAI.OpenAIError, ReadonlyArray<number>> {
    readonly _tag: "EmbeddingRequest"
    readonly input: string
  }
  const EmbeddingRequest = Request.tagged<EmbeddingRequest>("EmbeddingRequest")

  const createEmbedding = (input: ReadonlyArray<EmbeddingRequest>) =>
    openai.call((_) =>
      _.embeddings.create({
        model: "text-embedding-ada-002",
        input: input.map((request) => request.input)
      })
    ).pipe(
      Effect.map((response) => response.data),
      Effect.retry(retryPolicy),
      Effect.withSpan("Embeddings.createEmbedding")
    )

  const resolver = RequestResolver.makeBatched(
    (requests: Array<EmbeddingRequest>) =>
      createEmbedding(requests).pipe(
        Effect.flatMap((results) =>
          Effect.forEach(
            results,
            ({ embedding, index }) => Request.succeed(requests[index], embedding),
            { discard: true }
          )
        ),
        Effect.catchAll((error) =>
          Effect.forEach(requests, (request) => Request.fail(request, error), {
            discard: true
          })
        )
      )
  )

  const resolverDelayed = yield* _(ExperimentalRequestResolver.dataLoader(
    resolver,
    { window: Duration.millis(500) }
  ))

  const single = (input: string) =>
    Effect.request(EmbeddingRequest({ input }), resolver).pipe(
      Effect.withRequestCache(cache),
      Effect.withRequestCaching(true),
      Effect.withSpan("Embeddings.single")
    )

  const batched = (input: string) =>
    Effect.request(EmbeddingRequest({ input }), resolverDelayed).pipe(
      Effect.withSpan("Embeddings.batched")
    )

  return { single, batched } as const
})

export interface Embedding {
  readonly _: unique symbol
}

export const Embedding = Context.Tag<Embedding, Effect.Effect.Success<typeof make>>()

export const EmbeddingLive = Layer.scoped(Embedding, make)
