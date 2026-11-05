-- Instance-owned MCP servers and prompts: written by an admin once, offered to
-- every account. They live beside the per-user tables rather than inside them
-- with an empty owner, so an owner-scoped query cannot reach one.

CREATE TABLE IF NOT EXISTS "shared_prompt" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "description" VARCHAR(100) NOT NULL,
    "argumentHint" VARCHAR(100),
    "scope" TEXT NOT NULL DEFAULT 'any',
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_prompt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "shared_mcp_server" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "encryptedToken" TEXT,
    "toolPolicy" TEXT NOT NULL DEFAULT 'ask',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "chatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "coderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_mcp_server_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "shared_prompt_name_key" ON "shared_prompt"("name");

CREATE UNIQUE INDEX IF NOT EXISTS "shared_mcp_server_name_key" ON "shared_mcp_server"("name");
