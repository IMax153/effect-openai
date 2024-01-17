CREATE TABLE IF NOT EXISTS "sqlfx_migrations" (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      );
CREATE TABLE document_chunks (
      id SERIAL PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      content TEXT NOT NULL,
      content_hash INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      embeddings TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
CREATE UNIQUE INDEX document_chunks_content_hash_idx
    ON
      document_chunks (content_hash);

INSERT INTO sqlfx_migrations VALUES(1,'2024-01-17 19:32:15','create_document_chunks');
INSERT INTO sqlfx_migrations VALUES(2,'2024-01-17 19:32:15','document_chunk_unique_index');