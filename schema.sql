-- Activar extensión pgvector
create extension if not exists vector;

-- ─────────────────────────────────────────
-- Tabla: documentos
-- ─────────────────────────────────────────
create table if not exists documentos (
    id              bigint primary key generated always as identity,
    nombre          text not null,
    drive_file_id   text not null unique,
    drive_url       text not null,
    total_paginas   int,
    created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- Tabla: chunks
-- ─────────────────────────────────────────
create table if not exists chunks (
    id            bigint primary key generated always as identity,
    documento_id  bigint not null references documentos(id) on delete cascade,
    contenido     text not null,
    pagina        int not null,
    chunk_index   int not null,
    embedding     vector(768),
    created_at    timestamptz not null default now()
);

-- Índice ivfflat para búsqueda por similitud coseno
create index if not exists chunks_embedding_idx
    on chunks using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

-- ─────────────────────────────────────────
-- Función: buscar_chunks
-- ─────────────────────────────────────────
create or replace function buscar_chunks(
    query_embedding    vector(768),
    match_count        int     default 10,
    similarity_threshold float  default 0.3
)
returns table (
    chunk_id         bigint,
    documento_id     bigint,
    nombre_documento text,
    drive_url        text,
    contenido        text,
    pagina           int,
    similarity       float
)
language sql stable
as $$
    select
        c.id                          as chunk_id,
        c.documento_id,
        d.nombre                      as nombre_documento,
        d.drive_url,
        c.contenido,
        c.pagina,
        1 - (c.embedding <=> query_embedding) as similarity
    from chunks c
    join documentos d on d.id = c.documento_id
    where 1 - (c.embedding <=> query_embedding) >= similarity_threshold
    order by c.embedding <=> query_embedding
    limit match_count;
$$;

-- ─────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────
alter table documentos enable row level security;
alter table chunks      enable row level security;

-- Lectura pública para documentos
create policy "Lectura pública documentos"
    on documentos for select
    using (true);

-- Lectura pública para chunks
create policy "Lectura pública chunks"
    on chunks for select
    using (true);
