import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as ReadonlyArray from "effect/ReadonlyArray"
import * as String from "effect/String"
import TikToken from "tiktoken-node"
import * as DocumentChunkRepository from "./DocumentChunkRepository.js"
import type * as DocumentChunk from "./domain/DocumentChunk.js"

const tokenizer = TikToken.encodingForModel("gpt-3.5-turbo")

const defaultPrefix =
  `You are a very enthusiastic representative for the Effect libraries, who loves to help people!

Answer any questions in Markdown format, from the following documentation sections:
---`

export interface GenerateOptions {
  readonly prompt: string
  readonly targetTokens: number
  readonly maxTokens: number
  readonly prefix?: string
}

export class ContextTooLargeError extends Data.TaggedError("ContextTooLargeError")<{
  readonly requiredTokenCount: number
  readonly maxTokenCount: number
  readonly tokensToGenerate: number
}> {}

const make = Effect.gen(function*(_) {
  const repository = yield* _(DocumentChunkRepository.DocumentChunkRepository)

  const generate = ({
    maxTokens,
    prefix = defaultPrefix,
    prompt,
    targetTokens
  }: GenerateOptions) => {
    const requiredTokenCount = tokenizer.encode(`${prefix}\n\n${prompt}`).length
    const diffOrZero = Math.max(0, maxTokens - targetTokens)
    const tokensToGenerate = targetTokens - diffOrZero
    return repository.search(prompt).pipe(
      Effect.map((results) => {
        let tokens = 0
        const chunks: Array<DocumentChunk.DocumentChunk> = []

        for (const result of results) {
          const tokenCount = result.tokenCount

          if (tokens + tokenCount > tokensToGenerate) {
            break
          }

          tokens += tokenCount
          chunks.push(result)
        }

        const chunkContent = pipe(
          ReadonlyArray.map(chunks, (chunk) => String.trim(chunk.fullContent)),
          ReadonlyArray.join("\n\n--\n\n")
        )

        return {
          chunks,
          content: `${prefix}\n\n${chunkContent}`
        }
      }),
      Effect.filterOrFail(
        () => tokensToGenerate >= 1000,
        () =>
          new ContextTooLargeError({
            requiredTokenCount,
            maxTokenCount: maxTokens,
            tokensToGenerate
          })
      ),
      Effect.withSpan("AiContext.generate", { attributes: { prompt } })
    )
  }

  return { generate } as const
})

export interface AIContext {
  readonly _: unique symbol
}

export const AIContext = Context.Tag<AIContext, Effect.Effect.Success<typeof make>>()

export const AIContextLive = Layer.effect(AIContext, make).pipe(
  Layer.provide(DocumentChunkRepository.DocumentChunkRepositoryLive)
)
