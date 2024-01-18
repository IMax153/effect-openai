import * as Args from "@effect/cli/Args"
import * as Command from "@effect/cli/Command"
import * as Options from "@effect/cli/Options"
import * as Path from "@effect/platform-node/Path"
import * as Migrator from "@sqlfx/sqlite/Migrator/Node"
import * as SQLite from "@sqlfx/sqlite/node"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as NodePath from "node:path"
import * as Vss from "sqlite-vss"
import { fileURLToPath } from "url"
import * as Completions from "./Completions.js"
import * as DocumentChunker from "./DocumentChunker.js"
import * as DocumentChunkerRepo from "./DocumentChunkRepository.js"
import { AbsolutePath } from "./domain/AbsolutePath.js"
import { CompletionRequest } from "./domain/CompletionRequest.js"
import { Document } from "./domain/Document.js"
import { moduleVersion } from "./internal/version.js"

// TODO: fix
const __filename = fileURLToPath(import.meta.url)
const __dirname = NodePath.dirname(__filename)

// =============================================================================
// Command Environment
// =============================================================================

const SQLiteLive = (embeddings: AbsolutePath) =>
  SQLite.makeLayer({
    filename: Config.succeed(embeddings),
    transformQueryNames: Config.succeed(SQLite.transform.camelToSnake),
    transformResultNames: Config.succeed(SQLite.transform.snakeToCamel)
  })

const VSSLive = Layer.effectDiscard(Effect.gen(function*(_) {
  const sql = yield* _(SQLite.tag)
  yield* _(sql.loadExtension((Vss as any).getVectorLoadablePath()))
  yield* _(sql.loadExtension((Vss as any).getVssLoadablePath()))
}))

const MigratorLive = Migrator.makeLayer({
  // TODO: improve
  loader: Migrator.fromDisk(`${__dirname}/migrations`),
  schemaDirectory: "src/migrations"
})

const CommandEnvLive = (embeddings: AbsolutePath) =>
  Layer.mergeAll(
    Completions.CompletionsLive,
    DocumentChunker.DocumentChunkerLive,
    DocumentChunkerRepo.DocumentChunkRepositoryLive,
    MigratorLive
  ).pipe(
    Layer.provide(VSSLive),
    Layer.provide(SQLiteLive(embeddings))
  )

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

const promptCommand = Command.make("prompt", {
  prompt,
  embeddings: embeddingsDatabase.pipe(
    Options.withDescription(
      "The path to a SQLite database which contains document embeddings " +
        "generated using the `train` command"
    )
  )
}).pipe(
  Command.withHandler(({ prompt }) =>
    Effect.gen(function*(_) {
      const completions = yield* _(Completions.Completions)
      const repo = yield* _(DocumentChunkerRepo.DocumentChunkRepository)
      const chunks = yield* _(repo.search(prompt))
      completions.create(new CompletionRequest({/* TODO */}))
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
