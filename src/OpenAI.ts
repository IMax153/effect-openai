import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Secret from "effect/Secret"
import * as Stream from "effect/Stream"
import { OpenAI as OpenAIApi } from "openai"

export class OpenAIError extends Data.TaggedError("OpenAIError")<{
  readonly error: unknown
}> {}

export interface OpenAIOptions {
  readonly apiKey: Secret.Secret
  readonly organization: Option.Option<Secret.Secret>
}

const handleError = (error: unknown) =>
  new OpenAIError({
    error: (error as any).response?.data?.error ?? error
  })

const make = (options: OpenAIOptions) =>
  Effect.gen(function*(_) {
    const client = yield* _(Effect.sync(() =>
      new OpenAIApi({
        apiKey: Secret.value(options.apiKey),
        organization: options.organization.pipe(
          Option.map(Secret.value),
          Option.getOrNull
        )
      })
    ))

    const call = <A>(f: (api: OpenAIApi, signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: (signal) => f(client, signal),
        catch: handleError
      }).pipe(Effect.withSpan("OpenAI.call"))

    const completion = (options: {
      readonly model: string
      readonly system: string
      readonly maxTokens: number
      readonly messages: ReadonlyArray<OpenAIApi.Chat.ChatCompletionMessageParam>
    }) =>
      call((_, signal) =>
        _.chat.completions.create(
          {
            model: options.model,
            temperature: 0.1,
            max_tokens: options.maxTokens,
            messages: [
              {
                role: "system",
                content: options.system
              },
              ...options.messages
            ],
            stream: true
          },
          { signal }
        )
      ).pipe(
        Effect.map((stream) => Stream.fromAsyncIterable(stream, handleError)),
        Stream.unwrap,
        Stream.filterMap((chunk) => Option.fromNullable(chunk.choices[0].delta.content))
      )

    return {
      client,
      call,
      completion
    }
  })

export interface OpenAI {
  readonly _: unique symbol
}

export const OpenAI = Context.Tag<OpenAI, ReturnType<typeof make>>()

export const makeLayer = (config: Config.Config.Wrap<OpenAIOptions>) =>
  Layer.effect(OpenAI, Effect.map(Config.unwrap(config), make))
