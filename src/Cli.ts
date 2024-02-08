import * as Args from "@effect/cli/Args"
import * as Command from "@effect/cli/Command"
import * as Options from "@effect/cli/Options"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Path from "@effect/platform-node/Path"
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as Migrator from "@sqlfx/sqlite/Migrator/Node"
import * as SQLite from "@sqlfx/sqlite/node"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as NodePath from "node:path"
import * as Vss from "sqlite-vss"
import { fileURLToPath } from "url"
import * as Completions from "./Completions.js"
import * as DocumentChunker from "./DocumentChunker.js"
import { AbsolutePath } from "./domain/AbsolutePath.js"
import { CompletionModels, CompletionRequest } from "./domain/CompletionRequest.js"
import { Document } from "./domain/Document.js"
import { moduleVersion } from "./internal/version.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = NodePath.dirname(__filename)

// =============================================================================
// Command Environment
// =============================================================================

const VSSLive = Layer.effectDiscard(Effect.gen(function*(_) {
  const sql = yield* _(SQLite.tag)
  yield* _(sql.loadExtension((Vss as any).getVectorLoadablePath()))
  yield* _(sql.loadExtension((Vss as any).getVssLoadablePath()))
}))

const SQLiteLive = (embeddings: AbsolutePath) =>
  Layer.provideMerge(
    VSSLive,
    SQLite.makeLayer({
      filename: Config.succeed(embeddings),
      transformQueryNames: Config.succeed(SQLite.transform.camelToSnake),
      transformResultNames: Config.succeed(SQLite.transform.snakeToCamel)
    })
  )

const MigratorLive = Migrator.makeLayer({
  loader: Migrator.fromDisk(`${__dirname}/migrations`),
  schemaDirectory: "src/migrations"
})

const TelemetryLive = NodeSdk.layer(() => ({
  resource: { serviceName: "openai-effect" },
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
  metricReader: new PrometheusExporter()
}))

const CommandEnvLive = (embeddings: AbsolutePath) =>
  Layer.mergeAll(
    Completions.CompletionsLive,
    DocumentChunker.DocumentChunkerLive,
    MigratorLive,
    TelemetryLive
  ).pipe(Layer.provide(SQLiteLive(embeddings)))

// =============================================================================
// Common Options & Arguments
// =============================================================================

const embeddingsDatabase = Options.file("db").pipe(
  Options.mapEffect((databasePath) => resolvePath(databasePath)),
  Options.withSchema(AbsolutePath)
)

// =============================================================================
// Train Command
// =============================================================================

const documents = Args.fileText({ name: "document" }).pipe(
  Args.mapEffect(([documentPath, content]) =>
    Effect.all({
      path: resolvePath(documentPath),
      content: Effect.succeed(content)
    })
  ),
  Args.withDescription("A list of documents to use to generate text embeddings"),
  Args.withSchema(Document),
  Args.repeated
)

const trainCommand = Command.make("train", {
  documents,
  embeddings: embeddingsDatabase.pipe(
    Options.withDescription(
      "The path to a SQLite database which will be used to store the generated " +
        "document embeddings"
    )
  )
}).pipe(
  Command.withHandler(({ documents }) =>
    Effect.gen(function*(_) {
      const chunker = yield* _(DocumentChunker.DocumentChunker)
      yield* _(Effect.forEach(
        documents,
        (document) => chunker.chunkDocument(document),
        { concurrency: 20, discard: true }
      ))
    })
  ),
  Command.provide(({ embeddings }) => CommandEnvLive(embeddings))
)

// =============================================================================
// Prompt Command
// =============================================================================

const prompt = Args.text({ name: "prompt" }).pipe(
  Args.withDescription("The text prompt to send to OpenAI")
)

const model = Options.choice("model", CompletionModels).pipe(
  Options.withDefault("gpt-4-1106-preview"),
  Options.withDescription("The OpenAI model to use to generate the completion")
)

const promptCommand = Command.make("prompt", {
  prompt,
  model,
  embeddings: embeddingsDatabase.pipe(
    Options.withDescription(
      "The path to a SQLite database which contains document embeddings " +
        "generated using the `train` command"
    )
  )
}).pipe(
  Command.withHandler(({ model, prompt }) =>
    Effect.gen(function*(_) {
      const completions = yield* _(Completions.Completions)
      const stream = completions.create(
        new CompletionRequest({
          input: [{ role: "user", content: prompt }],
          model
        })
      )
      yield* _(
        stream,
        Stream.runForEach((output) => Effect.sync(() => process.stdout.write(output))),
        Effect.zipRight(Effect.sync(() => process.stdout.write("\n")))
      )
    })
  ),
  Command.provide(({ embeddings }) => CommandEnvLive(embeddings))
)

const command = Command.make("openai").pipe(Command.withSubcommands([
  trainCommand,
  promptCommand
]))

// =============================================================================
// CLI Application
// =============================================================================

export const run = Command.run(command, {
  name: "openai",
  version: moduleVersion
})

// =============================================================================
// Utilities
// =============================================================================

const resolvePath = (documentPath: string) =>
  Path.Path.pipe(Effect.map((path) => path.resolve(documentPath)))
