import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"

export const RateLimiterTypeId = Symbol.for("@effect/openai/RateLimiter")

export type RateLimiterTypeId = typeof RateLimiterTypeId

export interface RateLimiter extends RateLimiter.Proto {
  readonly take: Effect.Effect<never, never, void>
}

export declare namespace RateLimiter {
  export interface Proto {
    readonly [RateLimiterTypeId]: RateLimiterTypeId
  }
}

const rateLimiterProto = {
  [RateLimiterTypeId]: RateLimiterTypeId
}

export const make = (
  limit: number,
  window: Duration.DurationInput
): Effect.Effect<Scope.Scope, never, RateLimiter> =>
  Effect.gen(function*(_) {
    const counter = yield* _(Ref.make(limit))
    const scope = yield* _(Effect.scope)

    const queue = yield* _(Effect.acquireRelease(
      Queue.unbounded<Deferred.Deferred<never, void>>(),
      (queue) => Queue.shutdown(queue)
    ))

    const reset = Effect.delay(Ref.set(counter, limit), window)
    const resetRef = yield* _(Ref.make(Option.none<Fiber.RuntimeFiber<never, void>>()))
    const maybeReset = Ref.get(resetRef).pipe(
      Effect.tap(Option.match({
        onNone: () =>
          reset.pipe(
            Effect.zipRight(Ref.set(resetRef, Option.none())),
            Effect.forkIn(scope),
            Effect.flatMap((fiber) => Ref.set(resetRef, Option.some(fiber)))
          ),
        onSome: () => Effect.unit
      }))
    )

    const worker = Ref.get(counter).pipe(
      Effect.flatMap((count) => {
        if (count <= 0) {
          return Ref.get(resetRef).pipe(
            Effect.map(Option.match({
              onNone: () => Effect.unit,
              onSome: (fiber) => Fiber.await(fiber)
            })),
            Effect.zipRight(Queue.takeBetween(queue, 1, limit))
          )
        }
        return Queue.takeBetween(queue, 1, count)
      }),
      Effect.flatMap(Effect.filter(Deferred.isDone, { negate: true })),
      Effect.tap((chunk) => Ref.update(counter, (count) => count - chunk.length)),
      Effect.zipLeft(maybeReset),
      Effect.flatMap(Effect.forEach(
        (deferred) => Deferred.complete(deferred, Effect.unit),
        { discard: true }
      )),
      Effect.forever
    )

    yield* _(Effect.forkIn(worker, scope))

    return {
      [RateLimiterTypeId]: RateLimiterTypeId,
      take: Deferred.make<never, void>().pipe(
        Effect.tap((deferred) => Queue.offer(queue, deferred)),
        Effect.flatMap((deferred) =>
          Deferred.await(deferred).pipe(
            Effect.onInterrupt(() => Deferred.interrupt(deferred))
          )
        )
      )
    }
  })
