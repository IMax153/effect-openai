import * as SQLite from "@sqlfx/sqlite/Client"
import * as Effect from "effect/Effect"

export default Effect.flatMap(SQLite.tag, (sql) =>
  sql`CREATE VIRTUAL TABLE vss_chunks USING vss0(
    embedding(1356) factory="IVF4096,Flat,IDMap2"
  )`)
