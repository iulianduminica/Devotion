/**
 * The local AI layer.
 *
 *   providers  adapter interface, presets, registry, OpenAI-compatible client
 *   actions    summarize / translate / fixGrammar / changeTone / autofill / askWorkspace
 *   prompts    the templates the actions send
 *   json       digging JSON out of a chatty model
 *
 * Nothing here reaches the internet by default: the presets are the Strata
 * bridge, Ollama and LM Studio on loopback.
 */

export * from "./providers.ts";
export * from "./actions.ts";
export * from "./prompts.ts";
export * from "./json.ts";
