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
    anio_inicio     smallint,
    anio_fin        smallint,
    created_at      timestamptz not null default now()
);

-- Columnas de período (para instancias existentes sin estas columnas)
alter table documentos add column if not exists anio_inicio smallint;
alter table documentos add column if not exists anio_fin    smallint;

-- Índice para filtrado por período
create index if not exists idx_documentos_periodo
    on documentos (anio_inicio, anio_fin);

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
-- Tabla: personas
-- ─────────────────────────────────────────
create table if not exists personas (
    id      uuid primary key default gen_random_uuid(),
    nombre  text not null unique,
    rol     text,
    periodo text
);

-- ─────────────────────────────────────────
-- Tabla: relaciones
-- ─────────────────────────────────────────
create table if not exists relaciones (
    id        uuid primary key default gen_random_uuid(),
    persona_a uuid not null references personas(id) on delete cascade,
    persona_b uuid not null references personas(id) on delete cascade,
    tipo      text,
    chunk_id  bigint references chunks(id) on delete set null,
    unique (persona_a, persona_b, chunk_id)
);

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
-- Función: buscar_chunks_periodo
-- ─────────────────────────────────────────
create or replace function buscar_chunks_periodo(
    query_embedding      vector(768),
    anio_ini             int,
    anio_fin             int,
    match_count          int     default 10,
    similarity_threshold float   default 0.25
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
      and d.anio_inicio <= anio_fin
      and d.anio_fin    >= anio_ini
    order by c.embedding <=> query_embedding
    limit match_count;
$$;

-- ─────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────
alter table documentos enable row level security;
alter table chunks      enable row level security;
alter table personas    enable row level security;
alter table relaciones  enable row level security;

-- Lectura pública para documentos
create policy "Lectura pública documentos"
    on documentos for select
    using (true);

-- Lectura pública para chunks
create policy "Lectura pública chunks"
    on chunks for select
    using (true);

-- Lectura pública para personas
create policy "Lectura pública personas"
    on personas for select
    using (true);

-- Lectura pública para relaciones
create policy "Lectura pública relaciones"
    on relaciones for select
    using (true);
