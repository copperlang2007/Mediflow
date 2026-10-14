-- Sign-in identities (ADR 0006): which Google Identity Platform account signs
-- in as which agencyBRIDGE user. users.id is never rewritten; a user created
-- under Clerk keeps its id and is reached through this mapping.
CREATE TABLE IF NOT EXISTS "user_identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"linked_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY ("provider","subject"),
	CONSTRAINT "user_identities_provider_user_key" UNIQUE ("provider","user_id")
);
