/**
 * AI client construction — supports both OpenAI direct and Azure OpenAI.
 *
 * Why two providers? `api.openai.com` is NOT covered by OpenAI's default
 * BAA scope, so production environments handling PHI must use Azure
 * OpenAI (HIPAA-eligible out of the box). Dev/staging can keep using
 * OpenAI direct for convenience.
 *
 * Provider is selected by `AI_INTEGRATIONS_PROVIDER` (defaults to
 * `openai`). When set to `azure`, this module constructs an
 * `AzureOpenAI` from the official SDK, which transparently rewrites the
 * URL/headers (api-key header, api-version query string,
 * deployment-name-in-URL) so the rest of the codebase keeps calling
 * `client.chat.completions.create(...)` unchanged.
 */
import type OpenAI from "openai";
import { buildOpenAIClient } from "./buildClient";

export const openai: OpenAI = buildOpenAIClient();
